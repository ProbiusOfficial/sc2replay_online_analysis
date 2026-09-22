/**
 * SC2 协议解码引擎（TypeScript）。
 *
 * 这是 Blizzard 官方 `s2protocol/decoders.py` 的等价实现，逐方法对齐，
 * 便于与 Python 侧做字段级对拍。三个组件：
 *
 *   BitPackedBuffer    位级读取（大端/小端）
 *   BitPackedDecoder   「按声明顺序」读取，用于 header 之外的 initData、
 *                      game/message events（这些流里字段紧凑排布，没有 skip 标记）
 *   VersionedDecoder   「带结构性标记」读取，每个值前有一个 u8 的 skip 标记，
 *                      并额外维护已读字段集合（struct 允许字段缺省/乱序），
 *                      用于 header / details / tracker events
 *
 * 为什么这套分流不能统一：SC2 的 `replay.tracker.events` 是随补丁演进的结构，
 * 官方为了让旧客户端能跳过不认识的字段，给每个值都加了类型标记；
 * 而 `replay.initData` 是版本强绑定的，省掉了标记以减小体积。
 *
 * ## 与 Python 版的两处有意差异
 *
 * 1. Python 2 遗留的整数除法（`(length + 7) / 8`）在此写作 `>> 3`。
 *    官方文件是 Python 2 时代的产物，Python 3 下这些分支会拿到浮点数并报错，
 *    等价实现反而更可靠。
 * 2. 64 位整数用 BigInt（协议里 `m_id` / `m_timeUTC` 等确实用到 64 位，
 *    超出 JS number 的 53 位精度）。由此 `readBits` 的返回类型是
 *    `number | bigint`：≤32 位走 number 快路径，>32 位才用 BigInt。
 */
/** JS 安全整数上界，用 BigInt 表示。超过它的值必须保持 bigint。 */
const MAX_SAFE_BIGINT = 9007199254740992n;
/** 数据被读完前需要更多字节。 */
export class TruncatedError extends Error {
    constructor(message = "数据流提前结束") {
        super(message);
        this.name = "TruncatedError";
    }
}
/** 数据与协议定义不符（未知 typeid、非法 choice tag、skip 标记错误等）。 */
export class CorruptedError extends Error {
    constructor(message = "数据与协议定义不符") {
        super(message);
        this.name = "CorruptedError";
    }
}
/**
 * 位级读取缓冲区。
 *
 * 字节按「低位先出」消耗（`readBits` 从每个字节的低位取起），
 * 但组装结果时按大端语义放到高位 —— 这是 SC2 协议自己的位序约定，
 * 照搬官方实现，不要按直觉改写。
 */
export class BitPackedBuffer {
    data;
    view;
    used = 0;
    next = 0;
    nextBits = 0;
    bigEndian;
    constructor(contents, endian = "big") {
        this.data = contents instanceof Uint8Array ? contents : new Uint8Array(contents);
        this.view = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);
        this.bigEndian = endian === "big";
    }
    toString() {
        const byte = this.used < this.data.length ? this.data[this.used].toString(16).padStart(2, "0") : "--";
        return `buffer(${this.nextBits ? this.next : 0}/${this.nextBits},[${this.used}]=${byte})`;
    }
    done() {
        return this.nextBits === 0 && this.used >= this.data.length;
    }
    usedBits() {
        return this.used * 8 - this.nextBits;
    }
    byteAlign() {
        this.nextBits = 0;
    }
    readAlignedBytes(count) {
        this.byteAlign();
        const slice = this.data.subarray(this.used, this.used + count);
        this.used += count;
        if (slice.length !== count)
            throw new TruncatedError(`${this}`);
        return slice;
    }
    /**
     * 读 `bits` 位。≤32 位返回 number，>32 位返回 bigint。
     *
     * 分批从当前字节取，按大端（或小端）语义就位。单次最多吃 8 位，
     * 所以 `next & ((1 << copyBits) - 1)` 不会溢出。
     */
    readBits(bits) {
        if (bits > 32)
            return this.readBitsWide(bits);
        let result = 0;
        let resultBits = 0;
        while (resultBits !== bits) {
            if (this.nextBits === 0) {
                if (this.done())
                    throw new TruncatedError(`${this}`);
                this.next = this.data[this.used];
                this.used += 1;
                this.nextBits = 8;
            }
            const copyBits = Math.min(bits - resultBits, this.nextBits);
            const copy = this.next & ((1 << copyBits) - 1);
            if (this.bigEndian) {
                result |= copy << (bits - resultBits - copyBits);
            }
            else {
                result |= copy << resultBits;
            }
            this.next >>>= copyBits;
            this.nextBits -= copyBits;
            resultBits += copyBits;
        }
        // `<< 31` 会让结果变成负数，按无符号解释修正。
        return result >>> 0;
    }
    /** >32 位的慢路径。协议里只有 64 位字段会走到这里。 */
    readBitsWide(bits) {
        let result = 0n;
        let resultBits = 0;
        while (resultBits !== bits) {
            if (this.nextBits === 0) {
                if (this.done())
                    throw new TruncatedError(`${this}`);
                this.next = this.data[this.used];
                this.used += 1;
                this.nextBits = 8;
            }
            const copyBits = Math.min(bits - resultBits, this.nextBits);
            const copy = BigInt(this.next & ((1 << copyBits) - 1));
            if (this.bigEndian) {
                result |= copy << BigInt(bits - resultBits - copyBits);
            }
            else {
                result |= copy << BigInt(resultBits);
            }
            this.next >>>= copyBits;
            this.nextBits -= copyBits;
            resultBits += copyBits;
        }
        return result;
    }
    /** 逐字节读成字符串（`_fourcc` 用）。 */
    readUnalignedBytes(count) {
        let out = "";
        for (let i = 0; i < count; i += 1) {
            out += String.fromCharCode(Number(this.readBits(8)));
        }
        return out;
    }
    /** 仅供解码器读 real32/real64 使用：按当前字节位置取 IEEE754 浮点。 */
    readFloat32() {
        this.byteAlign();
        const value = this.view.getFloat32(this.used, false);
        this.used += 4;
        return value;
    }
    readFloat64() {
        this.byteAlign();
        const value = this.view.getFloat64(this.used, false);
        this.used += 8;
        return value;
    }
}
/** 两个解码器的公共骨架：`instance()` 的分派表一致，取值方式不同。 */
class DecoderBase {
    buffer;
    typeInfos;
    constructor(contents, typeInfos) {
        this.buffer = new BitPackedBuffer(contents);
        this.typeInfos = typeInfos;
    }
    done() {
        return this.buffer.done();
    }
    usedBits() {
        return this.buffer.usedBits();
    }
    byteAlign() {
        this.buffer.byteAlign();
    }
    /** 按 typeid 读一个值。这是所有解码的入口。 */
    instance(typeId) {
        if (typeId >= this.typeInfos.length) {
            throw new CorruptedError(`typeid ${typeId} 越界（共 ${this.typeInfos.length} 项）`);
        }
        const [op, args] = this.typeInfos[typeId];
        switch (op) {
            case "_int":
                return this.readInt(args[0]);
            case "_array":
                return this.readArray(args[0], args[1]);
            case "_bitarray":
                return this.readBitArray(args[0]);
            case "_blob":
                return this.readBlob(args[0]);
            case "_bool":
                return this.readBool();
            case "_choice":
                return this.readChoice(args[0], args[1]);
            case "_fourcc":
                return this.readFourCC();
            case "_null":
                return null;
            case "_optional":
                return this.readOptional(args[0]);
            case "_real32":
                return this.readReal32();
            case "_real64":
                return this.readReal64();
            case "_struct":
                return this.readStruct(args[0]);
            default:
                throw new CorruptedError(`未知的解码指令 "${op}"`);
        }
    }
    /**
     * 处理 `__parent`：把父结构的成员摊平到当前层。
     *
     * 已核对：当前收录的三个协议版本里 `__parent` 出现 0 次，
     * 这段是为了与官方实现保持同构、应对将来协议引入该字段。
     */
    assignField(result, field, fieldCount) {
        const [name, typeId] = field;
        if (name === "__parent") {
            const parent = this.instance(typeId);
            if (parent !== null && typeof parent === "object" && !Array.isArray(parent)) {
                Object.assign(result, parent);
            }
            else if (fieldCount === 1) {
                // 整个结构就是这个父类型本身，没有别的字段可放。
                result.__parent = parent;
            }
            else {
                result[name] = parent;
            }
            return;
        }
        result[name] = this.instance(typeId);
    }
}
/**
 * 无版本标记的解码器。字段严格按声明顺序出现。
 *
 * 用于 `replay.initData` 与 game / message events。
 */
export class BitPackedDecoder extends DecoderBase {
    readInt(bounds) {
        const [min, width] = bounds;
        const raw = this.buffer.readBits(width);
        if (typeof raw === "bigint" || typeof min === "string") {
            return BigInt(min) + (typeof raw === "bigint" ? raw : BigInt(raw));
        }
        return min + raw;
    }
    readArray(bounds, typeId) {
        const length = Number(this.readInt(bounds));
        const out = [];
        for (let i = 0; i < length; i += 1)
            out.push(this.instance(typeId));
        return out;
    }
    readBitArray(bounds) {
        const length = Number(this.readInt(bounds));
        // 位宽来自 bounds（协议里最大 9 位），直接当整数返回。
        return [length, this.buffer.readBits(length)];
    }
    readBlob(bounds) {
        const length = Number(this.readInt(bounds));
        return this.buffer.readAlignedBytes(length);
    }
    readBool() {
        return Number(this.readInt([0, 1])) !== 0;
    }
    readChoice(bounds, fields) {
        const tag = Number(this.readInt(bounds));
        const field = fields[String(tag)];
        if (!field)
            throw new CorruptedError(`choice tag ${tag} 不在定义中`);
        return { [field[0]]: this.instance(field[1]) };
    }
    readFourCC() {
        return this.buffer.readUnalignedBytes(4);
    }
    readOptional(typeId) {
        return this.readBool() ? this.instance(typeId) : null;
    }
    /** 官方此处用 `read_unaligned_bytes` —— 逐位读，不做字节对齐。 */
    readReal32() {
        return this.collectFloat(4, (view) => view.getFloat32(0, false));
    }
    readReal64() {
        return this.collectFloat(8, (view) => view.getFloat64(0, false));
    }
    collectFloat(size, read) {
        const bytes = new Uint8Array(size);
        for (let i = 0; i < size; i += 1)
            bytes[i] = Number(this.buffer.readBits(8));
        return read(new DataView(bytes.buffer));
    }
    readStruct(fields) {
        const result = {};
        for (const field of fields) {
            this.assignField(result, field, fields.length);
        }
        return result;
    }
}
/**
 * 带版本标记的解码器。每个值前有一个 u8 标记（`skip`），struct 也带字段数。
 *
 * 用于 `replay.header`、`replay.details`、`replay.tracker.events` ——
 * 这三者是随补丁演进的结构，官方用标记让旧解析器能跳过不认识的字段。
 *
 * 未知字段会走 `skipInstance()` 而非报错，这正是「新协议 + 旧定义」还能
 * 降级解析的原因。
 */
export class VersionedDecoder extends DecoderBase {
    expectSkip(expected) {
        if (Number(this.buffer.readBits(8)) !== expected) {
            throw new CorruptedError(`期望标记 ${expected}，实际不符（${this.buffer}）`);
        }
    }
    /**
     * 变长整数：首字节最低位是符号，其余 6 位是低位，后续字节各贡献 7 位。
     *
     * 用 BigInt 累加 —— Python 的 int 是任意精度的，而 vint 会承载 64 位值
     * （`m_timeUTC` 这类字段在 VersionedDecoder 下也走 vint，不受 `bounds` 约束），
     * 用 number 累加会静默丢精度（实测差 4，足以让对拍失败）。
     *
     * 单字节 vint 走 number 快路径：绝大多数取值（长度、枚举）都落在这一档。
     */
    vint() {
        let b = Number(this.buffer.readBits(8));
        const negative = (b & 1) === 1;
        let result = (b >> 1) & 0x3f;
        if ((b & 0x80) === 0) {
            return negative ? -result : result;
        }
        let wide = BigInt(result);
        let bits = 6;
        while ((b & 0x80) !== 0) {
            b = Number(this.buffer.readBits(8));
            wide |= BigInt(b & 0x7f) << BigInt(bits);
            bits += 7;
        }
        const signed = negative ? -wide : wide;
        // 与 Python 规范化的口径一致：超出安全整数范围就保持 bigint，
        // 由序列化层转成十进制字符串。
        return signed > MAX_SAFE_BIGINT || signed < -MAX_SAFE_BIGINT
            ? signed
            : Number(signed);
    }
    readInt(_bounds) {
        this.expectSkip(9);
        return this.vint();
    }
    readArray(_bounds, typeId) {
        this.expectSkip(0);
        const length = Number(this.vint());
        const out = [];
        for (let i = 0; i < length; i += 1)
            out.push(this.instance(typeId));
        return out;
    }
    /**
     * 注意与 BitPackedDecoder 的差异：官方此处返回**原始字节**而非整数值
     * （`read_aligned_bytes((length + 7) / 8)`），照搬。
     */
    readBitArray(_bounds) {
        this.expectSkip(1);
        const length = Number(this.vint());
        // 官方写作 `(length + 7) / 8`，是 Python 2 的整除。
        return [length, this.buffer.readAlignedBytes((length + 7) >> 3)];
    }
    readBlob(_bounds) {
        this.expectSkip(2);
        const length = Number(this.vint());
        return this.buffer.readAlignedBytes(length);
    }
    readBool() {
        this.expectSkip(6);
        return Number(this.buffer.readBits(8)) !== 0;
    }
    readChoice(_bounds, fields) {
        this.expectSkip(3);
        const tag = Number(this.vint());
        const field = fields[String(tag)];
        if (!field) {
            // 不认识的分支：只能按结构跳过，返回空对象。
            this.skipInstance();
            return {};
        }
        return { [field[0]]: this.instance(field[1]) };
    }
    /** 官方此处是 `read_aligned_bytes(4)`，返回 bytes —— 与 BitPacked 版不同。 */
    readFourCC() {
        this.expectSkip(7);
        return this.buffer.readAlignedBytes(4);
    }
    readOptional(typeId) {
        this.expectSkip(4);
        const exists = Number(this.buffer.readBits(8)) !== 0;
        return exists ? this.instance(typeId) : null;
    }
    readReal32() {
        this.expectSkip(7);
        return this.buffer.readFloat32();
    }
    readReal64() {
        this.expectSkip(8);
        return this.buffer.readFloat64();
    }
    readStruct(fields) {
        this.expectSkip(5);
        const result = {};
        const count = this.vint();
        for (let i = 0; i < count; i += 1) {
            const tag = this.vint();
            const field = fields.find((f) => f[2] === tag);
            if (!field) {
                // 协议里有、本地定义里没有的字段：跳过它继续，这是降级的关键。
                this.skipInstance();
                continue;
            }
            this.assignField(result, field, fields.length);
        }
        return result;
    }
    /** 读 `length` 位到一个整数。官方在此按字节对齐读取。 */
    /**
     * 按标记跳过一个值。
     *
     * 标记语义与各 `read*` 方法一一对应（0=数组 1=bitarray 2=blob 3=choice
     * 4=optional 5=struct 6=u8 7=u32 8=u64 9=vint）。用于「本地定义里没有
     * 这个字段」时把流推过去。
     */
    skipInstance() {
        const skip = Number(this.buffer.readBits(8));
        switch (skip) {
            case 0: {
                const length = Number(this.vint());
                for (let i = 0; i < length; i += 1)
                    this.skipInstance();
                return;
            }
            case 1: {
                const length = Number(this.vint());
                this.buffer.readAlignedBytes((length + 7) >> 3);
                return;
            }
            case 2: {
                const length = Number(this.vint());
                this.buffer.readAlignedBytes(length);
                return;
            }
            case 3:
                Number(this.vint());
                this.skipInstance();
                return;
            case 4:
                if (Number(this.buffer.readBits(8)) !== 0)
                    this.skipInstance();
                return;
            case 5: {
                const length = Number(this.vint());
                for (let i = 0; i < length; i += 1) {
                    Number(this.vint());
                    this.skipInstance();
                }
                return;
            }
            case 6:
                this.buffer.readAlignedBytes(1);
                return;
            case 7:
                this.buffer.readAlignedBytes(4);
                return;
            case 8:
                this.buffer.readAlignedBytes(8);
                return;
            case 9:
                this.vint();
                return;
            default:
                throw new CorruptedError(`无法跳过的标记 ${skip}`);
        }
    }
}
