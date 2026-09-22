// 关键验证：
// 1) m_timeUTC 真实单位（FILETIME 100ns@1601 vs unix µs）
// 2) 虫族 Egg 的 TypeChange 事件是否 = 孵化开始时刻（若是，则无需建造时长表）
// 3) 各事件类型的完整字段集
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const WASM = join(REPO, "wasm/pkg/compute_bg.wasm");
const { initSync } = await import(join(REPO, "wasm/pkg/compute.js"));
initSync({ module: readFileSync(WASM) });
const { markComputeWasmReady, createWasmDecompressor } = await import(
  join(REPO, "js/worker/decoder/decompressors.js")
);
markComputeWasmReady();
const { openMpqArchive } = await import(join(REPO, "js/worker/decoder/mpq.js"));
const { probeBaseBuild, selectProtocolTables } = await import(
  join(REPO, "js/worker/decoder/protocols/index.js")
);
const { decodeReplayDetails, decodeReplayTrackerEvents } = await import(
  join(REPO, "js/worker/decoder/events.js")
);

const dec = new TextDecoder();
const txt = (v) => (v instanceof Uint8Array ? dec.decode(v) : String(v ?? "?"));
const NAME = process.argv[2] ?? "CN_ZVP.SC2Replay";

const bytes = new Uint8Array(readFileSync(join(REPO, "sampleTest", NAME)));
const archive = await openMpqArchive(bytes, { decompressor: createWasmDecompressor() });
const probed = probeBaseBuild(archive.readHeaderContent());
const selection = selectProtocolTables(probed.baseBuild);
const details = decodeReplayDetails(selection, await archive.readFile("replay.details"));

// ---- 1) m_timeUTC 单位判定 ----
const raw = BigInt(details.m_timeUTC);
const asMicro = Number(raw / 1000n) / 1e6;               // 当 unix µs
const asFiletime = Number(raw / 10000000n) - 11644473600; // 当 FILETIME(100ns@1601)
console.log(`=== ${NAME} ===`);
console.log(`m_timeUTC 原始 = ${raw}`);
console.log(`  按 unix µs 解释 → ${new Date(asMicro * 1000).toISOString()}`);
console.log(`  按 FILETIME  → ${new Date(asFiletime * 1000).toISOString()}   (unix=${asFiletime})`);

// ---- 2) 字段集 ----
const tracker = decodeReplayTrackerEvents(selection, await archive.readFile("replay.tracker.events"));
console.log("\n各事件类型的字段集：");
const seen = new Set();
for (const e of tracker) {
  const k = e._event;
  if (seen.has(k)) continue;
  seen.add(k);
  const fields = Object.keys(e).filter((x) => !x.startsWith("_")).sort();
  console.log(`  ${k.replace("NNet.Replay.Tracker.", "")}: ${fields.join(", ")}`);
}

// ---- 3) 虫族：Egg TypeChange 与 Born 的配对 ----
const tag = (e) => `${e.m_unitTagIndex}/${e.m_unitTagRecycle}`;
const eggChanges = tracker.filter((e) => e._event.endsWith("SUnitTypeChangeEvent") && txt(e.m_unitTypeName) === "Egg");
const borns = tracker.filter((e) => e._event.endsWith("SUnitBornEvent"));

console.log(`\nEgg TypeChange 事件 ${eggChanges.length} 条；Born 事件 ${borns.length} 条（含地图中立）`);
console.log("Egg 的 unitTagIndex 样本：", eggChanges.slice(0, 6).map(tag).join(", "));
console.log("Born 的 unitTagIndex 样本：", borns.slice(0, 6).map((e) => `${tag(e)}(${txt(e.m_unitTypeName)})`).join(", "));

// 按 tag 配对：Egg TypeChange 之后同 tag 的 Born
const bornByTag = new Map();
for (const b of borns) {
  const t = tag(b);
  if (!bornByTag.has(t)) bornByTag.set(t, []);
  bornByTag.get(t).push(b);
}
let matched = 0;
const deltas = [];
console.log("\nEgg → 同 tag Born 配对（前 15 对）：");
for (const egg of eggChanges) {
  const list = bornByTag.get(tag(egg));
  const next = list?.find((b) => b._gameloop >= egg._gameloop);
  if (!next) continue;
  matched += 1;
  const delta = next._gameloop - egg._gameloop;
  deltas.push({ unit: txt(next.m_unitTypeName), delta });
  if (matched <= 15) {
    console.log(`  tag=${tag(egg)}  egg@${egg._gameloop} → ${txt(next.m_unitTypeName)}@${next._gameloop}   Δ=${delta} 帧 = ${(delta / 22.4).toFixed(2)} s(按22.4fps)`);
  }
}
console.log(`\n配对成功 ${matched}/${eggChanges.length}`);

const byUnit = new Map();
for (const d of deltas) {
  if (!byUnit.has(d.unit)) byUnit.set(d.unit, []);
  byUnit.get(d.unit).push(d.delta);
}
console.log("\n按单位汇总 Δ（帧）：");
for (const [u, ds] of [...byUnit].sort((a, b) => b[1].length - a[1].length)) {
  const min = Math.min(...ds), max = Math.max(...ds);
  console.log(`  ${u.padEnd(12)} n=${String(ds.length).padStart(3)}  Δ=${min}..${max}  中位≈${ds.sort((a, b) => a - b)[ds.length >> 1]} 帧 = ${((ds[ds.length >> 1] ?? 0) / 22.4).toFixed(1)} s`);
}

// 对照：同单位 Born 之间的间隔（推断生产节奏）
console.log("\n各虫族单位 Born 的 gameloop 前 20 个：");
const zUnits = ["Drone", "Zergling", "Overlord", "Larva"];
for (const u of zUnits) {
  const gl = borns.filter((b) => txt(b.m_unitTypeName) === u).map((b) => b._gameloop).slice(0, 20);
  if (!gl.length) continue;
  const diffs = gl.slice(1).map((v, i) => v - gl[i]);
  console.log(`  ${u.padEnd(10)} ${gl.join(", ")}`);
  console.log(`  ${"".padEnd(10)} 间隔: ${diffs.join(", ")}`);
}
