import { appState } from "./state.js";
import {
  BATCH_RAIL_WIDTH_LS,
  DEFAULT_BATCH_RAIL_WIDTH,
} from "./constants.js";
import {
  formatRealTime,
  escapeHtml,
  truncateStr,
  collectSc2ReplayFiles,
} from "./format_utils.js";
import { showError, hideError } from "./errors_init.js";
import { parseReplayBufferToData } from "./pyodide_boot.js";
import { displayResult } from "./display.js";

const batchReplayRail = () => document.getElementById("batchReplayRail");
const batchReplayRailInner = () => document.getElementById("batchReplayRailInner");
const batchRailResizeHandle = () => document.getElementById("batchRailResizeHandle");

function getBatchRailWidthBounds() {
  const max = Math.min(900, Math.max(320, window.innerWidth - 80));
  return { min: 240, max };
}

function readStoredBatchRailWidth() {
  try {
    const s = localStorage.getItem(BATCH_RAIL_WIDTH_LS);
    if (s != null) {
      const n = parseInt(s, 10);
      if (Number.isFinite(n)) return n;
    }
  } catch (_) {}
  return DEFAULT_BATCH_RAIL_WIDTH;
}

function clampBatchRailWidth(px) {
  const { min, max } = getBatchRailWidthBounds();
  return Math.min(max, Math.max(min, Math.round(px)));
}

export function applyBatchRailWidth(px) {
  const w = clampBatchRailWidth(px);
  document.documentElement.style.setProperty("--batch-rail-width", `${w}px`);
  return w;
}

function persistBatchRailWidth(px) {
  try { localStorage.setItem(BATCH_RAIL_WIDTH_LS, String(clampBatchRailWidth(px))); } catch (_) {}
}

export function setupBatchRailResize() {
  const h = batchRailResizeHandle();
  const rail = batchReplayRail();
  if (!h || !rail) return;
  const onPointerDown = (clientX) => {
    if (window.matchMedia("(max-width: 900px)").matches) return;
    rail.classList.add("batch-replay-rail--resizing");
    const rect = rail.getBoundingClientRect();
    const startW = rect.width;
    const startX = clientX;
    const onMove = (x) => {
      const dx = x - startX;
      applyBatchRailWidth(startW + dx);
    };
    const onMouseMove = (e) => { onMove(e.clientX); };
    const onTouchMove = (e) => {
      if (e.touches[0]) onMove(e.touches[0].clientX);
    };
    const end = () => {
      rail.classList.remove("batch-replay-rail--resizing");
      const raw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--batch-rail-width")) || DEFAULT_BATCH_RAIL_WIDTH;
      persistBatchRailWidth(raw);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", end);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", end);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", end);
    document.addEventListener("touchmove", onTouchMove, { passive: true });
    document.addEventListener("touchend", end);
  };
  h.addEventListener("mousedown", e => { e.preventDefault(); onPointerDown(e.clientX); });
  h.addEventListener("touchstart", e => {
    if (!e.touches[0]) return;
    e.preventDefault();
    onPointerDown(e.touches[0].clientX);
  }, { passive: false });
}

function setBatchRailVisible(on) {
  const rail = batchReplayRail();
  const inner = batchReplayRailInner();
  if (!rail) return;
  if (on && appState.batchItems.length) {
    rail.hidden = false;
    rail.classList.add("batch-replay-rail--visible");
    applyBatchRailWidth(readStoredBatchRailWidth());
  } else {
    rail.hidden = true;
    rail.classList.remove("batch-replay-rail--visible");
    rail.classList.remove("batch-replay-rail--resizing");
    rail.classList.remove("batch-replay-rail--collapsed");
    if (inner) inner.innerHTML = "";
  }
}

function formatBatchPlayersList(data) {
  const parts = [];
  if (Array.isArray(data.teams)) {
    for (const team of data.teams) {
      if (!team || !Array.isArray(team.players)) continue;
      for (const p of team.players) {
        const r = (p.race || "?").toString().charAt(0).toUpperCase();
        parts.push(`${p.name || "?"} (${r})`);
      }
    }
  }
  return parts.length ? parts.join("、") : "—";
}

function renderBatchCardHtml(item) {
  const id = item.id;
  const title = escapeHtml(truncateStr(item.fileName, 48));
  const titleAttr = escapeHtml(item.fileName);
  if (item.status === "loading") {
    return `<div class="batch-replay-card batch-replay-card--loading" data-batch-id="${id}">
          <div class="batch-replay-card-spinner" aria-hidden="true"></div>
          <div class="batch-replay-card-title" title="${titleAttr}">${title}</div>
          <div class="batch-replay-card-status">解析中…</div>
        </div>`;
  }
  if (item.status === "pending") {
    return `<div class="batch-replay-card batch-replay-card--pending" data-batch-id="${id}">
          <div class="batch-replay-card-title" title="${titleAttr}">${title}</div>
          <div class="batch-replay-card-status">等待中…</div>
        </div>`;
  }
  if (item.status === "error") {
    return `<div class="batch-replay-card batch-replay-card--error" data-batch-id="${id}">
          <div class="batch-replay-card-title" title="${titleAttr}">${title}</div>
          <div class="batch-replay-card-status">${escapeHtml(item.errorMsg || "解析失败")}</div>
        </div>`;
  }
  const d = item.fullData;
  const sel = id === appState.batchSelectedId ? " batch-replay-card--selected" : "";
  const map = d.map_name || "Unknown";
  const len = formatRealTime(d.game_length || 0);
  const region = d.region ? String(d.region) : "—";
  const ver = d.client_version ? String(d.client_version) : "—";
  const winner = d.winner ? String(d.winner) : "—";
  const players = formatBatchPlayersList(d);
  return `<button type="button" class="batch-replay-card batch-replay-card--done${sel}" data-batch-id="${id}">
        <div class="batch-replay-card-title" title="${titleAttr}">${title}</div>
        <dl class="batch-replay-card-dl">
          <dt>地图</dt><dd>${escapeHtml(map)}</dd>
          <dt>玩家</dt><dd>${escapeHtml(players)}</dd>
          <dt>胜者</dt><dd>${escapeHtml(winner)}</dd>
          <dt>时长</dt><dd>${escapeHtml(len)}</dd>
          <dt>区域</dt><dd>${escapeHtml(region)}</dd>
          <dt>版本</dt><dd>${escapeHtml(ver)}</dd>
        </dl>
      </button>`;
}

function getFilteredBatchItems() {
  const keyword = String(appState.batchSearchKeyword || "").trim().toLowerCase();
  if (!keyword) return appState.batchItems;
  return appState.batchItems.filter(item => {
    const base = [item.fileName || ""];
    if (item.status === "done" && item.fullData) {
      base.push(item.fullData.map_name || "");
      base.push(item.fullData.winner || "");
      base.push(formatBatchPlayersList(item.fullData));
    }
    const haystack = base.join(" ").toLowerCase();
    return haystack.includes(keyword);
  });
}

function renderBatchRail() {
  const inner = batchReplayRailInner();
  const rail = batchReplayRail();
  if (!inner || !rail) return;
  const collapsed = !!appState.batchRailCollapsed;
  rail.classList.toggle("batch-replay-rail--collapsed", collapsed);
  const filteredItems = getFilteredBatchItems();
  const head = `<div class="batch-replay-rail-head">
      <div class="batch-replay-rail-head-top">
        <strong>批量录像（${appState.batchItems.length}）</strong>
        <button
          id="batchRailToggle"
          class="batch-replay-rail-toggle"
          type="button"
          title="${collapsed ? "展开侧栏" : "收起侧栏"}"
          aria-expanded="${collapsed ? "false" : "true"}"
        >${collapsed ? "展开" : "收起"}</button>
      </div>
      <span class="batch-replay-rail-hint">文件较多时请耐心等待</span>
      <input
        id="batchRailSearch"
        class="batch-replay-rail-search"
        type="search"
        value="${escapeHtml(appState.batchSearchKeyword || "")}"
        placeholder="搜索 文件名/地图/玩家"
      />
    </div>`;
  const cards = filteredItems.map(renderBatchCardHtml).join("");
  const cardsBody = cards || `<div class="batch-replay-card batch-replay-card--pending"><div class="batch-replay-card-status">无匹配结果</div></div>`;
  inner.innerHTML = head + `<div class="batch-replay-rail-cards">${cardsBody}</div>`;
  const toggleBtn = document.getElementById("batchRailToggle");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      appState.batchRailCollapsed = !appState.batchRailCollapsed;
      renderBatchRail();
    });
  }
  if (collapsed) return;
  const searchInput = document.getElementById("batchRailSearch");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      appState.batchSearchKeyword = searchInput.value || "";
      renderBatchRail();
    });
  }
  rail.querySelectorAll(".batch-replay-card--done").forEach(btn => {
    btn.addEventListener("click", onBatchCardClick);
  });
}

function onBatchCardClick(ev) {
  const btn = ev.currentTarget;
  const id = parseInt(btn.getAttribute("data-batch-id"), 10);
  if (!Number.isFinite(id)) return;
  const item = appState.batchItems.find(x => x.id === id);
  if (!item || item.status !== "done" || !item.fullData) return;
  appState.batchSelectedId = id;
  appState.lastData = item.fullData;
  appState.lastFileMeta = { name: item.fileName, size: item.size };
  appState.lastFile = item.fileRef || null;
  hideError();
  displayResult(item.fullData);
  renderBatchRail();
}

export async function processBatchFiles(files) {
  if (!appState.pyodide) {
    showError("解析环境尚未就绪，请稍候再试");
    return;
  }
  const replayFiles = collectSc2ReplayFiles(files);
  if (!replayFiles.length) {
    showError("请上传 .SC2Replay 文件");
    return;
  }
  hideError();
  appState.lastFile = null;
  appState.batchSearchKeyword = "";
  appState.batchRailCollapsed = false;
  appState.batchItems = replayFiles.map(f => ({
    id: ++appState.batchIdSeq,
    fileName: f.name,
    size: f.size,
    fileRef: f,
    status: "pending",
    errorMsg: null,
    fullData: null,
  }));
  setBatchRailVisible(true);
  renderBatchRail();

  let lastSuccess = null;
  const resultEl = document.getElementById("result");
  for (let i = 0; i < replayFiles.length; i++) {
    const f = replayFiles[i];
    const item = appState.batchItems[i];
    item.status = "loading";
    renderBatchRail();
    try {
      const buffer = await f.arrayBuffer();
      const data = await parseReplayBufferToData(buffer);
      item.status = "done";
      item.fullData = data;
      lastSuccess = { item, data };
    } catch (err) {
      console.error(err);
      item.status = "error";
      item.errorMsg = (err && err.message) ? err.message : "解析失败";
    }
    renderBatchRail();
  }

  if (lastSuccess) {
    appState.batchSelectedId = lastSuccess.item.id;
    appState.lastData = lastSuccess.data;
    appState.lastFileMeta = { name: lastSuccess.item.fileName, size: lastSuccess.item.size };
    appState.lastFile = lastSuccess.item.fileRef || null;
    displayResult(lastSuccess.data);
  } else {
    appState.lastFile = null;
    showError("全部录像解析失败");
    if (resultEl) resultEl.classList.remove("visible");
  }
}

export { readStoredBatchRailWidth, DEFAULT_BATCH_RAIL_WIDTH };
