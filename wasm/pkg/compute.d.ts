/* tslint:disable */
/* eslint-disable */

/**
 * 解压一段 bzip2 流（不含 MPQ 的压缩类型标记字节）。
 *
 * MPQ 的每个压缩块首字节是压缩类型标记，`bzip2` 为 `0x10`；
 * 调用方需先剥掉该字节再把剩余数据传进来（见 `js/worker/decoder/mpq.ts`）。
 *
 * 正确性依据：`scripts/compare-parsers.mjs` 会对 5 个样本的全部 53 个压缩块
 * 逐块比对解压结果的 md5，基准来自 Python 的 `bz2`（即 libbz2）。
 */
export function bzip2_decompress(data: Uint8Array): Uint8Array;

/**
 * P0 冒烟函数：确认 wasm 模块能被页面加载并调用。
 *
 * 返回值带版本号，便于在浏览器控制台确认加载的是本次构建的产物。
 */
export function ping(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly bzip2_decompress: (a: number, b: number, c: number) => void;
    readonly ping: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
