import { appState } from "./state.js";
import { DEFAULT_BATCH_RAIL_WIDTH } from "./constants.js";
import { loadTranslationData, showError } from "./errors_init.js";
import { initPyodide } from "./pyodide_boot.js";
import { collectSc2ReplayFiles } from "./format_utils.js";
import {
  processBatchFiles,
  setupBatchRailResize,
  applyBatchRailWidth,
  readStoredBatchRailWidth,
} from "./batch_rail.js";
import { displayResult } from "./display.js";
import { initVoiceReader } from "./voice_reader.js";

function bindToggle(id, setter) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("change", e => {
    setter(!!e.target.checked);
    if (appState.lastData) displayResult(appState.lastData);
  });
}

initVoiceReader();

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

const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("fileInput");
if (dropZone) {
  dropZone.addEventListener("click", () => fileInput && fileInput.click());
  dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("dragover"); });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
  dropZone.addEventListener("drop", e => {
    e.preventDefault(); dropZone.classList.remove("dragover");
    const replays = collectSc2ReplayFiles(e.dataTransfer.files);
    if (replays.length) processBatchFiles(replays);
    else showError("请上传 .SC2Replay 文件");
  });
}

if (fileInput) {
  fileInput.addEventListener("change", e => {
    const replays = collectSc2ReplayFiles(e.target.files);
    if (replays.length) processBatchFiles(replays);
    e.target.value = "";
  });
}

applyBatchRailWidth(readStoredBatchRailWidth());
setupBatchRailResize();
window.addEventListener("resize", () => {
  const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--batch-rail-width"));
  applyBatchRailWidth(Number.isFinite(cur) ? cur : DEFAULT_BATCH_RAIL_WIDTH);
});

loadTranslationData();
initPyodide();
