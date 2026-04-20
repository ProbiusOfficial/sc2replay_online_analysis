import { SHARE_API_BASE_URL } from "./constants.js";

function buildUploadUrl() {
  try {
    if (window?.SC2_SHARE_API_BASE_URL) {
      return `${String(window.SC2_SHARE_API_BASE_URL).replace(/\/$/, "")}/api/replays/upload`;
    }
  } catch (_) {}
  return `${SHARE_API_BASE_URL}/api/replays/upload`;
}

function normalizePlayers(data) {
  const out = [];
  if (!Array.isArray(data?.teams)) return out;
  for (const team of data.teams) {
    if (!Array.isArray(team?.players)) continue;
    for (const p of team.players) {
      if (p?.name) out.push(String(p.name));
    }
  }
  return out;
}

export function buildClientMeta(data) {
  return {
    map_name: data?.map_name || "",
    players: normalizePlayers(data),
    winner: data?.winner || "",
    game_length: Number(data?.game_length || 0),
    region: data?.region || "",
    client_version: data?.client_version || "",
  };
}

export async function uploadReplayShare({ replayFile, agreedPublic, agreedUsage, message, data }) {
  if (!replayFile) throw new Error("未找到待上传录像文件");
  const fd = new FormData();
  fd.append("replay_file", replayFile, replayFile.name || "upload.SC2Replay");
  fd.append("agreed_public", agreedPublic ? "true" : "false");
  fd.append("agreed_usage", agreedUsage ? "true" : "false");
  fd.append("message", message || "");
  fd.append("client_meta", JSON.stringify(buildClientMeta(data)));

  const resp = await fetch(buildUploadUrl(), {
    method: "POST",
    body: fd,
  });
  let payload = null;
  try {
    payload = await resp.json();
  } catch (_) {}
  if (!resp.ok) {
    const detail = payload?.detail || `上传失败（HTTP ${resp.status}）`;
    throw new Error(detail);
  }
  return payload;
}
