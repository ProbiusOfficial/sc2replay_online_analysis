const WORKER_URL = new URL("./parse.worker.js", import.meta.url);
let worker = null;
let seq = 0;
const pending = new Map();
function nextId() {
    seq += 1;
    return `r${seq}`;
}
function getWorker() {
    if (worker)
        return worker;
    const instance = new Worker(WORKER_URL, { type: "module", name: "sc2-parse" });
    instance.addEventListener("message", (event) => {
        const response = event.data;
        const entry = pending.get(response.id);
        if (!entry)
            return;
        pending.delete(response.id);
        entry.resolve(response);
    });
    instance.addEventListener("error", (event) => {
        // Worker 整体崩溃：把在途请求全部失败掉，避免调用方永久挂起。
        const err = new Error(event.message || "解析 Worker 发生未捕获错误");
        for (const [id, entry] of [...pending]) {
            pending.delete(id);
            entry.reject(err);
        }
        worker = null;
    });
    worker = instance;
    return instance;
}
function request(message, transfer = []) {
    const instance = getWorker();
    return new Promise((resolve, reject) => {
        pending.set(message.id, {
            resolve: resolve,
            reject,
        });
        instance.postMessage(message, transfer);
    });
}
/** P0 冒烟：确认 Worker 通道与 wasm 加载都正常。 */
export function ping(id = nextId()) {
    const message = { type: "ping", id };
    return request(message);
}
/**
 * 请求解析一份录像。`buffer` 以 Transferable 移交，返回后主线程不再持有该 ArrayBuffer。
 */
export function parseReplay(buffer, md5, id = nextId()) {
    const message = { type: "parse", id, md5, buffer };
    return request(message, [buffer]);
}
/** 绕过 IndexedDB 缓存，强制重新解析。 */
export function skipCache(md5, id = nextId()) {
    const message = { type: "skipCache", id, md5 };
    return request(message);
}
/** 释放 Worker。批量任务结束后调用，避免常驻线程占内存。 */
export function terminateWorker() {
    if (!worker)
        return;
    worker.terminate();
    worker = null;
    pending.clear();
}
export { PARSER_VERSION } from "./contract.js";
