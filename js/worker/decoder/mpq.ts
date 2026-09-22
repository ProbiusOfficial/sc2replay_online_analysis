/**
 * MPQ（MoPaQ）归档读取器 —— SC2Replay 的容器格式。
 *
 * 为什么不复用现成 npm 包：
 *   `s2protocol`（TS 移植）的 tarball 里没有 `dist/`，其依赖 `mpyqjs2` 未验证浏览器可用性。
 *   我们实际只需要一个很小的子集：读 user data header + hash/block table + 解压若干文件。
 *   本实现与 Python 的 `mpyq` 0.2.5 行为**逐字段对齐**（对照测试见 `scripts/compare-parsers.mjs`）。
 *
 * 实测 5 个样本录像的结构完全一致：
 *
 * ```
 * offset 0     MPQ user data header（magic `MPQ\x1b`，16 字节）
 *              └─ mpqHeaderOffset 指向下面这个
 * offset 1024  MPQ header（magic `MPQ\x1a`，32 字节；format_version = 3，sector_size_shift = 5）
 * hash table   header.hashTableOffset + header.offset，每条 16 字节，整表加密
 * block table  header.blockTableOffset + header.offset，每条 16 字节，整表加密
 * ```
 *
 * ⚠️ **`replay.header` 不在 MPQ 内**（不在 `(listfile)` 里）。它是 user data header 的
 * `content` 字节，由协议解码器直接解析。入口是 {@link MpqArchive.readHeaderContent}。
 *
 * 解压统一走 `DecompressionStream("deflate")` —— 它在浏览器与 Node 18+ 都原生存在，
 * 因此同一份代码可以在 Worker 里跑、也可以在 Node 里做单测，不需要引入构建期依赖。
 */
// 该常量引用仅为语义说明保留；实际按下面的常量表使用。
// MPQ_FILE_IMPLODE 目前不单独分支处理（implode 流由解压层报错）。

const MPQ_FILE_COMPRESS = 0x00000200;
const MPQ_FILE_ENCRYPTED = 0x00010000;
const MPQ_FILE_SINGLE_UNIT = 0x01000000;
const MPQ_FILE_SECTOR_CRC = 0x04000000;
const MPQ_FILE_EXISTS = 0x80000000;

const MAGIC_MPQ_HEADER = 0x1a; // "MPQ\x1a"
const MAGIC_MPQ_USER_DATA = 0x1b; // "MPQ\x1b"

/** 单字节压缩类型标记（位于压缩块首字节）。 */
const COMPRESSION_NONE = 0x00;
const COMPRESSION_ZLIB = 0x02;
const COMPRESSION_BZIP2 = 0x10;

export type MpqErrorCode =
  | "BAD_MAGIC"
  | "TRUNCATED"
  | "UNSUPPORTED_COMPRESSION"
  | "ENCRYPTED_NOT_SUPPORTED"
  | "DECOMPRESS_FAILED";

export class MpqError extends Error {
  readonly code: MpqErrorCode;

  constructor(code: MpqErrorCode, message: string) {
    super(message);
    this.name = "MpqError";
    this.code = code;
  }
}

// ---------------------------------------------------------------- 加密表

/**
 * MPQ 的加密表（256 组 × 5 项，共 0x500 项）。
 * 哈希用低 0x400 项，解密用 0x400 起的 0x100 项。
 * 生成方式与 `mpyq._prepare_encryption_table` 一致。
 */
const ENCRYPTION_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(0x500);
  let seed = 0x00100001;
  for (let i = 0; i < 256; i += 1) {
    let index = i;
    for (let j = 0; j < 5; j += 1) {
      seed = (seed * 125 + 3) % 0x2aaaab;
      const temp1 = (seed & 0xffff) << 0x10;
      seed = (seed * 125 + 3) % 0x2aaaab;
      const temp2 = seed & 0xffff;
      table[index] = (temp1 | temp2) >>> 0;
      index += 0x100;
    }
  }
  return table;
})();

// ---------------------------------------------------------------- 哈希与解密

type HashType = "TABLE_OFFSET" | "HASH_A" | "HASH_B" | "TABLE";

const HASH_TYPE_INDEX: Record<HashType, number> = {
  TABLE_OFFSET: 0,
  HASH_A: 1,
  HASH_B: 2,
  TABLE: 3,
};

/**
 * MPQ 字符串哈希。
 *
 * 语义要点：哈希逐**字节**进行（Python 侧传的是 `bytes`，`bytes.upper()` 只改 ASCII），
 * 所以这里先 UTF-8 编码，再手工做 ASCII 大写。**不能**用 `String.prototype.toUpperCase()`，
 * 它会把非 ASCII 字符也改写，与 mpyq 不一致。
 *
 * 所有中间量都收敛到无符号 32 位（`>>> 0`），与 Python 的 `& 0xFFFFFFFF` 对应。
 */
export function hashFileName(name: string, type: HashType): number {
  const bytes = new TextEncoder().encode(name);
  const base = HASH_TYPE_INDEX[type] << 8;
  let seed1 = 0x7fed7fed;
  let seed2 = 0xeeeeeeee;

  for (const raw of bytes) {
    const ch = raw >= 0x61 && raw <= 0x7a ? raw - 0x20 : raw;
    const value = ENCRYPTION_TABLE[base + ch];
    seed1 = (value ^ (seed1 + seed2)) >>> 0;
    seed2 = (ch + seed1 + seed2 + (seed2 << 5) + 3) >>> 0;
  }
  return seed1;
}

/** 原地解密一段 32 位小端序列（hash table / block table / 被加密的 sector）。 */
function decryptUint32Block(data: Uint8Array, key: number): Uint8Array {
  const out = new Uint8Array(data.length);
  const inView = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const outView = new DataView(out.buffer, out.byteOffset, out.byteLength);

  let seed1 = key >>> 0;
  let seed2 = 0xeeeeeeee;
  const count = Math.floor(data.length / 4);

  for (let i = 0; i < count; i += 1) {
    seed2 = (seed2 + ENCRYPTION_TABLE[0x400 + (seed1 & 0xff)]) >>> 0;
    let value = inView.getUint32(i * 4, true);
    value = (value ^ (seed1 + seed2)) >>> 0;
    outView.setUint32(i * 4, value, true);
    seed1 = (((~seed1 << 0x15) + 0x11111111) | (seed1 >>> 0x0b)) >>> 0;
    seed2 = (value + seed2 + (seed2 << 5) + 3) >>> 0;
  }

  // 尾部不足 4 字节的部分原样保留（表长度总是 4 的倍数，这里只是防御）。
  if (count * 4 < data.length) out.set(data.subarray(count * 4));
  return out;
}

// ---------------------------------------------------------------- 解压

async function inflate(compressed: Uint8Array, hint: string): Promise<Uint8Array> {
  try {
    const stream = new Blob([compressed as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream("deflate"));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  } catch (cause) {
    throw new MpqError(
      "DECOMPRESS_FAILED",
      `deflate 解压失败（${hint}）：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/**
 * 解压后端。MPQ 层**不内置** bzip2 —— 浏览器没有原生实现，实现放在 wasm 侧
 * （`wasm/src/lib.rs` 的 `bzip2_decompress`），由调用方注入。
 * 这样 `mpq.ts` 保持零依赖，Node 单测与 Worker 可以各自装配。
 */
export interface MpqDecompressor {
  /** 解一段 bzip2 流（**不含**首字节的压缩类型标记）。 */
  bzip2(data: Uint8Array): Promise<Uint8Array>;
}

export interface MpqOpenOptions {
  decompressor?: MpqDecompressor;
}

/**
 * 解压一个压缩块：首字节是压缩类型标记，其余是数据。
 *
 * 与 mpyq 一致：类型 0 表示**未压缩**，此时返回含首字节的完整原始数据。
 *
 * 实测：SC2 录像的数据流是 **bzip2**（5 个样本共 53 个块全部为 bzip2），
 * zlib 分支属于兼容性保留，样本中未出现。
 */
async function decompressBlock(
  data: Uint8Array,
  hint: string,
  decompressor?: MpqDecompressor,
): Promise<Uint8Array> {
  if (data.length === 0) return data;
  const compressionType = data[0];
  if (compressionType === COMPRESSION_NONE) return data;
  if (compressionType === COMPRESSION_ZLIB) return inflate(data.subarray(1), hint);
  if (compressionType === COMPRESSION_BZIP2) {
    if (!decompressor) {
      throw new MpqError(
        "UNSUPPORTED_COMPRESSION",
        `遇到 bzip2 块（${hint}）但未注入解压后端。浏览器无原生 bzip2，` +
          `请用 openMpqArchive(source, { decompressor }) 注入 wasm 侧实现。`,
      );
    }
    return decompressor.bzip2(data.subarray(1));
  }
  throw new MpqError(
    "UNSUPPORTED_COMPRESSION",
    `不支持的压缩类型 ${compressionType}（${hint}）`,
  );
}

// ---------------------------------------------------------------- 类型

export interface MpqHeader {
  magic: string;
  headerSize: number;
  archiveSize: number;
  formatVersion: number;
  sectorSizeShift: number;
  hashTableOffset: number;
  blockTableOffset: number;
  hashTableEntries: number;
  blockTableEntries: number;
  /** MPQ header 在文件中的绝对偏移（来自 user data header；无 user data header 时为 0）。 */
  offset: number;
  /** 仅 `formatVersion === 1` 时存在。实测样本为 3，不带扩展头。 */
  extended?: {
    extendedBlockTableOffset: bigint;
    hashTableOffsetHigh: number;
    blockTableOffsetHigh: number;
  };
}

export interface MpqUserDataHeader {
  magic: string;
  userDataSize: number;
  mpqHeaderOffset: number;
  userDataHeaderSize: number;
  /** 即 `replay.header` 的编码字节，交给协议解码器解析。 */
  content: Uint8Array;
}

export interface MpqHashEntry {
  /** MPQ 没有存文件名字段，靠 hash 匹配定位；这两个值是我们自己算出来用于比对的。 */
  hashA: number;
  hashB: number;
  locale: number;
  platform: number;
  blockTableIndex: number;
}

export interface MpqBlockEntry {
  offset: number;
  archivedSize: number;
  size: number;
  flags: number;
}

// ---------------------------------------------------------------- 归档

const HEADER_STRUCT_SIZE = 32;
const USER_DATA_HEADER_SIZE = 16;
const TABLE_ENTRY_SIZE = 16;

function readAsciiMagic(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

export class MpqArchive {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private readonly hashTable: MpqHashEntry[];
  private readonly blockTable: MpqBlockEntry[];
  private readonly decompressor?: MpqDecompressor;

  readonly header: MpqHeader;
  readonly userDataHeader: MpqUserDataHeader | null;

  private constructor(
    bytes: Uint8Array,
    header: MpqHeader,
    userDataHeader: MpqUserDataHeader | null,
    hashTable: MpqHashEntry[],
    blockTable: MpqBlockEntry[],
    decompressor?: MpqDecompressor,
  ) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.header = header;
    this.userDataHeader = userDataHeader;
    this.hashTable = hashTable;
    this.blockTable = blockTable;
    this.decompressor = decompressor;
  }

  static async open(
    source: ArrayBuffer | Uint8Array,
    options: MpqOpenOptions = {},
  ): Promise<MpqArchive> {
    const bytes =
      source instanceof Uint8Array ? source : new Uint8Array(source);
    if (bytes.length < USER_DATA_HEADER_SIZE) {
      throw new MpqError("TRUNCATED", `文件长度 ${bytes.length} 不足以容纳 MPQ 头`);
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const userDataHeader = MpqArchive.readUserDataHeader(bytes, view);

    let headerOffset = 0;
    const magic0 = view.getUint8(3);
    if (magic0 === MAGIC_MPQ_USER_DATA) {
      if (!userDataHeader) {
        throw new MpqError("BAD_MAGIC", "user data header 标记存在但内容解析失败");
      }
      headerOffset = userDataHeader.mpqHeaderOffset;
    } else if (magic0 === MAGIC_MPQ_HEADER) {
      headerOffset = 0;
    } else {
      throw new MpqError(
        "BAD_MAGIC",
        `不是 MPQ/SC2Replay 文件：首 4 字节为 ${[...bytes.subarray(0, 4)]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(" ")}`,
      );
    }

    const header = MpqArchive.readHeader(bytes, view, headerOffset);
    const archive = new MpqArchive(bytes, header, userDataHeader, [], [], options.decompressor);

    const hashTableKey = hashFileName("(hash table)", "TABLE");
    const blockTableKey = hashFileName("(block table)", "TABLE");
    const hashTable = archive.readTable<MpqHashEntry>(
      header.hashTableOffset,
      header.hashTableEntries,
      hashTableKey,
      (v, o) => ({
        hashA: v.getUint32(o, true),
        hashB: v.getUint32(o + 4, true),
        locale: v.getUint16(o + 8, true),
        platform: v.getUint16(o + 10, true),
        blockTableIndex: v.getUint32(o + 12, true),
      }),
    );
    const blockTable = archive.readTable<MpqBlockEntry>(
      header.blockTableOffset,
      header.blockTableEntries,
      blockTableKey,
      (v, o) => ({
        offset: v.getUint32(o, true),
        archivedSize: v.getUint32(o + 4, true),
        size: v.getUint32(o + 8, true),
        flags: v.getUint32(o + 12, true),
      }),
    );

    return new MpqArchive(
      bytes,
      header,
      userDataHeader,
      hashTable,
      blockTable,
      options.decompressor,
    );
  }

  private static readUserDataHeader(
    bytes: Uint8Array,
    view: DataView,
  ): MpqUserDataHeader | null {
    if (bytes.length < USER_DATA_HEADER_SIZE) return null;
    if (view.getUint8(3) !== MAGIC_MPQ_USER_DATA) return null;

    const userDataSize = view.getUint32(4, true);
    const mpqHeaderOffset = view.getUint32(8, true);
    const userDataHeaderSize = view.getUint32(12, true);
    const contentStart = USER_DATA_HEADER_SIZE;
    const contentEnd = contentStart + userDataHeaderSize;

    return {
      magic: readAsciiMagic(view, 0),
      userDataSize,
      mpqHeaderOffset,
      userDataHeaderSize,
      content: contentEnd <= bytes.length
        ? bytes.slice(contentStart, contentEnd)
        : bytes.slice(contentStart),
    };
  }

  private static readHeader(
    bytes: Uint8Array,
    view: DataView,
    offset: number,
  ): MpqHeader {
    if (offset + HEADER_STRUCT_SIZE > bytes.length) {
      throw new MpqError(
        "TRUNCATED",
        `MPQ header 偏移 ${offset} 处不足 ${HEADER_STRUCT_SIZE} 字节`,
      );
    }
    const formatVersion = view.getUint16(offset + 12, true);
    const header: MpqHeader = {
      magic: readAsciiMagic(view, offset),
      headerSize: view.getUint32(offset + 4, true),
      archiveSize: view.getUint32(offset + 8, true),
      formatVersion,
      sectorSizeShift: view.getUint16(offset + 14, true),
      hashTableOffset: view.getUint32(offset + 16, true),
      blockTableOffset: view.getUint32(offset + 20, true),
      hashTableEntries: view.getUint32(offset + 24, true),
      blockTableEntries: view.getUint32(offset + 28, true),
      offset,
    };

    // 仅 format_version === 1 带扩展头（与 mpyq 一致）。实测样本为 3，不读扩展头。
    if (formatVersion === 1 && offset + HEADER_STRUCT_SIZE + 12 <= bytes.length) {
      const ext = offset + HEADER_STRUCT_SIZE;
      header.extended = {
        extendedBlockTableOffset: view.getBigInt64(ext, true),
        hashTableOffsetHigh: view.getInt16(ext + 8, true),
        blockTableOffsetHigh: view.getInt16(ext + 10, true),
      };
    }
    return header;
  }

  private readTable<T>(
    tableOffset: number,
    entries: number,
    key: number,
    parse: (view: DataView, entryOffset: number) => T,
  ): T[] {
    if (entries === 0) return [];
    const absolute = tableOffset + this.header.offset;
    const length = entries * TABLE_ENTRY_SIZE;
    if (absolute + length > this.bytes.length) {
      throw new MpqError(
        "TRUNCATED",
        `表读取越界：offset=${absolute} length=${length} fileSize=${this.bytes.length}`,
      );
    }
    const encrypted = this.bytes.subarray(absolute, absolute + length);
    const plain = decryptUint32Block(encrypted, key);
    const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
    const out: T[] = [];
    for (let i = 0; i < entries; i += 1) {
      out.push(parse(view, i * TABLE_ENTRY_SIZE));
    }
    return out;
  }

  /** hash table 条目数（调试/对照用）。 */
  get hashTableEntryCount(): number {
    return this.hashTable.length;
  }

  /** block table 条目数（调试/对照用）。 */
  get blockTableEntryCount(): number {
    return this.blockTable.length;
  }

  /** 按文件名找 hash 条目。mpyq 是线性遍历整个表（不做 bucket 定位），这里保持一致。 */
  findHashEntry(name: string): MpqHashEntry | null {
    const hashA = hashFileName(name, "HASH_A");
    const hashB = hashFileName(name, "HASH_B");
    for (const entry of this.hashTable) {
      if (entry.hashA === hashA && entry.hashB === hashB) return entry;
    }
    return null;
  }

  hasFile(name: string): boolean {
    return this.findHashEntry(name) !== null;
  }

  /** 取某文件的 block 条目（不解压），便于诊断压缩标记。 */
  getBlockEntry(name: string): MpqBlockEntry | null {
    const hashEntry = this.findHashEntry(name);
    if (!hashEntry) return null;
    return this.blockTable[hashEntry.blockTableIndex] ?? null;
  }

  /**
   * 读取并解压 MPQ 内的一个文件。文件不存在或大小为 0 时返回 `null`
   * （与 mpyq 的 `read_file` 行为一致，不抛错）。
   */
  async readFile(name: string): Promise<Uint8Array | null> {
    const hashEntry = this.findHashEntry(name);
    if (!hashEntry) return null;
    const block = this.blockTable[hashEntry.blockTableIndex];
    if (!block) return null;
    return this.readBlock(block, name);
  }

  /**
   * user data header 的 `content` —— 即 `replay.header` 的编码字节。
   * 这是 SC2 录像的 header 来源，**不在** MPQ 文件列表中。不存在时返回 `null`。
   */
  readHeaderContent(): Uint8Array | null {
    return this.userDataHeader ? this.userDataHeader.content : null;
  }

  /** 读取 `(listfile)` 得到归档内的文件名列表；没有 listfile 时返回空数组。 */
  async listFiles(): Promise<string[]> {
    const data = await this.readFile("(listfile)");
    if (!data) return [];
    return new TextDecoder("utf-8")
      .decode(data)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  private async readBlock(block: MpqBlockEntry, name: string): Promise<Uint8Array | null> {
    if ((block.flags & MPQ_FILE_EXISTS) === 0) return null;
    if (block.archivedSize === 0) return null;
    if ((block.flags & MPQ_FILE_ENCRYPTED) !== 0) {
      throw new MpqError(
        "ENCRYPTED_NOT_SUPPORTED",
        `文件 ${name} 被加密，本实现不支持（实测样本均未加密）`,
      );
    }

    const start = block.offset + this.header.offset;
    const end = start + block.archivedSize;
    if (end > this.bytes.length) {
      throw new MpqError(
        "TRUNCATED",
        `文件 ${name} 数据越界：offset=${start} size=${block.archivedSize} fileSize=${this.bytes.length}`,
      );
    }
    const raw = this.bytes.slice(start, end);

    // 单块文件（实测样本全部走这条分支：flags 含 MPQ_FILE_SINGLE_UNIT）。
    // 压缩仅在至少省下 1 字节时才生效 —— 用 size > archivedSize 判定，与 mpyq 一致。
    if ((block.flags & MPQ_FILE_SINGLE_UNIT) !== 0) {
      if ((block.flags & MPQ_FILE_COMPRESS) !== 0 && block.size > block.archivedSize) {
        return decompressBlock(raw, name, this.decompressor);
      }
      return raw;
    }

    // 多 sector 文件：先读 sector 偏移表（sectors + 1 个 uint32），再逐 sector 处理。
    const sectorSize = 512 << this.header.sectorSizeShift;
    let sectors = Math.floor(block.size / sectorSize) + 1;
    const hasCrc = (block.flags & MPQ_FILE_SECTOR_CRC) !== 0;
    if (hasCrc) sectors += 1;

    const positionCount = sectors + 1;
    const tableBytes = positionCount * 4;
    if (tableBytes > raw.length) {
      throw new MpqError(
        "TRUNCATED",
        `文件 ${name} 的 sector 偏移表越界：需要 ${tableBytes} 字节，实得 ${raw.length}`,
      );
    }
    const tableView = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const positions: number[] = [];
    for (let i = 0; i < positionCount; i += 1) {
      positions.push(tableView.getUint32(i * 4, true));
    }

    const out = new Uint8Array(block.size);
    let written = 0;
    let sectorBytesLeft = block.size;
    const iterations = positions.length - (hasCrc ? 2 : 1);
    for (let i = 0; i < iterations; i += 1) {
      // 显式标注为裸 Uint8Array：TS 5.7 起 `slice()` 返回 `Uint8Array<ArrayBuffer>`，
      // 而解压函数返回 `Uint8Array<ArrayBufferLike>`，不标注会被推窄导致赋值失败。
      let sector: Uint8Array = raw.subarray(positions[i], positions[i + 1]);
      if (
        (block.flags & MPQ_FILE_COMPRESS) !== 0 &&
        sectorBytesLeft > sector.length
      ) {
        sector = await decompressBlock(sector, `${name} sector ${i}`, this.decompressor);
      }
      sectorBytesLeft -= sector.length;
      out.set(sector, written);
      written += sector.length;
    }
    return written === block.size ? out : out.subarray(0, written);
  }
}

/** 语义化入口。bzip2 解压后端必须由调用方注入（见 {@link MpqDecompressor}）。 */
export function openMpqArchive(
  source: ArrayBuffer | Uint8Array,
  options: MpqOpenOptions = {},
): Promise<MpqArchive> {
  return MpqArchive.open(source, options);
}

/** 便于上层把 `Uint8Array` 结果转文本。 */
export function decodeUtf8(data: Uint8Array): string {
  return new TextDecoder("utf-8").decode(data);
}
