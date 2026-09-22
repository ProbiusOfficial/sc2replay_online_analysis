// 只读探针：验证 replay_data.ts 新增的 stats_series（39 字段原始采样序列）数据正确性。
//   node scripts/research/probe-stats-series.mjs
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO = "/Users/macmini/sc2rep/sc2replay_online_analysis/";
const { initSync } = await import(join(REPO, "wasm/pkg/compute.js"));
initSync({ module: readFileSync(join(REPO, "wasm/pkg/compute_bg.wasm")) });
const { markComputeWasmReady, createWasmDecompressor } = await import(
  join(REPO, "js/worker/decoder/decompressors.js"),
);
markComputeWasmReady();
const { extractReplayData, STATS_SERIES_FIELDS } = await import(
  join(REPO, "js/worker/decoder/replay_data.js"),
);

console.log(`STATS_SERIES_FIELDS 长度 = ${STATS_SERIES_FIELDS.length}`);
const names = readdirSync(join(REPO, "sampleTest")).filter((n) => n.endsWith(".SC2Replay")).sort();

const pad = (s, n) => String(s).padStart(n);
console.log(
  "样本/种族".padEnd(28) + pad("时长s", 7) + pad("点数", 5) + pad("间隔s", 7) + pad("尾/时长", 9) + "  本局非零",
);
let problems = 0;
let players = 0;
// 逐字段累计「非零的采样点数」，最后用来区分「本来就是 0」和「没被填」
const fieldNonZero = new Map(STATS_SERIES_FIELDS.map((f) => [f, 0]));
const fieldTotal = new Map(STATS_SERIES_FIELDS.map((f) => [f, 0]));

for (const name of names) {
  const buf = new Uint8Array(readFileSync(join(REPO, "sampleTest", name)));
  const d = await extractReplayData(buf, { decompressor: createWasmDecompressor() });
  for (const team of d.teams)
    for (const p of team.players) {
      const s = p.stats_series;
      const n = s.t.length;
      const label = name.replace(/\.SC2Replay$/, "").slice(0, 20) + "/" + p.race;
      if (!n) {
        console.log(label.padEnd(28) + "  （无 stats_series）");
        problems++;
        continue;
      }
      players++;
      const dt = n > 1 ? (s.t[1] - s.t[0]).toFixed(1) : "—";
      const ratio = (s.t[n - 1] / d.game_length).toFixed(3);
      const keys = Object.keys(s.v);
      // 真正的结构性问题：字段缺失 / 序列长度与 t 不一致 / 时间轴超出时长
      const badLen = keys.filter((k) => s.v[k].length !== n);
      const missing = STATS_SERIES_FIELDS.filter((f) => !(f in s.v));
      if (badLen.length || missing.length) problems++;
      if (Number(ratio) > 1.001) problems++;
      let nz = 0;
      for (const k of keys) {
        const s2 = s.v[k];
        let any = false;
        for (const v of s2) if (v !== 0) { any = true; break; }
        if (any) nz++;
        fieldTotal.set(k, (fieldTotal.get(k) ?? 0) + n);
        for (const v of s2) if (v !== 0) { fieldNonZero.set(k, (fieldNonZero.get(k) ?? 0) + 1); }
      }
      console.log(
        label.padEnd(28) +
          pad(d.game_length, 7) +
          pad(n, 5) +
          pad(dt, 7) +
          pad(ratio, 9) +
          `  ${nz}/${keys.length}` +
          (badLen.length ? `  ⚠️长度不符 ${badLen.length}` : "") +
          (missing.length ? `  ⚠️缺字段 ${missing.length}` : ""),
      );
    }
}

const d = await extractReplayData(
  new Uint8Array(readFileSync(join(REPO, "sampleTest", "US_TVP.SC2Replay"))),
  { decompressor: createWasmDecompressor() },
);
const s = d.teams[0].players[0].stats_series;
console.log("\nUS_TVP 首个玩家 · 抽样（前 3 个采样点 + 末值）：");
for (const f of [
  "MineralsCurrent",
  "VespeneCurrent",
  "MineralsCollectionRate",
  "FoodUsed",
  "WorkersActiveCount",
  "MineralsUsedCurrentArmy",
  "MineralsFriendlyFireEconomy",
]) {
  console.log(`  ${f.padEnd(28)} ${s.v[f].slice(0, 3).join(", ").padEnd(24)} 末 ${s.v[f].at(-1)}`);
}
console.log(`  t 前 3 = ${s.t.slice(0, 3).join(", ")}  …  末 = ${s.t.at(-1)}  （game_length = ${d.game_length}）`);

// 哪些字段在全部 10 个玩家上恒为 0 —— 这才是「结构性没有数据」的判据，
// 而不是「某一局某玩家没有自伤」。
const dead = STATS_SERIES_FIELDS.filter((f) => (fieldNonZero.get(f) ?? 0) === 0);
console.log(`\n全部 ${players} 个玩家上**恒为 0** 的字段（${dead.length} / 39）：`);
console.log(dead.length ? dead.map((f) => "  " + f).join("\n") : "  （无）");
const rare = STATS_SERIES_FIELDS
  .filter((f) => (fieldNonZero.get(f) ?? 0) > 0)
  .map((f) => ({ f, pct: (fieldNonZero.get(f) / fieldTotal.get(f)) * 100 }))
  .filter((x) => x.pct < 8)
  .sort((a, b) => a.pct - b.pct);
console.log(`\n值出现频率不足 8% 的字段（${rare.length} 个，做发现项要谨慎）：`);
console.log(rare.map((x) => `  ${x.f.padEnd(32)} ${x.pct.toFixed(1)}%`).join("\n") || "  （无）");

console.log(
  problems
    ? `\n⚠️ ${problems} 处结构性问题（字段缺失 / 长度不符 / 时间轴超出时长）`
    : `\n✅ ${players} 个玩家的 stats_series 结构全部正确（39 字段齐全、长度一致、时间轴未超出时长）`,
);
