/**
 * 解析 Worker 入口（后台线程）。
 *
 * 职责：**所有解析与计算都在这里发生**，主线程不碰协议解码。
 * `ping` 用于冒烟；`parse` 是真正的解析路径 —— MPQ 读取 → 六流协议解码 →
 * `ReplayData` 组装（`decoder/replay_data.ts`），全程零 Python 依赖。
 *
 * ## 为什么 wasm 只初始化一次
 *
 * Worker 是**常驻**的（见 `js/worker/index.ts` 的 Worker 生命周期管理），
 * 所以 wasm 实例与解压器都缓存在模块作用域。`initComputeWasm()` 自带 promise 记忆
 * （`decompressors.ts`），这里不再包一层 —— 早期版本同时 import 了 wasm-pack 的
 * 默认 `init`，会与 `decompressors.ts` 各调一次 `init()`，白跑一次实例化。
 */
import { ping as wasmPing } from "../../wasm/pkg/compute.js";
import { createWasmDecompressor, initComputeWasm } from "./decoder/decompressors.js";
import { extractReplayData } from "./decoder/replay_data.js";
import { ERROR_CODES } from "./contract.js";
// Worker 全局作用域。这里用断言获取而不是直接依赖 `DedicatedWorkerGlobalScope`，
// 是为了让主线程与 Worker 共用一份 tsconfig（DOM 与 WebWorker 两套 lib 会声明冲突）。
const workerScope = globalThis;
/**
 * 解压器实例在 Worker 生命周期内复用。
 *
 * **不能每次解析都新建** —— 它内部走 `initComputeWasm()` 的共享 promise，
 * 但每次新建对象本身没必要；更重要的是保持「一个 Worker 一份 wasm 实例」这个不变量。
 */
let decompressor = null;
function getDecompressor() {
    if (!decompressor)
        decompressor = createWasmDecompressor();
    return decompressor;
}
function fail(id, md5, message, code) {
    workerScope.postMessage({ type: "error", id, md5, message, code });
}
workerScope.addEventListener("message", async (event) => {
    const request = event.data;
    if (!request || typeof request !== "object")
        return;
    if (request.type === "ping") {
        try {
            await initComputeWasm();
            workerScope.postMessage({ type: "pong", id: request.id, message: wasmPing() });
        }
        catch (err) {
            fail(request.id, "", err instanceof Error ? err.message : String(err), ERROR_CODES.wasmInitFailed);
        }
        return;
    }
    if (request.type === "parse") {
        const { id, md5, buffer } = request;
        if (!(buffer instanceof ArrayBuffer)) {
            fail(id, md5, "parse 请求缺少 ArrayBuffer 类型的 buffer", ERROR_CODES.badRequest);
            return;
        }
        try {
            // 注意 `buffer` 已由主线程 Transferable 移交，这里持有的是唯一副本。
            const data = await extractReplayData(new Uint8Array(buffer), {
                decompressor: getDecompressor(),
            });
            workerScope.postMessage({ type: "ok", id, md5, cached: false, data });
        }
        catch (err) {
            // 错误文案要能指向具体原因（缺流 / MPQ 结构异常 / 协议表选错），
            // 所以原样透传 `message`，不要吞成「解析失败」。
            fail(id, md5, err instanceof Error ? err.message : String(err), ERROR_CODES.parseFailed);
        }
        return;
    }
    // `skipCache` 依赖 §4.3 的 IndexedDB 缓存层（P2，未实现），见 contract.ts 的说明。
    const pending = request;
    fail(pending.id ?? "", pending.md5 ?? "", `解析结果缓存尚未实现，无法处理 ${request.type}（P2 落地）`, ERROR_CODES.notImplemented);
});
