import { appState } from "./state.js";

export function showError(msg) {
  const error = document.getElementById("error");
  const result = document.getElementById("result");
  const loading = document.getElementById("loading");
  if (error) error.textContent = msg;
  if (error) error.classList.add("visible");
  if (result) result.classList.remove("visible");
  if (loading) loading.classList.remove("visible");
}

export function hideError() {
  const error = document.getElementById("error");
  if (error) error.classList.remove("visible");
}

export function setInitStatus(msg) {
  const initProgress = document.getElementById("initProgress");
  if (initProgress) initProgress.textContent = msg;
}

export async function loadTranslationData() {
  try {
    const resp = await fetch("data.json", { cache: "no-cache" });
    if (!resp.ok) { console.warn("data.json load failed:", resp.status); return; }
    appState.translationData = await resp.json();
    console.log("translation data loaded");
  } catch (e) { console.warn("data.json load error:", e); }
}
