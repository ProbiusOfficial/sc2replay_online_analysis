/**
 * 页面编排层 —— 录像输入 → 解析 → 数据适配 → 挂载视图。
 *
 * 职责边界：
 *   - 本文件：文件输入、进度、错误、把解析结果交给适配层
 *   - `js/lab/data.js`：`ReplayData` → 视图层的形状
 *   - `js/lab/views.js`：渲染与交互（从原型逐字节提取，含建造顺序 / 语音 / 悬浮探测）
 *
 * 旧入口 `js/app.js`（配合 `display.js` / `batch_rail.js` / `replays_page.js`）是上一代 UI 的
 * 编排层，本次改动后**不再被任何页面引用**，保留未删以便回退。
 */

import { loadTranslationData, setInitStatus } from "../errors_init.js";
import { initParser, parseReplayBufferToData, isParserReady } from "../parse_client.js";
import { toLabReplays } from "./data.js";
import { mountLab, labState, voiceState, redraw } from "./views.js";
import { initSandbox, mountSandbox } from "./sandbox.js";

/**
 * 调试 / 验收句柄。
 *
 * 视图层是 ES Module，它的 `S`（视图状态）与 `V`（播报状态）在模块作用域里，
 * 从页面控制台**看不到** —— 出问题时用户没法自查，验收脚本也没法断言。
 * 这里挂两个**只读引用**出去（是同一个对象，不是快照），读得到但不该写。
 */
window.__lab = { state: labState, voice: voiceState };

const $ = (s) => document.querySelector(s);

/* ==========================================================================
   运行态外壳
   ========================================================================== */

function show(el, on = true) {
  if (el) el.classList.toggle("on", on);
}

function setError(title, detail) {
  const box = $("#error");
  if (!box) return;
  if (!title) {
    box.classList.remove("on");
    box.innerHTML = "";
    return;
  }
  box.innerHTML = `<strong>${esc(title)}</strong>${detail ? esc(detail) : ""}`;
  box.classList.add("on");
}

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function setLoading(text) {
  const box = $("#loading");
  if (!text) {
    show(box, false);
    return;
  }
  const t = $("#loadingText");
  if (t) t.textContent = text;
  show(box, true);
}

/* ==========================================================================
   底部播报条的高度 —— 已随底栏移除（2026-09-23）
   ========================================================================== */

/**
 * 这里原本是 `trackBottomBarHeight()`：把固定底栏的实测高度写进 CSS 变量 `--vbh`，
 * 供 `.wrap` 的底部留白与内部指标侧栏的 `max-height` 扣除（窄屏底栏会换行变高，
 * 写死 84px 就会被压住）。
 *
 * 底栏已重做为左侧栏里的播报面板，`--vbh` 全仓不再有消费方，故整段删除。
 * 若将来又出现固定底栏，记得同时恢复「写入端」和「消费端（css/lab.css）」。
 */

/* ==========================================================================
   结果区宽度变化 → 重绘
   ========================================================================== */

/** 观测器与上一次宽度（-1 表示尚未记录首帧）。 */
let resultRO = null;
let lastResultW = -1;
let redrawTimer = 0;

/**
 * 结果区宽度变化时重绘整块视图。
 *
 * 为什么必须做：视图层把每个 SVG 的 `viewBox` 设成「**渲染那一刻**的容器实宽」，
 * 而它们都带 `preserveAspectRatio="none"` —— 一旦 viewBox 与显示尺寸不再匹配，
 * 内容就会被**非等比拉伸**（实测错位时横向拉伸 3.05~3.24 倍，刻度文字明显变形）。
 * 容器宽度会因窗口缩放、媒体查询切换（≤1180px 侧栏转横排）而变化，必须跟着重算。
 *
 * 只对**宽度**变化重绘：结果区高度随内容频繁变动，全都响应会形成重绘风暴。
 */
function watchResultWidth() {
  const host = $("#result");
  if (!host || resultRO) return;
  resultRO = new ResizeObserver((entries) => {
    const w = Math.round(entries[0].contentRect.width);
    if (lastResultW < 0) {
      lastResultW = w; // 首帧只记录：刚 mountLab 完，宽度就是最新的
      return;
    }
    if (Math.abs(w - lastResultW) < 2) return;
    lastResultW = w;
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(() => redraw(), 140);
  });
  resultRO.observe(host);
}

/* ==========================================================================
   解析一批文件
   ========================================================================== */

/** 解析中暂存，供 rail 展示「这个文件当前什么状态」。 */
const fileStates = new Map();

function renderRailNote(text, kind = "") {
  const host = $("#railNote");
  if (!host) return;
  host.className = "lab " + kind;
  host.textContent = text;
}

/**
 * @param {File[]} files
 * @returns {Promise<{ok: number, failed: {file: string, error: string}[]}>}
 */
async function parseAndMount(files) {
  if (!isParserReady()) {
    setError("解析内核尚未就绪", "请等初始化完成后再拖入录像");
    return { ok: 0, failed: [] };
  }
  setError(null);

  const entries = [];
  const failed = [];

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    fileStates.set(f.name, "busy");
    setLoading(`正在解析 ${i + 1} / ${files.length} · ${f.name}`);
    try {
      const buf = await f.arrayBuffer();
      const data = await parseReplayBufferToData(buf);
      entries.push({ file: f.name, data });
      fileStates.set(f.name, "ok");
    } catch (e) {
      const msg = e?.message ?? String(e);
      failed.push({ file: f.name, error: msg });
      fileStates.set(f.name, "err");
    }
  }

  setLoading("");

  if (!entries.length) {
    setError("没有可显示的录像", failed.map((x) => `${x.file}：${x.error}`).join("；"));
    renderRailNote(`全部 ${files.length} 个文件解析失败`, "err");
    return { ok: 0, failed };
  }

  const { replays, failed: convFailed } = toLabReplays(entries);
  const allFailed = [...failed, ...convFailed];

  if (!replays.length) {
    setError("解析成功但无法组装成分析视图", allFailed.map((x) => `${x.file}：${x.error}`).join("；"));
    renderRailNote("装配失败", "err");
    return { ok: 0, failed: allFailed };
  }

  // ⚠️ 顺序很关键：必须**先让结果区可见，再 mountLab()**。
  // 视图层渲染 SVG 时要读容器 clientWidth 来定 viewBox，而 `display:none` 的元素
  // clientWidth 恒为 0 → viewBox 会停在代码里的最小值兜底（时间轴 420、图表 320），
  // 再叠加 `preserveAspectRatio="none"` → 整个内容（含刻度文字）被**横向拉伸 3 倍**。
  // 拖放区不能用 `show()`（那是切 class `on`）—— 它的显隐由 `parse_client.js` 直接写
  // `style.display` 控制，两套机制必须统一，否则加载完了拖放区还杵在上面。
  const dz = $("#dropZone");
  if (dz) dz.style.display = "none";
  show($("#result"), true);

  mountLab(replays);
  mountSandbox(replays); // 沙盘视图吃同一份数据（其中 r.sandbox 由 data.js 透传）
  watchResultWidth();

  // ⚠️ 这里原本会往左栏顶部写一条常态摘要（「已加载 N 份录像 · 原始序列含 M 个重复时刻 ·
  // 跨玩家对齐补点 K 个 …」）。按项目方要求撤掉：左栏顶部只在**确实加载不出来**时才出提示，
  // 正常加载不占这一行。这些数字仍有价值，自查走 `window.__lab` / `window.__sandbox`。

  if (allFailed.length) {
    setError(
      `${allFailed.length} 份录像没能加载`,
      allFailed.map((x) => `${x.file}：${x.error}`).join("；") + "。其余录像已正常显示",
    );
  }

  return { ok: replays.length, failed: allFailed };
}

/* ==========================================================================
   文件输入
   ========================================================================== */

const REPLAY_EXT = /\.(sc2replay)$/i;

function pickReplayFiles(list) {
  return [...list].filter((f) => REPLAY_EXT.test(f.name));
}

function bindFileInput() {
  const dropZone = $("#dropZone");
  const fileInput = $("#fileInput");

  if (dropZone && fileInput) {
    dropZone.addEventListener("click", () => fileInput.click());
    dropZone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileInput.click();
      }
    });
    dropZone.tabIndex = 0;
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("dragover");
    });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList.remove("dragover");
      handle(e.dataTransfer?.files ?? []);
    });
  }

  if (fileInput) {
    fileInput.addEventListener("change", (e) => {
      handle(e.target.files ?? []);
      e.target.value = ""; // 允许重复选同一个文件
    });
  }

  // 「＋ 添加录像」现在渲染在样本列表里当**第一张卡**（views.js::renderSamples），
  // 而列表每次重渲染都会重建它 —— 所以只能事件委托，直接绑元素撑不过第一次筛选。
  const samplesHost = $("#samples");
  if (samplesHost && fileInput) {
    samplesHost.addEventListener("click", (e) => {
      if (e.target.closest("#pickMore")) fileInput.click();
    });
  }

  function handle(list) {
    const files = pickReplayFiles(list);
    const all = [...list];
    if (!files.length) {
      setError("这些文件不是 .SC2Replay", all.map((f) => f.name).join("、"));
      return;
    }
    if (files.length < all.length) {
      const skipped = all.filter((f) => !REPLAY_EXT.test(f.name)).map((f) => f.name);
      setError("已跳过错扩展名的文件", skipped.join("、"));
    }
    parseAndMount(files);
  }

  // 整页拖放（拖到空白处也能用）
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    if (dropZone?.contains(e.target)) return;
    e.preventDefault();
    handle(e.dataTransfer?.files ?? []);
  });
}

/* ==========================================================================
   启动
   ========================================================================== */

async function boot() {
  setLoading("");
  setError(null);
  bindFileInput();
  initSandbox(); // 沙盘视图：绑控件 + 起主循环（无数据时空转，成本为零）

  // 本地部署提示只在 file:// 打开时出现；经 HTTP 访问的用户不应看到开发期提示
  if (location.protocol === "file:") {
    const hint = $("#localHint");
    if (hint) hint.style.display = "";
  }

  // 译名表与解析内核并行加载：译名表失败不阻塞分析（只是建造顺序显示英文原名）
  loadTranslationData();

  try {
    await initParser();
  } catch (e) {
    setError("解析内核初始化失败", e?.message ?? String(e));
    return;
  }

  if (!isParserReady()) {
    setError("解析内核未就绪", "请刷新页面重试");
    return;
  }
  // 左栏顶部的提示只服务于「加载不出来」这一件事，正常态不写 —— 见上方 sumReplays 里的注释。
}

boot();
