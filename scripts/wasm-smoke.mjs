/**
 * P0 冒烟测试：在 Node 里直接加载 `wasm/pkg/compute.js` 并调用 `ping()`。
 *
 * 为什么不用浏览器跑：本脚本要进 CI，需要一个无头、零依赖的验证点。
 * 浏览器侧的同名验证见仓库根目录的 `wasm-smoke.html`。
 *
 * 注意：wasm-pack `--target web` 的默认导出走 `fetch(new URL(...))`，Node 的 fetch
 * 不支持 `file:`，所以这里改用 `initSync`（与浏览器路径共享同一份 glue 与 .wasm）。
 *
 * 用法：node scripts/wasm-smoke.mjs
 */
import { readFile } from "node:fs/promises";

const glueUrl = new URL("../wasm/pkg/compute.js", import.meta.url);
const wasmUrl = new URL("../wasm/pkg/compute_bg.wasm", import.meta.url);

const glue = await import(glueUrl.href);
const bytes = await readFile(wasmUrl);

if (typeof glue.ping !== "function") {
  throw new Error("compute.js 未导出 ping()，产物可能不完整");
}

glue.initSync({ module: await WebAssembly.compile(bytes) });

const message = glue.ping();
if (typeof message !== "string" || !message.startsWith("compute.wasm pong (v")) {
  throw new Error(`ping() 返回值不符合预期: ${JSON.stringify(message)}`);
}

const sizeKb = (bytes.byteLength / 1024).toFixed(1);
console.log(`[wasm-smoke] OK  ping() -> ${message}`);
console.log(`[wasm-smoke] OK  compute_bg.wasm = ${bytes.byteLength} bytes (${sizeKb} KB)`);

// 体积预算（与 CI 的门禁保持一致，本地提前失败比在 CI 上失败便宜）
const BUDGET_BYTES = 512000;
if (bytes.byteLength > BUDGET_BYTES) {
  throw new Error(`wasm 体积超预算：${bytes.byteLength} > ${BUDGET_BYTES} bytes`);
}
console.log(`[wasm-smoke] OK  体积在预算内 (< ${BUDGET_BYTES / 1024} KB)`);
