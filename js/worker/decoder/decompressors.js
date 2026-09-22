/**
 * 解压后端的装配层：把 wasm 里的 bzip2 解码器接成 {@link MpqDecompressor}。
 *
 * 为什么要有这一层：`mpq.ts` 属于纯容器解析，不该知道 wasm 的存在
 * （否则 Node 单测、CI 校验都会被 wasm 的加载方式绑死）。
 * 这里集中承担 wasm 的初始化与平台差异。
 *
 * 初始化有两条路：
 *   - 浏览器 / Worker：`initComputeWasm()` 走 wasm-pack 的默认路径（按 `import.meta.url`
 *     解析 `compute_bg.wasm` 并发起 fetch）。
 *   - Node（单测 / 对照脚本）：Node 的 `fetch` 不支持 `file://`，需先自己
 *     `initSync({ module: <bytes> })`，再调 `markComputeWasmReady()` 告知本模块跳过 fetch。
 */
import init, { bzip2_decompress } from "../../../wasm/pkg/compute.js";
let readyPromise = null;
/** 确保 wasm 已就绪（浏览器/Worker 路径）。 */
export function initComputeWasm() {
    if (!readyPromise) {
        readyPromise = init().then(() => undefined);
    }
    return readyPromise;
}
/**
 * 声明「wasm 已由外部初始化完毕」，让 {@link initComputeWasm} 不再触发 fetch。
 * 仅用于 Node 侧：调用方先 `initSync({ module })`，再调本函数。
 */
export function markComputeWasmReady() {
    readyPromise = Promise.resolve();
}
/** 装配一个基于 wasm 的 bzip2 解压后端。 */
export function createWasmDecompressor() {
    return {
        async bzip2(data) {
            await initComputeWasm();
            return bzip2_decompress(data);
        },
    };
}
export { bzip2_decompress };
