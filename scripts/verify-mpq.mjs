#!/usr/bin/env node
/**
 * MPQ 读取 + bzip2 解压的验收脚本。
 *
 * 比对对象：`tests/fixtures/mpq-baseline.json`（由 `scripts/make-mpq-fixtures.py` 用
 * Python 的 `mpyq` + `bz2` 生成并固化）。基准只存期望值（尺寸 / md5 / 结构参数），
 * 所以 CI 里**不需要 Python**，只需要仓库自带的样本录像。
 *
 * 覆盖面：
 *   - MPQ 头部全字段（user data header 路径 + MPQ header 路径）
 *   - `replay.header` 的来源（user data header 的 content）
 *   - hash / block 表条目数、`(listfile)` 内容
 *   - 每个文件的 block 条目与**解压后 md5** —— 后者覆盖了全部 53 个 bzip2 块，
 *     等于对 wasm 侧 `bzip2_decompress` 做了一次全量回归
 *
 * 用法：node scripts/verify-mpq.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SAMPLE_DIR = join(REPO, "sampleTest");
const FIXTURE = join(REPO, "tests", "fixtures", "mpq-baseline.json");
const WASM = join(REPO, "wasm", "pkg", "compute_bg.wasm");

for (const [label, path] of [["fixtures", FIXTURE], ["wasm 产物", WASM]]) {
  if (!existsSync(path)) {
    console.error(`✗ 找不到${label}：${path}`);
    if (label === "wasm 产物") {
      console.error("  先跑：cd wasm && wasm-pack build --target web --release && rm -f pkg/.gitignore");
    }
    process.exit(1);
  }
}

// Node 的 fetch 不支持 file://，所以先 initSync 注入字节，再告诉适配层跳过 fetch。
const { initSync } = await import(join(REPO, "wasm/pkg/compute.js"));
initSync({ module: readFileSync(WASM) });

const { markComputeWasmReady, createWasmDecompressor } = await import(
  join(REPO, "js/worker/decoder/decompressors.js")
);
markComputeWasmReady();

const { openMpqArchive } = await import(join(REPO, "js/worker/decoder/mpq.js"));

const md5 = (bytes) => createHash("md5").update(bytes).digest("hex");
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const asciiHex = (str) => hex([...str].map((c) => c.charCodeAt(0)));

const baseline = JSON.parse(readFileSync(FIXTURE, "utf8"));
const decompressor = createWasmDecompressor();

let checks = 0;
const failures = [];

function eq(label, actual, expected) {
  checks += 1;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${label}\n      TS   = ${JSON.stringify(actual)}\n      期望 = ${JSON.stringify(expected)}`);
  }
}

const samples = readdirSync(SAMPLE_DIR).filter((f) => f.endsWith(".SC2Replay")).sort();
eq("样本集合", samples, Object.keys(baseline).sort());

let bzip2Blocks = 0;
let totalCompressed = 0;
let totalUnpacked = 0;

for (const name of Object.keys(baseline)) {
  const expected = baseline[name];
  const label = name.length > 42 ? `${name.slice(0, 39)}...` : name;
  const raw = new Uint8Array(readFileSync(join(SAMPLE_DIR, name)));

  eq(`[${label}] 文件大小`, raw.length, expected.rawSize);
  eq(`[${label}] 文件 md5`, md5(raw), expected.rawMd5);

  const archive = await openMpqArchive(raw, { decompressor });

  // ---- 头部 ----
  const gh = archive.header;
  eq(`[${label}] header`, {
    magic: asciiHex(gh.magic),
    headerSize: gh.headerSize,
    archiveSize: gh.archiveSize,
    formatVersion: gh.formatVersion,
    sectorSizeShift: gh.sectorSizeShift,
    hashTableOffset: gh.hashTableOffset,
    blockTableOffset: gh.blockTableOffset,
    hashTableEntries: gh.hashTableEntries,
    blockTableEntries: gh.blockTableEntries,
    offset: gh.offset,
  }, expected.header);

  // ---- user data header（replay.header 的来源）----
  const gu = archive.userDataHeader;
  if (!expected.userDataHeader) {
    eq(`[${label}] userDataHeader 应为空`, gu, null);
  } else if (!gu) {
    failures.push(`[${label}] TS 未解析出 user data header`);
  } else {
    eq(`[${label}] userDataHeader`, {
      magic: asciiHex(gu.magic),
      userDataSize: gu.userDataSize,
      mpqHeaderOffset: gu.mpqHeaderOffset,
      userDataHeaderSize: gu.userDataHeaderSize,
      contentMd5: md5(gu.content),
      contentLength: gu.content.length,
    }, expected.userDataHeader);
    eq(`[${label}] readHeaderContent()`, md5(archive.readHeaderContent()), expected.userDataHeader.contentMd5);
  }

  // ---- 表与文件列表 ----
  eq(`[${label}] hash 表条目数`, archive.hashTableEntryCount, expected.hashTableEntryCount);
  eq(`[${label}] block 表条目数`, archive.blockTableEntryCount, expected.blockTableEntryCount);
  eq(`[${label}] listfile`, await archive.listFiles(), expected.listfile);

  // ---- 逐文件 ----
  for (const [fname, exp] of Object.entries(expected.files)) {
    const hashEntry = archive.findHashEntry(fname);
    if (!hashEntry) {
      failures.push(`[${label}] ${fname}: TS 找不到 hash entry`);
      continue;
    }
    const block = archive.getBlockEntry(fname);
    if (!block) {
      failures.push(`[${label}] ${fname}: TS 找不到 block entry`);
      continue;
    }
    eq(`[${label}] ${fname} block`, {
      blockIndex: hashEntry.blockTableIndex,
      offset: block.offset,
      archivedSize: block.archivedSize,
      size: block.size,
      flags: block.flags,
    }, {
      blockIndex: exp.blockIndex,
      offset: exp.offset,
      archivedSize: exp.archivedSize,
      size: exp.size,
      flags: exp.flags,
    });

    const data = await archive.readFile(fname);
    // archivedSize === 0 的文件（实测例：replay.sync.history）在 mpyq 与本实现里都返回 null，
    // 这是约定行为而非失败 —— 期望值为 null 时按 null 断言。
    if (exp.md5Unpacked === null) {
      eq(`[${label}] ${fname} 期望读取为 null`, data, null);
      continue;
    }
    if (!data) {
      failures.push(`[${label}] ${fname}: TS 读取返回 null`);
      continue;
    }
    eq(`[${label}] ${fname} 解压后 md5`, md5(data), exp.md5Unpacked);
    eq(`[${label}] ${fname} 解压后长度`, data.length, exp.size);

    if (exp.compression === "bzip2") {
      bzip2Blocks += 1;
      totalCompressed += exp.archivedSize;
      totalUnpacked += exp.size;
    }
  }
}

console.log(`\n断言 ${checks} 项 · 失败 ${failures.length} 项`);
console.log(`bzip2 块回归 ${bzip2Blocks} 个：压缩 ${totalCompressed.toLocaleString()} B → 解压 ${totalUnpacked.toLocaleString()} B`);

if (failures.length) {
  console.log("\n失败明细：");
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
const samplesCount = Object.keys(baseline).length;
console.log(`\n✅ ${samplesCount} 个录像、全部文件与 mpyq + libbz2 基准逐字段一致`);
