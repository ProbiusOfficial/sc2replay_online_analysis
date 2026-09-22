// 只读：把 SPlayerStatsEvent 的全部字段连同样例值与非零计数 dump 出来。
//
// 目的：确认「官方 overlay 口径」到底有哪些字段真的有数据，作为数据分析页的字段清单依据。
//
//   node scripts/research/dump-player-stats.mjs
//   node scripts/research/dump-player-stats.mjs hero
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO = "/Users/macmini/sc2rep/sc2replay_online_analysis/";
const SAMPLE_DIR = join(REPO, "sampleTest");

const { initSync } = await import(join(REPO, "wasm/pkg/compute.js"));
initSync({ module: readFileSync(join(REPO, "wasm/pkg/compute_bg.wasm")) });
const { markComputeWasmReady, createWasmDecompressor } = await import(
  join(REPO, "js/worker/decoder/decompressors.js")
);
markComputeWasmReady();
const { openMpqArchive } = await import(join(REPO, "js/worker/decoder/mpq.js"));
const { probeBaseBuild, selectProtocolTables } = await import(
  join(REPO, "js/worker/decoder/protocols/index.js")
);
const { decodeReplayTrackerEvents } = await import(join(REPO, "js/worker/decoder/events.js"));

const short = (e) => e.slice(e.lastIndexOf(".") + 1);
const filter = process.argv[2];
const names = readdirSync(SAMPLE_DIR)
  .filter((n) => n.endsWith(".SC2Replay"))
  .filter((n) => !filter || n.includes(filter))
  .sort();

const allKeys = new Set();
const perSample = [];

for (const name of names) {
  const archive = await openMpqArchive(
    new Uint8Array(readFileSync(join(SAMPLE_DIR, name))),
    { decompressor: createWasmDecompressor() },
  );
  const sel = selectProtocolTables(probeBaseBuild(archive.readHeaderContent()).baseBuild);
  const tracker = decodeReplayTrackerEvents(sel, await archive.readFile("replay.tracker.events"));
  const stats = tracker.filter((e) => short(e._event) === "SPlayerStatsEvent");

  const keys = new Set();
  const nonZero = new Map();
  const maxVal = new Map();
  const sample = new Map();
  for (const e of stats) {
    const s = e.m_stats ?? {};
    for (const [k, v] of Object.entries(s)) {
      keys.add(k);
      allKeys.add(k);
      if (typeof v === "number") {
        if (v !== 0) nonZero.set(k, (nonZero.get(k) ?? 0) + 1);
        if (Math.abs(v) > Math.abs(maxVal.get(k) ?? 0)) { maxVal.set(k, v); sample.set(k, v); }
      } else {
        sample.set(k, v);
      }
    }
  }
  perSample.push({ name, n: stats.length, keys: [...keys].sort(), nonZero, sample, maxVal });

  console.log(`\n${"=".repeat(80)}\n### ${name}\n  SPlayerStatsEvent ${stats.length} 条，字段 ${keys.size} 个`);
  const gaps = [];
  for (let i = 1; i < Math.min(stats.length, 600); i++) gaps.push(stats[i]._gameloop - stats[i - 1]._gameloop);
  console.log(`  采样间隔（去重）: ${[...new Set(gaps)].sort((a, b) => a - b).slice(0, 10).join(", ")} gameloop`);
  console.log(`  采样点数: ${new Set(stats.map((e) => e.m_playerId)).size} 个 playerId`);
  for (const k of [...keys].sort()) {
    const nz = nonZero.get(k) ?? 0;
    console.log(
      `    ${nz ? "★" : "·"} ${k.padEnd(48)} 非零 ${String(nz).padStart(4)}/${stats.length}  样例=${JSON.stringify(sample.get(k))}`,
    );
  }
}

console.log(`\n${"=".repeat(80)}`);
console.log(`全部样本字段并集：${allKeys.size} 个`);
console.log([...allKeys].sort().join("\n"));
