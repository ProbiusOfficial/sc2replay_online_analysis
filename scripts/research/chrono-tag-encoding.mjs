// 探针：确认游戏事件里 TargetUnit.m_tag 与 tracker 的 (index, recycle) 编码关系
import { readFileSync } from "node:fs";
import { join } from "node:path";
const REPO = "/Users/macmini/sc2rep/sc2replay_online_analysis/";
const { initSync } = await import(join(REPO, "wasm/pkg/compute.js"));
initSync({ module: readFileSync(join(REPO, "wasm/pkg/compute_bg.wasm")) });
const { markComputeWasmReady, createWasmDecompressor } = await import(join(REPO, "js/worker/decoder/decompressors.js"));
markComputeWasmReady();
const { openMpqArchive } = await import(join(REPO, "js/worker/decoder/mpq.js"));
const { probeBaseBuild, selectProtocolTables } = await import(join(REPO, "js/worker/decoder/protocols/index.js"));
const { decodeReplayGameEvents, decodeReplayTrackerEvents } = await import(join(REPO, "js/worker/decoder/events.js"));
const dec = new TextDecoder();
const txt = (v) => (v instanceof Uint8Array ? dec.decode(v) : String(v ?? ""));
const LO = (t) => t & 0x3ffff;        // 低 18 位
const HI = (t) => Math.floor(t / 262144); // 高 14 位

const name = process.argv[2] ?? "CN_ZVP.SC2Replay";
const archive = await openMpqArchive(new Uint8Array(readFileSync(join(REPO, "sampleTest", name))), { decompressor: createWasmDecompressor() });
const sel = selectProtocolTables(probeBaseBuild(archive.readHeaderContent()).baseBuild);
const game = decodeReplayGameEvents(sel, await archive.readFile("replay.game.events"));
const tracker = decodeReplayTrackerEvents(sel, await archive.readFile("replay.tracker.events"));

// 收集 tracker 里所有 (index, recycle) → 单位名 + 控制方
const byPair = new Map();
for (const e of tracker) {
  const k = e._event.slice(e._event.lastIndexOf(".") + 1);
  if (k !== "SUnitBornEvent" && k !== "SUnitInitEvent") continue;
  byPair.set(`${e.m_unitTagIndex}/${e.m_unitTagRecycle}`, {
    name: txt(e.m_unitTypeName), pid: Number(e.m_controlPlayerId), gl: e._gameloop,
  });
}

const CHRONO = new Set([108, 111, 115, 116, 706, 709, 716, 717, 722, 723, 724]);
console.log(`### ${name}: tracker 单位 ${byPair.size} 个`);
console.log("### chrono 指令的目标 tag 解析（两种编码各试一次）：");
let n = 0;
for (const e of game) {
  const a = e.m_abil;
  if (!a || !CHRONO.has(Number(a.m_abilLink)) || Number(a.m_abilCmdIndex) !== 0) continue;
  const tu = e.m_data?.TargetUnit;
  if (!tu) continue;
  const tag = Number(tu.m_tag);
  const candA = `${LO(tag)}/${HI(tag)}`;           // index=低18, recycle=高14
  const candB = `${HI(tag)}/${LO(tag)}`;           // index=高14, recycle=低18
  const A = byPair.get(candA), B = byPair.get(candB);
  console.log(`  gl=${e._gameloop} tag=${tag} (0x${tag.toString(16)}) uid=${e._userid?.m_userId}`);
  console.log(`     A index=低18 → ${candA}: ${A ? JSON.stringify(A) : "❌ 查不到"}`);
  console.log(`     B index=高14 → ${candB}: ${B ? JSON.stringify(B) : "❌ 查不到"}`);
  if (++n >= 6) break;
}
console.log(`\n命中 ${n} 条（最多打印 6 条）`);
