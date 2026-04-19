import { GAME_TIME_FACTOR } from "./constants.js";

export function formatRealTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function formatGameTime(gameSeconds) {
  const s = Math.max(0, Math.round(gameSeconds / GAME_TIME_FACTOR));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function formatRealWorldTime(ts) {
  if (!ts && ts !== 0) return "";
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function formatFileSize(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  const u = ["KB", "MB", "GB"];
  let i = -1, s = bytes;
  do { s /= 1024; i++; } while (s >= 1024 && i < u.length - 1);
  return `${s.toFixed(1)} ${u[i]}`;
}

export function escapeHtml(str) {
  if (str == null) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function truncateStr(str, n) {
  const s = String(str ?? "");
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + "…";
}

export function collectSc2ReplayFiles(fileList) {
  return Array.from(fileList || []).filter(f => f && f.name && f.name.toLowerCase().endsWith(".sc2replay"));
}
