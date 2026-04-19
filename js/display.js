import { appState } from "./state.js";
import {
  formatRealTime,
  formatRealWorldTime,
  formatGameTime,
  formatFileSize,
  escapeHtml,
} from "./format_utils.js";
import {
  itemIsTechUpgrade,
  getDisplayUnitText,
  compareBuildOrderItems,
} from "./display_helpers.js";
import { setupExportButtons } from "./export_build.js";
import { renderBenchmarks } from "./benchmarks.js";
import { setupVoiceButtons, openVoiceReader } from "./voice_reader.js";

export function renderChat(data) {
  const chatPanel = document.getElementById("chatPanel");
  const chatToggle = document.getElementById("chatToggle");
  if (!chatPanel || !chatToggle) return;
  const chats = Array.isArray(data.chat) ? [...data.chat] : [];
  if (!chats.length) {
    appState.chatVisible = false; chatPanel.style.display = "none"; chatPanel.innerHTML = "";
    chatToggle.style.display = "none"; chatToggle.textContent = "查看对局聊天"; return;
  }
  chats.sort((a, b) => (a.time || 0) - (b.time || 0));
  chatPanel.innerHTML = chats.map(msg => {
    const t = formatGameTime(msg.time || 0);
    const sender = msg.player || (msg.pid != null ? `P${msg.pid}` : "未知");
    return `<div class="chat-item"><span class="chat-time">[${t}]</span><span class="chat-player">${escapeHtml(sender)}</span><span class="chat-target">(${escapeHtml(msg.target || "所有人")})</span><span class="chat-text">${escapeHtml(msg.text || "")}</span></div>`;
  }).join("");
  chatToggle.style.display = "inline-flex";
  appState.chatVisible = false; chatPanel.style.display = "none"; chatToggle.textContent = "查看对局聊天";
}

export function displayResult(data) {
  const gameInfo = document.getElementById("gameInfo");
  const buildOrders = document.getElementById("buildOrders");
  const result = document.getElementById("result");
  const voiceReader = document.getElementById("voiceReader");

  const gameLen = data.game_length || 0;
  const clientVersion = data.client_version || "";
  const region = data.region || "";
  const startTs = data.start_time || null;
  const winner = data.winner || "";
  const startStr = startTs ? formatRealWorldTime(startTs) : "";
  const fileSizeStr = appState.lastFileMeta ? formatFileSize(appState.lastFileMeta.size) : "";

  const info = [];
  info.push(`<span><strong>地图</strong> ${data.map_name || "Unknown"}</span>`);
  info.push(`<span><strong>时长</strong> ${formatRealTime(gameLen)}</span>`);
  if (clientVersion) info.push(`<span><strong>版本</strong> ${clientVersion}</span>`);
  if (region) info.push(`<span><strong>区域</strong> ${region}</span>`);
  if (startStr) info.push(`<span><strong>时间</strong> ${startStr}</span>`);
  if (winner) info.push(`<span><strong>胜者</strong> ${winner}</span>`);
  if (fileSizeStr) info.push(`<span><strong>大小</strong> ${fileSizeStr}</span>`);
  if (gameInfo) gameInfo.innerHTML = info.join("");
  renderChat(data);

  let html = "";
  const tc = ["team1", "team2"];
  data.teams.forEach((team, i) => {
    team.players.forEach(player => {
      const race = (player.race || "?")[0].toUpperCase();
      let items = [...(player.build_order || [])];

      if (!appState.showUpgrades) {
        items = items.filter(it => !itemIsTechUpgrade(it));
      }

      if (appState.showWorkerDeaths && Array.isArray(player.worker_deaths)) {
        player.worker_deaths.forEach(wd => {
          const t = typeof wd.time === "number" ? wd.time : 0;
          let zhw = wd.unit || "";
          if (appState.translationData?.unit?.[zhw]) zhw = appState.translationData.unit[zhw].zh || zhw;
          let txt = `${zhw} 阵亡`;
          if (wd.killer) txt += `（${wd.killer}）`;
          items.push({ start_time: t, supply: null, unit: txt, _kind: "worker_death" });
        });
      }

      if (!appState.showWorkers) {
        for (let j = items.length - 1; j >= 0; j--) { if (items[j].is_worker) items.splice(j, 1); }
      }

      items.sort(compareBuildOrderItems);

      let rendered = items.map(it => {
        const t = it.start_time ?? it.time ?? 0;
        const cls = [];
        if (itemIsTechUpgrade(it)) cls.push("upgrade");
        if (it._kind === "recall") cls.push("recall");
        if (it._kind === "worker_death") cls.push("worker-death");
        if (it.category === "unit" || (it._kind === "unit" && !it.is_worker)) cls.push("unit");
        return { timeStr: formatGameTime(t), supplyStr: it.supply ?? "", unitText: getDisplayUnitText(it), extraClass: cls.join(" "), raw: it };
      });

      if (appState.mergeSameActions) {
        const merged = []; let cur = null, cnt = 0;
        const flush = () => { if (!cur) return; merged.push({ ...cur, unitText: cnt > 1 ? `${cur.unitText} x${cnt}` : cur.unitText }); };
        rendered.forEach(it => {
          if (!cur || cur.timeStr !== it.timeStr || cur.unitText !== it.unitText) { flush(); cur = it; cnt = 1; }
          else { cnt++; cur.supplyStr = it.supplyStr; }
        });
        flush();
        rendered = merged;
      }

      html += `<div class="player-panel">
            <div class="player-header ${tc[i]}">
              <span class="race-badge ${race}">${race}</span>
              <span class="player-name">${player.name || "Unknown"}</span>
              <button type="button" class="export-btn">导出TXT</button>
            </div>
            <div class="build-list">${rendered.map(it => `<div class="build-item ${it.extraClass}"><span class="time">${it.timeStr}</span><span class="supply">${it.supplyStr}</span><span class="unit">${it.unitText}</span></div>`).join("")}</div>
          </div>`;
    });
  });

  if (buildOrders) buildOrders.innerHTML = html;
  if (result) result.classList.add("visible");
  setupExportButtons();
  setupVoiceButtons(data);
  renderBenchmarks(data);

  const vrDisp = voiceReader ? voiceReader.style.display : "";
  if (appState.currentVoicePlayer && vrDisp !== "none" && vrDisp !== "") openVoiceReader(appState.currentVoicePlayer);
}
