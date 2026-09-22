// 探针：chrono 指令事件的字段形态 + initData 的 userId→player 映射
import { readFileSync } from "node:fs";
import { join } from "node:path";
const REPO = "/Users/macmini/sc2rep/sc2replay_online_analysis/";
const { initSync } = await import(join(REPO, "wasm/pkg/compute.js"));
initSync({ module: readFileSync(join(REPO, "wasm/pkg/compute_bg.wasm")) });
const { markComputeWasmReady, createWasmDecompressor } = await import(join(REPO, "js/worker/decoder/decompressors.js"));
markComputeWasmReady();
const { openMpqArchive } = await import(join(REPO, "js/worker/decoder/mpq.js"));
const { probeBaseBuild, selectProtocolTables } = await import(join(REPO, "js/worker/decoder/protocols/index.js"));
const { decodeReplayInitData, decodeReplayGameEvents, decodeReplayDetails } = await import(join(REPO, "js/worker/decoder/events.js"));
const dec = new TextDecoder();
const txt = (v) => (v instanceof Uint8Array ? dec.decode(v) : String(v ?? ""));

const CHRONO_LINKS = new Set([108, 111, 115, 116, 706, 709, 716, 717, 722, 723, 724]);
const name = process.argv[2] ?? "CN_ZVP.SC2Replay";
const archive = await openMpqArchive(new Uint8Array(readFileSync(join(REPO, "sampleTest", name))), { decompressor: createWasmDecompressor() });
const sel = selectProtocolTables(probeBaseBuild(archive.readHeaderContent()).baseBuild);
const init = decodeReplayInitData(sel, await archive.readFile("replay.initData"));
const game = decodeReplayGameEvents(sel, await archive.readFile("replay.game.events"));

console.log("### initData 顶层键:", Object.keys(init).join(", "));
const sync = init.m_syncLobbyState;
console.log("### m_syncLobbyState 键:", sync ? Object.keys(sync).join(", ") : "(无)");
const slots = sync?.m_lobbyState?.m_slots ?? [];
console.log(`### m_slots (${slots.length}) 形态:`);
for (const s of slots.slice(0, 8)) {
  console.log("   ", JSON.stringify(s, (k, v) => (v instanceof Uint8Array ? txt(v) : v)));
}
const uid = sync?.m_userInitialData ?? [];
console.log(`### m_userInitialData (${uid.length}) 形态:`);
for (const u of uid.slice(0, 8)) console.log("   ", JSON.stringify(u, (k, v) => (v instanceof Uint8Array ? txt(v) : v)));

console.log("\n### chrono 指令事件：");
let n = 0;
const seen = new Map();
for (const e of game) {
  const kind = e._event.slice(e._event.lastIndexOf(".") + 1);
  const abil = e.m_abil;
  if (!abil) continue;
  const link = Number(abil.m_abilLink);
  if (!CHRONO_LINKS.has(link) && n < 0) continue;
  const key = `${kind}|${link}`;
  if (CHRONO_LINKS.has(link)) {
    if (n < 8) console.log("   ", JSON.stringify(e, (k, v) => (v instanceof Uint8Array ? txt(v) : v)));
    n++;
  }
  seen.set(key, (seen.get(key) ?? 0) + 1);
}
console.log(`\n### 命中 chrono link 的事件数 = ${n}`);
console.log("### 所有 (事件类型|abilLink) 频次 top20：");
for (const [k, c] of [...seen].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`   ${String(c).padStart(6)}  ${k}`);
