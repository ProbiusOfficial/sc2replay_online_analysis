/**
 * 时间口径诊断：聊天/建造时间（16fps 游戏秒）与时间轴（gameloop/实际 fps）的比例。
 *
 * stats 事件每 160 gameloop 一个采样点 → 相邻采样点的秒差 = 160 / 实际 fps。
 * 由此可实测每个录像的 fps，进而得到换算因子 = 16 / fps。
 *
 * 用法：node scripts/research/probe-time-factor.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const { initSync } = await import(join(REPO, "wasm/pkg/compute.js"));
initSync({ module: readFileSync(join(REPO, "wasm/pkg/compute_bg.wasm")) });
const { markComputeWasmReady, createWasmDecompressor } = await import(join(REPO, "js/worker/decoder/decompressors.js"));
markComputeWasmReady();
const { extractReplayData } = await import(join(REPO, "js/worker/decoder/replay_data.js"));

const median = (arr) => {
  const a = [...arr].sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : 0;
};

console.log("样本".padEnd(26) + "  时长s  采样点  间隔中位  实测fps  因子16/fps  建造末条(游戏秒)  ×因子  落点");
for (const name of readdirSync(join(REPO, "sampleTest")).filter((n) => n.endsWith(".SC2Replay")).sort()) {
  const d = await extractReplayData(new Uint8Array(readFileSync(join(REPO, "sampleTest", name))), { decompressor: createWasmDecompressor() });
  for (const team of d.teams) {
    for (const p of team.players) {
      const t = p.stats_series?.t ?? [];
      if (t.length < 3) continue;
      const diffs = [];
      for (let i = 1; i < t.length; i++) { const dt = t[i] - t[i - 1]; if (dt > 0.5) diffs.push(dt); }
      const med = median(diffs);
      const fps = med > 0 ? 160 / med : 0;
      const factor = fps > 0 ? 16 / fps : 1;
      const lastStart = Math.max(...(p.build_order ?? []).map((it) => it.start_time ?? 0), 0);
      const converted = lastStart * factor;
      console.log(
        `${(name.replace(".SC2Replay", "").slice(0, 18) + "/" + p.race).padEnd(26)}` +
        `  ${String(Math.round(d.game_length)).padStart(5)}  ${String(t.length).padStart(5)}  ` +
        `${med.toFixed(2).padStart(7)}  ${fps.toFixed(2).padStart(7)}  ${factor.toFixed(3).padStart(9)}  ` +
        `${String(Math.round(lastStart)).padStart(14)}  ${String(Math.round(converted)).padStart(5)}  ` +
        `${((converted / d.game_length) * 100).toFixed(0)}%`,
      );
    }
  }
}
