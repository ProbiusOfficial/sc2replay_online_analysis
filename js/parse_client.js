/**
 * 主线程侧的解析入口 —— **取代 `pyodide_boot.js`**。
 *
 * 旧链路：主线程里跑 Pyodide（同步执行 Python，页面冻结）+ 现场 micropip 装
 * `sc2reader` / `spawningtool`。新链路：把录像字节 Transferable 给 Worker，
 * Worker 里跑 wasm + TS 解码器，主线程全程不阻塞。
 *
 * 对外保留的 API 与旧模块一一对应，调用方（`app.js` / `replays_page.js` /
 * `batch_rail.js`）只需换 import：
 *
 * | 旧（Pyodide）              | 新（Worker + wasm）              |
 * | -------------------------- | -------------------------------- |
 * | `initPyodide()`            | {@link initParser}               |
 * | `parseReplayBufferToData`  | {@link parseReplayBufferToData}  |
 * | `appState.pyodide` 真值判断 | {@link isParserReady}            |
 *
 * ## 为什么还要一次「初始化」
 *
 * 旧链路初始化要几秒（下载 10MB 级运行时 + 装两个包），所以有 `#initStatus` 与
 * 「初始化完成才显示拖放区」这一套。新链路快得多，但**仍然异步**（wasm 实例化 +
 * 首个 ping 往返），而且失败必须让用户看见 —— 所以保留同样的 UI 时序，
 * 只是文案改成实话。
 */
import { appState } from "./state.js";
import { setInitStatus } from "./errors_init.js";
import { ping, parseReplay, terminateWorker } from "./worker/index.js";

/** 初始化只做一次；失败后保留 rejected，避免反复重试把错误吞掉。 */
let initPromise = null;

/** 解析环境是否已就绪（替代旧代码里的 `appState.pyodide` 真值判断）。 */
export function isParserReady() {
  return appState.parserReady === true;
}

/** 就绪前的提示文案，与大屏状态区共用一份，避免两处措辞不一致。 */
const NOT_READY_MESSAGE = "解析内核尚未就绪，请稍候再试";

/**
 * 初始化解析内核：拉起 Worker，并 **ping 一次**确认 wasm 真的加载成功。
 *
 * 为什么要 ping：Worker 构造成功 ≠ wasm 可用。`new Worker()` 是异步的，
 * 模块加载失败也只在 error 事件里体现；主动 ping 一次能在初始化阶段就把
 * 「wasm 产物缺失 / MIME 不对」这类问题暴露出来，而不是等用户拖进录像才报错。
 */
export async function initParser() {
  if (initPromise) return initPromise;

  const initStatus = document.getElementById("initStatus");
  const dropZone = document.getElementById("dropZone");

  initPromise = (async () => {
    setInitStatus("加载解析内核（WASM）...");
    const pong = await ping();
    if (!pong || pong.type !== "pong") throw new Error("解析 Worker 未返回预期响应");
    appState.parserReady = true;
    if (initStatus) initStatus.style.display = "none";
    if (dropZone) dropZone.style.display = "block";
  })();

  try {
    await initPromise;
  } catch (e) {
    console.error(e);
    appState.parserReady = false;
    // 失败后允许再试：清掉缓存的 promise，让「刷新重试」之外还有一次机会。
    initPromise = null;
    setInitStatus("");
    if (initStatus) {
      initStatus.innerHTML =
        `<p style="color:var(--accent-red)">解析内核初始化失败: ${e?.message ?? e}</p>` +
        `<p style="margin-top:0.5rem;font-size:0.85rem">请检查网络连接后刷新重试。</p>`;
    }
  }
  return initPromise;
}

/**
 * 解析一份录像，返回与旧链路 `extract_replay_data` 同构的 `ReplayData`。
 *
 * `buffer` 会被 **Transferable 移交**给 Worker，调用后主线程不再持有它 ——
 * 所以调用方如需保留原始字节，请自己先复制（`buffer.slice(0)`）。
 * 这条旧 API 没有，属于新行为，调用方要清楚。
 */
export async function parseReplayBufferToData(buffer) {
  if (!isParserReady()) throw new Error(NOT_READY_MESSAGE);
  const response = await parseReplay(buffer, md5Placeholder(buffer));
  if (response.type === "ok") return response.data;
  const err = new Error(response.message || "解析失败");
  err.code = response.code;
  throw err;
}

/**
 * 缓存键占位。
 *
 * §4.3 的 IndexedDB 缓存（P2）尚未落地，`md5` 眼下只作为 Worker 响应里的回带标识，
 * **没有**参与任何哈希或缓存。不要在这里偷偷算 md5 去糊一个「看起来完整」的键：
 * 那会让后续接入真缓存时难以分辨哪些值可信。
 */
function md5Placeholder() {
  return "";
}

/** 释放 Worker。批量任务结束后调用，避免常驻线程占内存。 */
export function releaseParser() {
  terminateWorker();
  appState.parserReady = false;
  initPromise = null;
}
