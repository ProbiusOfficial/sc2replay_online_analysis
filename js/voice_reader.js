import { appState } from "./state.js";
import { GAME_TIME_FACTOR, SC2_FASTER_REAL_FACTOR, VOICE_PIP_FONT_LS } from "./constants.js";
import { formatGameTime } from "./format_utils.js";
import {
  itemIsTechUpgrade,
  getDisplayUnitText,
  compareBuildOrderItems,
} from "./display_helpers.js";

const synth = window.speechSynthesis;

function voiceReaderEl() { return document.getElementById("voiceReader"); }

export function setVoiceReaderVisibleLayout() {
  const voiceReader = voiceReaderEl();
  if (!voiceReader) return;
  voiceReader.style.display = "flex";
  voiceReader.style.flexDirection = "column";
  voiceReader.style.alignItems = "stretch";
}

function applyVoicePipFontScaleFromUI() {
  const voicePipFontScaleInput = document.getElementById("voicePipFontScale");
  const voiceReader = voiceReaderEl();
  const voicePipFontScaleVal = document.getElementById("voicePipFontScaleVal");
  if (!voicePipFontScaleInput || !voiceReader) return;
  let pct = parseInt(voicePipFontScaleInput.value, 10);
  if (!Number.isFinite(pct)) pct = 100;
  pct = Math.max(75, Math.min(150, pct));
  const scale = pct / 100;
  voiceReader.style.setProperty("--voice-pip-font-scale", String(scale));
  if (voicePipFontScaleVal) voicePipFontScaleVal.textContent = `${pct}%`;
  try { localStorage.setItem(VOICE_PIP_FONT_LS, String(pct)); } catch (_) {}
}

function initVoicePipFontScale() {
  const voicePipFontScaleInput = document.getElementById("voicePipFontScale");
  const voiceReader = voiceReaderEl();
  if (!voicePipFontScaleInput || !voiceReader) return;
  let pct = 100;
  try {
    const s = localStorage.getItem(VOICE_PIP_FONT_LS);
    if (s != null) {
      const n = parseInt(s, 10);
      if (Number.isFinite(n)) pct = Math.max(75, Math.min(150, n));
    }
  } catch (_) {}
  voicePipFontScaleInput.value = String(pct);
  applyVoicePipFontScaleFromUI();
}

export function setupVoiceButtons(data) {
  const buildOrders = document.getElementById("buildOrders");
  if (!buildOrders) return;
  const panels = buildOrders.querySelectorAll(".player-panel");
  let count = 0;
  data.teams.forEach(team => {
    team.players.forEach(player => {
      const panel = panels[count];
      if (panel) {
        const header = panel.querySelector(".player-header");
        const btn = document.createElement("button");
        btn.type = "button"; btn.className = "voice-reader-btn";
        btn.innerHTML = "<span>🔊</span>语音播报";
        btn.onclick = () => openVoiceReader(player);
        header.insertBefore(btn, header.querySelector(".export-btn"));
      }
      count++;
    });
  });
}

/** 语音用较短读法：星空加速类为「加速加建筑」；英文原名为 Chrono + 目标 */
function buildVoiceSpeechLine(it) {
  let s = String(it.text || "").replace(/^\d+\s+/, "").replace(/\[.*?s\]/, "");
  if (!it._recall) return s;
  const chronoZh = s.match(/^\s*星空加速\s*(?:→|->)\s*(.+)$/);
  if (chronoZh) return `加速加${chronoZh[1].trim()}`;
  if (/^\s*星空加速\s*$/.test(s)) return "加速";
  if (appState.showOriginal) {
    const parts = s.split(/\s*(?:→|->)\s*/);
    if (parts.length >= 2) return `Chrono ${parts[parts.length - 1].trim()}`;
    if (it._target && String(it._target).trim()) return `Chrono ${String(it._target).trim()}`;
  }
  return s;
}

export function openVoiceReader(player) {
  if (!player) return;
  const voicePlayerName = document.getElementById("voice-player-name");
  appState.currentVoicePlayer = player;
  if (voicePlayerName) voicePlayerName.textContent = `Build Order Reader - ${player.name}`;
  let items = [...(player.build_order || [])];
  if (!appState.showWorkers) items = items.filter(it => !it.is_worker);
  if (!appState.showUpgrades) items = items.filter(it => !itemIsTechUpgrade(it));
  items.sort(compareBuildOrderItems);

  let processed = items.map(it => ({
    time: (it.start_time / GAME_TIME_FACTOR) * SC2_FASTER_REAL_FACTOR,
    text: getDisplayUnitText(it),
    _recall: it._kind === "recall",
    _target: it._kind === "recall" ? (it.target || "") : "",
  }));

  if (appState.mergeSameActions) {
    const merged = []; let cur = null, cnt = 0;
    const flush = () => { if (!cur) return; merged.push({ ...cur, text: cnt > 1 ? `${cur.text} ×${cnt}` : cur.text }); };
    processed.forEach(it => {
      if (!cur || cur.time !== it.time || cur.text !== it.text) { flush(); cur = it; cnt = 1; } else cnt++;
    });
    flush(); processed = merged;
  }

  appState.voiceSteps = processed.map(it => ({
    time: it.time,
    text: it.text,
    speech: buildVoiceSpeechLine(it),
  }));
  resetVoice();
  setVoiceReaderVisibleLayout();
}

function speak(content) {
  if (!content) return;
  try { synth.cancel(); } catch (_) {}
  const voiceRateInput = document.getElementById("voiceRate");
  const voiceLangSelect = document.getElementById("voiceLang");
  const u = new SpeechSynthesisUtterance(content);
  u.volume = 1; u.rate = parseFloat(voiceRateInput && voiceRateInput.value); u.lang = voiceLangSelect && voiceLangSelect.value;
  synth.speak(u);
}

function voiceStepGameClockStr(idx) {
  if (idx < 0 || idx >= appState.voiceSteps.length) return "";
  const rawStart = (appState.voiceSteps[idx].time / SC2_FASTER_REAL_FACTOR) * GAME_TIME_FACTOR;
  return formatGameTime(rawStart);
}

function syncVoicePipTransport() {
  const voicePipBtnStart = document.getElementById("voicePipBtnStart");
  const voicePipBtnPause = document.getElementById("voicePipBtnPause");
  if (!voicePipBtnStart || !voicePipBtnPause) return;
  const hasSteps = appState.voiceSteps.length > 0;
  voicePipBtnStart.disabled = appState.voiceIsRunning || !hasSteps;
  voicePipBtnPause.disabled = !appState.voiceIsRunning;
}

function updateVoiceUI(currentTime) {
  const voiceTimer = document.getElementById("voice-timer");
  const voiceTimerPip = document.getElementById("voice-timer-pip");
  const vQ_2 = document.getElementById("v-q-2");
  const vQ_1 = document.getElementById("v-q-1");
  const vQ0 = document.getElementById("v-q0");
  const vQ1 = document.getElementById("v-q1");
  const vQ2 = document.getElementById("v-q2");
  const voicePipStepText = document.getElementById("voice-pip-step-text");
  const voicePipStepTime = document.getElementById("voice-pip-step-time");
  const voicePipContext = document.getElementById("voice-pip-context");
  const voiceTimelineBar = document.getElementById("voice-timeline-bar");

  const gs = Math.round(currentTime / SC2_FASTER_REAL_FACTOR);
  const clockStr = `${String(Math.floor(gs / 60)).padStart(2, "0")}:${String(Math.floor(gs % 60)).padStart(2, "0")}`;
  if (voiceTimer) voiceTimer.textContent = clockStr;
  if (voiceTimerPip) voiceTimerPip.textContent = clockStr;
  if (vQ_2) vQ_2.innerText = appState.voiceCurrentIndex > 1 ? appState.voiceSteps[appState.voiceCurrentIndex - 2].text : "";
  if (vQ_1) vQ_1.innerText = appState.voiceCurrentIndex > 0 ? appState.voiceSteps[appState.voiceCurrentIndex - 1].text : "";
  if (vQ0) vQ0.innerText = appState.voiceCurrentIndex === -1 ? "准备就绪" : appState.voiceSteps[appState.voiceCurrentIndex].text;
  if (vQ1) vQ1.innerText = appState.voiceSteps[appState.voiceCurrentIndex + 1]?.text || "";
  if (vQ2) vQ2.innerText = appState.voiceSteps[appState.voiceCurrentIndex + 2]?.text || "";
  if (voicePipStepText && voicePipStepTime) {
    if (appState.voiceCurrentIndex === -1) {
      voicePipStepTime.textContent = "";
      voicePipStepText.textContent = "准备就绪";
    } else {
      voicePipStepTime.textContent = voiceStepGameClockStr(appState.voiceCurrentIndex);
      voicePipStepText.textContent = appState.voiceSteps[appState.voiceCurrentIndex].text;
    }
  }
  if (voicePipContext) {
    const chunks = [];
    if (appState.voiceCurrentIndex > 0) {
      chunks.push(`${voiceStepGameClockStr(appState.voiceCurrentIndex - 1)} ${appState.voiceSteps[appState.voiceCurrentIndex - 1].text}`);
    }
    const nextStart = appState.voiceCurrentIndex === -1 ? 0 : 1;
    const nextEnd = appState.voiceCurrentIndex === -1 ? 3 : 4;
    for (let k = nextStart; k < nextEnd; k++) {
      const idx = appState.voiceCurrentIndex + k;
      if (idx >= 0 && idx < appState.voiceSteps.length) {
        chunks.push(`${voiceStepGameClockStr(idx)} ${appState.voiceSteps[idx].text}`);
      }
    }
    voicePipContext.textContent = chunks.join(" · ");
  }
  syncVoicePipTransport();
  if (appState.voiceSteps.length && voiceTimelineBar) {
    const total = appState.voiceSteps[appState.voiceSteps.length - 1].time + 10;
    voiceTimelineBar.style.width = (currentTime / total) * 100 + "%";
  }
}

function updateVoice() {
  if (!appState.voiceIsRunning) return;
  const voiceStepBar = document.getElementById("voice-step-bar");
  const now = (Date.now() - appState.voiceStartTime) / 1000;
  for (let i = 0; i < appState.voiceSteps.length; i++) {
    if (now >= appState.voiceSteps[i].time && appState.voiceCurrentIndex < i) {
      appState.voiceCurrentIndex = i;
      speak(appState.voiceSteps[i].speech);
      updateVoiceUI(now);
      break;
    }
  }
  if (appState.voiceCurrentIndex < appState.voiceSteps.length - 1) {
    const next = appState.voiceSteps[appState.voiceCurrentIndex + 1].time;
    const prev = appState.voiceCurrentIndex === -1 ? 0 : appState.voiceSteps[appState.voiceCurrentIndex].time;
    if (voiceStepBar) voiceStepBar.style.width = Math.max(0, Math.min(100, ((now - prev) / (next - prev)) * 100)) + "%";
  } else if (voiceStepBar) voiceStepBar.style.width = "100%";
  updateVoiceUI(now);
}

function voiceTimerTargetWindow() {
  try {
    if (appState.pipWindow && !appState.pipWindow.closed) return appState.pipWindow;
  } catch (_) {}
  return window;
}

function startVoiceTimer() {
  stopVoiceTimer();
  appState.voiceIntervalWindow = voiceTimerTargetWindow();
  appState.voiceTimerId = appState.voiceIntervalWindow.setInterval(updateVoice, 50);
}
function stopVoiceTimer() {
  if (appState.voiceTimerId != null && appState.voiceIntervalWindow) {
    try { appState.voiceIntervalWindow.clearInterval(appState.voiceTimerId); } catch (_) {}
  }
  appState.voiceTimerId = null;
  appState.voiceIntervalWindow = null;
}

function rebindVoiceTimerIfRunning() {
  if (!appState.voiceIsRunning) return;
  stopVoiceTimer();
  startVoiceTimer();
}

/** silentSeek：拖动时间轴时为 true，只同步时间与 UI，不播报；松手后再播，避免连续 cancel/speak 导致错乱 */
function jumpVoiceTo(t, silentSeek = false) {
  try { synth.cancel(); } catch (_) {}
  appState.voicePausedTime = Math.max(0, t);
  appState.voiceStartTime = Date.now() - appState.voicePausedTime * 1000;
  appState.voiceCurrentIndex = -1;
  for (let i = 0; i < appState.voiceSteps.length; i++) {
    if (appState.voicePausedTime >= appState.voiceSteps[i].time) appState.voiceCurrentIndex = i;
    else break;
  }
  updateVoiceUI(appState.voicePausedTime);
  if (!silentSeek && appState.voiceIsRunning && appState.voiceCurrentIndex !== -1) speak(appState.voiceSteps[appState.voiceCurrentIndex].speech);
}

function toggleVoicePlay() {
  const voicePlayBtn = document.getElementById("voicePlay");
  if (appState.voiceIsRunning) {
    appState.voiceIsRunning = false; appState.voicePausedTime = (Date.now() - appState.voiceStartTime) / 1000;
    stopVoiceTimer(); if (voicePlayBtn) voicePlayBtn.innerText = "继续 (Alt+↑)"; synth.pause();
  } else {
    appState.voiceStartTime = Date.now() - appState.voicePausedTime * 1000;
    appState.voiceIsRunning = true; startVoiceTimer(); if (voicePlayBtn) voicePlayBtn.innerText = "暂停 (Alt+↑)"; synth.resume();
  }
  syncVoicePipTransport();
}
function resetVoice() {
  const voicePlayBtn = document.getElementById("voicePlay");
  const voiceStepBar = document.getElementById("voice-step-bar");
  appState.voiceIsRunning = false; appState.voicePausedTime = 0; appState.voiceCurrentIndex = -1;
  stopVoiceTimer(); synth.cancel();
  if (voiceStepBar) voiceStepBar.style.width = "0%"; if (voicePlayBtn) voicePlayBtn.innerText = "开始 (Alt+↑)"; updateVoiceUI(0);
}
function stopVoice() { appState.voiceIsRunning = false; stopVoiceTimer(); synth.cancel(); }

async function requestPiP() {
  const pipBtn = document.getElementById("pipBtn");
  const voiceReader = voiceReaderEl();
  const voiceReaderMain = document.querySelector(".voice-reader-main");
  const voiceBarsHost = document.getElementById("voiceBarsHost");
  const voicePlayBtn = document.getElementById("voicePlay");
  const voicePipFooterBars = document.querySelector(".voice-pip-footer-bars");
  if ("documentPictureInPicture" in window) {
    try {
      if (appState.pipWindow) { appState.pipWindow.close(); return; }
      appState.pipWindow = await window.documentPictureInPicture.requestWindow({ width: 560, height: 120 });
      appState.pipWindow.document.documentElement.style.cssText = "height:100%;margin:0;background:#0d1117";
      appState.pipWindow.document.body.style.cssText = "background:#0d1117;padding:0;margin:0;height:100%;min-height:100%;display:flex;flex-direction:column;overflow:hidden;pointer-events:auto;touch-action:manipulation;-webkit-user-select:text;user-select:text";
      Array.from(document.styleSheets).forEach(sheet => {
        try {
          const rules = Array.from(sheet.cssRules).map(r => r.cssText).join("");
          const s = document.createElement("style"); s.textContent = rules;
          appState.pipWindow.document.head.appendChild(s);
        } catch { if (sheet.href) { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = sheet.href; appState.pipWindow.document.head.appendChild(l); } }
      });
      const pipCssFallback = document.createElement("style");
      pipCssFallback.textContent = `:root{--purple:#a855f7;--bg-dark:#0d1117;--border:#30363d;--text:#e6edf3;--text-muted:#8b949e;--accent-blue:#58a6ff;--accent-green:#3fb950;}
.voice-reader-panel{box-sizing:border-box;color:var(--text);--voice-pip-font-scale:1;}
.voice-reader-pip-strip{display:none;flex-direction:column;gap:0;width:100%;height:100%;min-height:0;flex:1 1 auto;font-size:calc(var(--voice-pip-font-scale,1) * clamp(13px,min(4vmin,3.5vh),22px));}
.voice-pip-row{display:flex;align-items:stretch;gap:0;flex:1 1 auto;min-height:0;padding:clamp(4px,0.9vmin,10px) clamp(6px,1.6vmin,12px) clamp(3px,0.7vmin,8px);background:rgba(10,12,16,0.95);border-radius:8px 8px 0 0;}
.voice-pip-left{display:flex;align-items:center;justify-content:center;flex:0 0 clamp(4.2em,14vmin,7.5em);}
#voice-timer-pip{font-size:2.35em;font-weight:700;color:#39ff14;font-family:"JetBrains Mono",monospace;line-height:1;text-shadow:0 0 12px rgba(57,255,20,0.35);letter-spacing:-0.02em;}
.voice-pip-divider{width:2px;flex:0 0 2px;margin:clamp(2px,0.5vmin,6px) clamp(6px,1.4vmin,10px);background:linear-gradient(180deg,transparent,#3fb950 20%,#3fb950 80%,transparent);border-radius:1px;opacity:0.85;}
.voice-pip-center{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:clamp(2px,0.4vmin,5px);}
.voice-pip-current{display:flex;align-items:baseline;flex-wrap:wrap;gap:clamp(4px,0.8vmin,8px);line-height:1.2;}
#voice-pip-step-time{font-family:"JetBrains Mono",monospace;font-size:1.08em;font-weight:600;color:#d29922;flex-shrink:0;}
#voice-pip-step-text{font-size:1.08em;font-weight:600;color:#f0f6fc;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
#voice-pip-context{font-size:0.9em;color:#6e7681;line-height:1.3;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;}
.voice-pip-actions{display:flex;flex-direction:column;justify-content:center;gap:clamp(3px,0.55vmin,6px);flex:0 0 auto;padding-left:clamp(4px,1vmin,8px);}
.voice-pip-btn{font-size:0.85em;padding:0.45em 0.65em;border-radius:6px;border:1px solid #30363d;background:#21262d;color:#e6edf3;cursor:pointer;font-weight:600;font-family:inherit;white-space:nowrap;line-height:1.2;}
.voice-pip-btn:hover:not(:disabled){background:#30363d;border-color:#484f58;}
.voice-pip-btn:disabled{opacity:0.38;cursor:not-allowed;}
.voice-pip-footer-bars{display:flex;flex-direction:column;gap:clamp(2px,0.45vmin,5px);flex-shrink:0;padding:0 clamp(6px,1.6vmin,12px) clamp(5px,1vmin,9px);background:rgba(10,12,16,0.95);border-radius:0 0 8px 8px;}
.voice-reader-panel.pip-compact{width:100%!important;max-width:none!important;height:100%!important;padding:0!important;border-radius:10px!important;flex:1 1 auto!important;min-height:0!important;flex-direction:column!important;align-items:stretch!important;}
.voice-reader-panel.pip-compact .voice-reader-main{display:none!important;}
.voice-reader-panel.pip-compact .voice-reader-pip-strip{display:flex!important;}
.voice-reader-panel.pip-compact .voice-bars-host{gap:clamp(2px,0.5vmin,6px);margin-bottom:0;flex-shrink:0;}
.voice-reader-panel.pip-compact .voice-bars-host .voice-timeline{margin:0;height:clamp(4px,0.9vmin,8px);}
.voice-reader-panel.pip-compact .voice-bars-host .voice-step-progress{margin:0;height:clamp(3px,0.7vmin,6px);}
.voice-bars-host{display:flex;flex-direction:column;gap:8px;margin-bottom:10px;}
.voice-reader-main{display:flex;flex-direction:column;align-items:stretch;}
.voice-step-progress{height:4px;background:#21262d;border-radius:2px;overflow:hidden;width:100%;box-sizing:border-box;display:block;flex-shrink:0;}
.voice-timeline{height:8px;background:#21262d;border-radius:4px;margin:20px 0;cursor:pointer;position:relative;overflow:hidden;}
#voice-timeline-bar{height:100%;background:var(--accent-blue);width:0%;border-radius:4px;opacity:0.5;}
#voice-step-bar{height:100%;min-height:4px;display:block;width:0%;box-sizing:border-box;background:linear-gradient(90deg,#eae608 0%,#22c55e 33%,#ef4444 66%,#a855f7 100%);background-size:100% 100%;}`;
      appState.pipWindow.document.head.appendChild(pipCssFallback);
      const parent = voiceReader.parentElement, sib = voiceReader.nextElementSibling;
      appState.pipWindow.document.body.appendChild(voiceReader);
      if (pipBtn) pipBtn.style.display = "none";
      voiceReader.style.position = "static";
      voiceReader.style.width = "100%";
      voiceReader.style.height = "100%";
      voiceReader.style.flex = "1 1 auto";
      voiceReader.style.minHeight = "0";
      voiceReader.style.maxHeight = "none";
      voiceReader.style.boxShadow = "none";
      voiceReader.style.border = "none";
      voiceReader.style.background = "transparent";
      voiceReader.style.pointerEvents = "auto";
      voiceReader.classList.add("pip-compact");
      if (voicePipFooterBars && voiceBarsHost) voicePipFooterBars.appendChild(voiceBarsHost);
      setVoiceReaderVisibleLayout();
      appState.pipWindow.document.addEventListener("keydown", handleVoiceKeys);
      try { appState.pipWindow.focus(); } catch (_) {}
      rebindVoiceTimerIfRunning();
      const restoreFromPiP = () => {
        voiceReader.classList.remove("pip-compact");
        if (voiceReaderMain && voiceBarsHost && voicePlayBtn) {
          voiceReaderMain.insertBefore(voiceBarsHost, voicePlayBtn.parentElement);
        }
        if (parent) { if (sib) parent.insertBefore(voiceReader, sib); else parent.appendChild(voiceReader); }
        voiceReader.style.position = "fixed";
        voiceReader.style.bottom = "20px";
        voiceReader.style.right = "20px";
        voiceReader.style.width = "340px";
        voiceReader.style.height = "";
        voiceReader.style.maxHeight = "";
        voiceReader.style.flex = "";
        voiceReader.style.minHeight = "";
        voiceReader.style.boxShadow = "0 10px 40px rgba(0,0,0,0.6)";
        voiceReader.style.border = "1px solid #30363d";
        voiceReader.style.background = "rgba(22,27,34,0.98)";
        setVoiceReaderVisibleLayout();
        voiceReader.style.pointerEvents = "";
        if (pipBtn) pipBtn.style.display = "";
        appState.pipWindow = null;
        rebindVoiceTimerIfRunning();
      };
      appState.pipWindow.addEventListener("pagehide", restoreFromPiP, { once: true });
    } catch { requestVideoPiP(); }
  } else requestVideoPiP();
}

async function requestVideoPiP() {
  const voiceTimer = document.getElementById("voice-timer");
  const vQ0 = document.getElementById("v-q0");
  const vQ1 = document.getElementById("v-q1");
  const canvas = document.createElement("canvas"); canvas.width = 340; canvas.height = 180;
  const ctx = canvas.getContext("2d"); if (!ctx) return;
  const video = document.createElement("video"); video.muted = true;
  video.srcObject = canvas.captureStream(); await video.play();
  document.body.appendChild(video); video.style.cssText = "position:fixed;top:-1000px";
  const drawOnce = () => {
    if (!video.srcObject) return;
    ctx.fillStyle = "#0d1117"; ctx.fillRect(0, 0, 340, 180);
    ctx.fillStyle = "#3fb950"; ctx.font = 'bold 36px "JetBrains Mono", monospace'; ctx.textAlign = "center";
    ctx.fillText(voiceTimer ? voiceTimer.innerText : "", 170, 60);
    ctx.fillStyle = "#e6edf3"; ctx.font = 'bold 24px "Noto Sans SC", sans-serif';
    ctx.fillText(vQ0 ? vQ0.innerText : "", 170, 110);
    ctx.fillStyle = "#8b949e"; ctx.font = '16px "Noto Sans SC", sans-serif';
    ctx.fillText("Next: " + (vQ1 ? vQ1.innerText : "---"), 170, 150);
  };
  const videoDrawId = setInterval(drawOnce, 80);
  drawOnce();
  try {
    await video.requestPictureInPicture();
    video.onleavepictureinpicture = () => { clearInterval(videoDrawId); video.remove(); };
  } catch {
    clearInterval(videoDrawId);
    video.remove();
    alert("当前浏览器不支持悬浮模式（Document画中画）");
  }
}

function seekVoiceTimeline(clientX, silentSeek) {
  const voiceTimeline = document.getElementById("voiceTimeline");
  if (!voiceTimeline || !appState.voiceSteps.length) return;
  const r = voiceTimeline.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  jumpVoiceTo((appState.voiceSteps[appState.voiceSteps.length - 1].time + 10) * pct, silentSeek);
}

function handleVoiceKeys(e) {
  if (!e.altKey) return;
  if (e.key === "ArrowUp") { e.preventDefault(); toggleVoicePlay(); }
  if (e.key === "ArrowDown") { e.preventDefault(); resetVoice(); }
  if (e.key === "ArrowRight") { e.preventDefault(); const n = appState.voiceCurrentIndex + 1; if (n < appState.voiceSteps.length) jumpVoiceTo(appState.voiceSteps[n].time); }
  if (e.key === "ArrowLeft") { e.preventDefault(); const p = appState.voiceCurrentIndex - 1; if (p >= 0) jumpVoiceTo(appState.voiceSteps[p].time); else resetVoice(); }
}

export function initVoiceReader() {
  const voiceClose = document.getElementById("voiceClose");
  const voicePlayBtn = document.getElementById("voicePlay");
  const voiceResetBtn = document.getElementById("voiceReset");
  const voicePipBtnStart = document.getElementById("voicePipBtnStart");
  const voicePipBtnPause = document.getElementById("voicePipBtnPause");
  const voicePipFontScaleInput = document.getElementById("voicePipFontScale");
  const pipBtn = document.getElementById("pipBtn");
  const voiceTimeline = document.getElementById("voiceTimeline");
  const voiceReader = voiceReaderEl();

  if (voiceClose) voiceClose.onclick = () => { stopVoice(); if (voiceReader) voiceReader.style.display = "none"; };
  if (voicePlayBtn) voicePlayBtn.onclick = toggleVoicePlay;
  if (voiceResetBtn) voiceResetBtn.onclick = resetVoice;
  if (voicePipBtnStart) voicePipBtnStart.onclick = () => { if (!appState.voiceIsRunning && appState.voiceSteps.length) toggleVoicePlay(); };
  if (voicePipBtnPause) voicePipBtnPause.onclick = () => { if (appState.voiceIsRunning) toggleVoicePlay(); };
  initVoicePipFontScale();
  if (voicePipFontScaleInput) voicePipFontScaleInput.addEventListener("input", applyVoicePipFontScaleFromUI);
  if (voicePipFontScaleInput) voicePipFontScaleInput.addEventListener("change", applyVoicePipFontScaleFromUI);
  if (pipBtn) pipBtn.onclick = requestPiP;

  if (voiceTimeline) {
    voiceTimeline.addEventListener("pointerdown", e => {
      if (!appState.voiceSteps.length) return;
      appState.voiceTimelineDragging = true;
      try { voiceTimeline.setPointerCapture(e.pointerId); } catch (_) {}
      seekVoiceTimeline(e.clientX, true);
    });
    voiceTimeline.addEventListener("pointermove", e => {
      if (appState.voiceTimelineDragging) seekVoiceTimeline(e.clientX, true);
    });
    voiceTimeline.addEventListener("pointerup", e => {
      appState.voiceTimelineDragging = false;
      try { voiceTimeline.releasePointerCapture(e.pointerId); } catch (_) {}
      seekVoiceTimeline(e.clientX, false);
    });
    voiceTimeline.addEventListener("pointercancel", e => {
      appState.voiceTimelineDragging = false;
      try { voiceTimeline.releasePointerCapture(e.pointerId); } catch (_) {}
      seekVoiceTimeline(e.clientX, false);
    });
  }

  window.addEventListener("keydown", handleVoiceKeys);
}
