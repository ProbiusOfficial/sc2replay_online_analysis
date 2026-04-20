import { appState } from "./state.js";
import { SHARE_API_BASE_URL } from "./constants.js";
import { loadTranslationData, showError, hideError } from "./errors_init.js";
import { initPyodide, parseReplayBufferToData } from "./pyodide_boot.js";
import { displayResult } from "./display.js";
import { initVoiceReader } from "./voice_reader.js";
import { trackEvent } from "./telemetry.js";
import { escapeHtml } from "./format_utils.js";

const CACHE_KEY_PREFIX = "sc2ReplayLibraryCacheV1";
const CACHE_TTL_MS = 5 * 60 * 1000;

const libraryState = {
  all: [],
  filtered: [],
};

function buildReplayShareUrl(md5) {
  const url = new URL(window.location.href);
  url.pathname = url.pathname.replace(/\/[^/]*$/, "/replays.html");
  url.search = "";
  url.searchParams.set("md5", String(md5 || "").trim());
  url.hash = "";
  return url.toString();
}

function buildShareCopyText(message, url) {
  const safeMessage = String(message || "").trim() || "无留言";
  return `我分享了一个录像，关于${safeMessage}，快来sc2replayAnalysis 看看吧：${url}`;
}

async function copyTextToClipboard(text) {
  const copyText = String(text || "");
  if (!copyText) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(copyText);
      return true;
    }
  } catch (_) {}
  try {
    const ta = document.createElement("textarea");
    ta.value = copyText;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return !!ok;
  } catch (_) {
    return false;
  }
}

function getMd5FromUrl() {
  try {
    const raw = new URL(window.location.href).searchParams.get("md5");
    const text = String(raw || "").trim().toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(text)) return "";
    return text;
  } catch (_) {
    return "";
  }
}

function sanitizeFilenamePart(text) {
  return String(text || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

function buildReplayDownloadName(item, md5) {
  const players = Array.isArray(item?.players) ? item.players.filter(Boolean).map(String) : [];
  const map = sanitizeFilenamePart(item?.map || "UnknownMap") || "UnknownMap";
  let playersPart = "UnknownA_vs_UnknownB";
  if (players.length >= 2) {
    playersPart = `${sanitizeFilenamePart(players[0])}vs${sanitizeFilenamePart(players[1])}`;
  } else if (players.length === 1) {
    playersPart = `${sanitizeFilenamePart(players[0])}vsUnknown`;
  }
  let base = `${playersPart}+${map}`;
  if (!base || base === "+") base = String(md5 || "replay").trim();
  if (base.length > 120) base = base.slice(0, 120);
  return `${base}.SC2Replay`;
}

function setLibraryStatus(text, isWarn = false) {
  const statusEl = document.getElementById("libraryStatus");
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.classList.toggle("replay-library-status--warn", !!isWarn);
}

function bindToggle(id, setter) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("change", e => {
    setter(!!e.target.checked);
    if (appState.lastData) displayResult(appState.lastData, { hideShareUpload: true });
  });
}

function bindResultControls() {
  bindToggle("showUpgrades", v => { appState.showUpgrades = v; });
  bindToggle("showOriginal", v => { appState.showOriginal = v; });
  bindToggle("showWorkers", v => { appState.showWorkers = v; });
  bindToggle("mergeSameActions", v => { appState.mergeSameActions = v; });
  bindToggle("showWorkerDeaths", v => { appState.showWorkerDeaths = v; });
  const chatToggle = document.getElementById("chatToggle");
  const chatPanel = document.getElementById("chatPanel");
  if (chatToggle) {
    chatToggle.addEventListener("click", () => {
      if (!appState.lastData || !Array.isArray(appState.lastData.chat) || !appState.lastData.chat.length) return;
      appState.chatVisible = !appState.chatVisible;
      if (chatPanel) chatPanel.style.display = appState.chatVisible ? "block" : "none";
      chatToggle.textContent = appState.chatVisible ? "收起对局聊天" : "查看对局聊天";
    });
  }
}

function currentQuery() {
  return (document.getElementById("searchKeyword")?.value || "").trim();
}

function currentSort() {
  return document.getElementById("sortMode")?.value || "latest";
}

function getApiBase() {
  const pickBase = () => {
    try {
      if (window?.SC2_SHARE_API_BASE_URL) return String(window.SC2_SHARE_API_BASE_URL).trim();
    } catch (_) {}
    return String(SHARE_API_BASE_URL || "").trim();
  };
  const rawBase = pickBase().replace(/\/$/, "");
  if (!rawBase) return "";
  // 兼容 //host:port 这类协议相对写法
  if (rawBase.startsWith("//")) return `${window.location.protocol}${rawBase}`;
  // HTTPS 页面禁止请求 HTTP 资源，自动尝试升级协议
  if (window.location.protocol === "https:" && rawBase.startsWith("http://")) {
    return `https://${rawBase.slice("http://".length)}`;
  }
  try {
    const normalized = new URL(rawBase, window.location.origin);
    return normalized.toString().replace(/\/$/, "");
  } catch (_) {}
  return rawBase;
}

function buildPublicListUrl() {
  const q = encodeURIComponent(currentQuery());
  const sort = encodeURIComponent(currentSort());
  return `${getApiBase()}/api/public/replays?q=${q}&sort=${sort}`;
}

function cacheKey(q, sort) {
  return `${CACHE_KEY_PREFIX}:${encodeURIComponent(q || "")}:${sort || "latest"}`;
}

function cacheSet(items, q, sort) {
  const payload = {
    items,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };
  try {
    localStorage.setItem(cacheKey(q, sort), JSON.stringify(payload));
  } catch (_) {}
}

function cacheGet(q, sort) {
  try {
    const raw = localStorage.getItem(cacheKey(q, sort));
    if (!raw) return null;
    const payload = JSON.parse(raw);
    if (!payload || !Array.isArray(payload.items)) return null;
    if (Number(payload.expiresAt || 0) < Date.now()) return null;
    return payload.items;
  } catch (_) {
    return null;
  }
}

function renderLibraryList() {
  const listEl = document.getElementById("libraryList");
  if (!listEl) return;
  if (!libraryState.filtered.length) {
    setLibraryStatus("没有匹配到录像");
    listEl.innerHTML = "";
    return;
  }
  setLibraryStatus(`共 ${libraryState.filtered.length} 条录像`);
  listEl.innerHTML = libraryState.filtered.map(item => {
    const map = escapeHtml(item.map || "Unknown");
    const players = escapeHtml(Array.isArray(item.players) ? item.players.join("、") : "—");
    const winner = escapeHtml(item.winner || "—");
    const region = escapeHtml(item.region || "—");
    const version = escapeHtml(item.clientVersion || "—");
    const msg = escapeHtml(item.message || "无留言");
    const likes = Number(item.likes || 0);
    const pinBadge = item.isPinned ? "<span class=\"replay-library-pin\">置顶</span>" : "";
    const md5 = item.md5 || "";
    const tags = Array.isArray(item.tags) ? item.tags.filter(Boolean).slice(0, 3) : [];
    const tagsHtml = tags.length
      ? tags.map(tag => `<span class="replay-library-tag">${escapeHtml(String(tag))}</span>`).join("")
      : "<span class=\"replay-library-tag replay-library-tag--empty\">无标签</span>";
    return `<div class="replay-library-item">
      <div class="replay-library-item-main">
        <div class="replay-library-item-title">${pinBadge}${map}</div>
        <div class="replay-library-item-meta">玩家：${players}</div>
        <div class="replay-library-item-meta">胜者：${winner} · 区域：${region} · 版本：${version}</div>
        <div class="replay-library-item-meta">留言：${msg}</div>
        <div class="replay-library-item-tags">${tagsHtml}</div>
      </div>
      <div class="replay-library-item-actions">
        <span class="replay-library-like-count">❤ ${likes}</span>
        <button type="button" data-action="view" data-md5="${md5}">查看解析</button>
        <button type="button" data-action="download" data-md5="${md5}">下载</button>
        <button type="button" data-action="share" data-md5="${md5}">分享</button>
        <button type="button" data-action="like" data-md5="${md5}" class="replay-library-like-btn">❤ 喜欢</button>
      </div>
    </div>`;
  }).join("");
  listEl.querySelectorAll("button[data-action='view']").forEach(btn => {
    btn.addEventListener("click", () => {
      const md5 = btn.getAttribute("data-md5");
      if (md5) void loadReplayByMd5(md5);
    });
  });
  listEl.querySelectorAll("button[data-action='like']").forEach(btn => {
    btn.addEventListener("click", () => {
      const md5 = btn.getAttribute("data-md5");
      if (md5) void likeReplay(md5);
    });
  });
  listEl.querySelectorAll("button[data-action='share']").forEach(btn => {
    btn.addEventListener("click", () => {
      const md5 = btn.getAttribute("data-md5");
      if (md5) void shareReplay(md5);
    });
  });
  listEl.querySelectorAll("button[data-action='download']").forEach(btn => {
    btn.addEventListener("click", () => {
      const md5 = btn.getAttribute("data-md5");
      if (md5) void downloadReplay(md5);
    });
  });
}

async function loadIndex() {
  const q = currentQuery();
  const sort = currentSort();
  const cachedItems = cacheGet(q, sort);
  if (cachedItems) {
    libraryState.all = cachedItems;
    libraryState.filtered = [...cachedItems];
    renderLibraryList();
    setLibraryStatus(`缓存命中，共 ${cachedItems.length} 条`);
    return;
  }

  setLibraryStatus("正在拉取共享索引...");
  const resp = await fetch(buildPublicListUrl(), { cache: "no-cache" });
  if (!resp.ok) throw new Error(`索引拉取失败（HTTP ${resp.status}）`);
  const rows = await resp.json();
  libraryState.all = Array.isArray(rows?.items) ? rows.items : [];
  libraryState.filtered = [...libraryState.all];
  cacheSet(libraryState.all, q, sort);
  renderLibraryList();
}

async function refreshListByQuery() {
  const q = currentQuery();
  const sort = currentSort();
  setLibraryStatus("检索中...");
  const resp = await fetch(buildPublicListUrl(), { cache: "no-cache" });
  if (!resp.ok) throw new Error(`检索失败（HTTP ${resp.status}）`);
  const rows = await resp.json();
  libraryState.all = Array.isArray(rows?.items) ? rows.items : [];
  libraryState.filtered = [...libraryState.all];
  cacheSet(libraryState.all, q, sort);
  renderLibraryList();
}

async function loadReplayByMd5(md5) {
  if (!appState.pyodide) {
    showError("解析环境尚未就绪，请稍候再试");
    return;
  }
  const loading = document.getElementById("loading");
  hideError();
  if (loading) loading.classList.add("visible");
  try {
    const replayUrl = `${getApiBase()}/api/public/replays/${md5}/file`;
    const resp = await fetch(replayUrl, { cache: "no-cache" });
    if (!resp.ok) throw new Error(`录像拉取失败（HTTP ${resp.status}）`);
    const blob = await resp.blob();
    if (blob.size > 1024 * 1024) throw new Error("共享录像超过 1MB 限制");
    const file = new File([blob], `${md5}.SC2Replay`, { type: "application/octet-stream" });
    appState.lastFile = file;
    appState.lastFileMeta = { name: file.name, size: file.size };
    const buffer = await file.arrayBuffer();
    const data = await parseReplayBufferToData(buffer);
    appState.lastData = data;
    displayResult(data, { hideShareUpload: true });
    trackEvent("library_replay_loaded", { md5 });
  } catch (err) {
    console.error(err);
    showError(err?.message || "拉取录像失败");
    trackEvent("library_replay_load_failed", { md5, detail: err?.message || "unknown" });
  } finally {
    if (loading) loading.classList.remove("visible");
  }
}

async function likeReplay(md5) {
  try {
    const resp = await fetch(`${getApiBase()}/api/public/replays/${md5}/like`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      if (resp.status === 429) {
        const remain = Math.max(1, Number(payload?.retryAfterSeconds || 1));
        setLibraryStatus(`点赞太快了，请 ${remain} 秒后再试`, true);
        return;
      }
      throw new Error(payload?.detail || `点赞失败（HTTP ${resp.status}）`);
    }
    const likes = Number(payload?.likes || 0);
    const item = libraryState.all.find(row => String(row.md5) === String(md5));
    if (item) item.likes = likes;
    setLibraryStatus("点赞成功");
    cacheSet(libraryState.all, currentQuery(), currentSort());
    renderLibraryList();
    const nextLikeBtn = document.querySelector(`button[data-action='like'][data-md5='${md5}']`);
    if (nextLikeBtn) {
      nextLikeBtn.classList.remove("is-liked-anim");
      // 强制 reflow，确保连续点击可重复触发动画
      void nextLikeBtn.offsetWidth;
      nextLikeBtn.classList.add("is-liked-anim");
    }
  } catch (err) {
    showError(err?.message || "点赞失败");
  }
}

async function shareReplay(md5) {
  const item = libraryState.all.find(row => String(row.md5) === String(md5));
  const url = buildReplayShareUrl(md5);
  const text = buildShareCopyText(item?.message, url);
  const copied = await copyTextToClipboard(text);
  if (copied) {
    setLibraryStatus("分享文案已复制，可直接发送给好友");
  } else {
    setLibraryStatus(`复制失败，请手动复制链接：${url}`, true);
  }
  trackEvent("library_replay_shared", {
    md5,
    copied,
  });
}

async function downloadReplay(md5) {
  const item = libraryState.all.find(row => String(row.md5) === String(md5));
  const filename = buildReplayDownloadName(item, md5);
  try {
    setLibraryStatus("下载中...");
    const replayUrl = `${getApiBase()}/api/public/replays/${md5}/file`;
    const resp = await fetch(replayUrl, { cache: "no-cache" });
    if (!resp.ok) throw new Error(`下载失败（HTTP ${resp.status}）`);
    const blob = await resp.blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);
    setLibraryStatus(`已开始下载：${filename}`);
    trackEvent("library_replay_downloaded", { md5, filename });
  } catch (err) {
    setLibraryStatus(err?.message || "下载失败", true);
  }
}

function bindSearch() {
  const searchBtn = document.getElementById("searchBtn");
  const searchInput = document.getElementById("searchKeyword");
  const sortMode = document.getElementById("sortMode");

  if (searchBtn) {
    searchBtn.addEventListener("click", () => {
      void refreshListByQuery().catch(err => showError(err?.message || "检索失败"));
    });
  }
  if (searchInput) {
    searchInput.addEventListener("keydown", e => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      void refreshListByQuery().catch(err => showError(err?.message || "检索失败"));
    });
  }
  if (sortMode) {
    sortMode.addEventListener("change", () => {
      void refreshListByQuery().catch(err => showError(err?.message || "检索失败"));
    });
  }
}

function resetCacheOnLoad() {
  const cached = cacheGet(currentQuery(), currentSort());
  if (!cached) {
    try {
      const prefix = `${CACHE_KEY_PREFIX}:`;
      Object.keys(localStorage).forEach(key => {
        if (key.startsWith(prefix)) localStorage.removeItem(key);
      });
    } catch (_) {}
  }
}

async function main() {
  const directMd5 = getMd5FromUrl();
  initVoiceReader();
  bindResultControls();
  bindSearch();
  resetCacheOnLoad();
  await loadTranslationData();
  await initPyodide();
  await loadIndex();
  if (directMd5) {
    setLibraryStatus("检测到分享链接，正在拉取指定录像...");
    await loadReplayByMd5(directMd5);
  }
}

main().catch(err => {
  console.error(err);
  showError(err?.message || "共享页面初始化失败");
});
