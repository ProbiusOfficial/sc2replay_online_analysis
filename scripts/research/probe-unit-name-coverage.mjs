/**
 * 建造项名称覆盖探针 —— 找出「名表查不到 → 显示英文原名 / 归入未分类」的建造项。
 *
 * 背景（探宝反馈）：HotS 2018 老录像里兵营落地显示 "Barracks" 而不是「兵营」。
 * 翻译链路 = `data.json` 的 unit / build / upgrade / change 四张表（键小写）展平成
 * `zhIndex`，查不到就回退英文原名；分类同理，查不到归 `unknown`。
 * 所以「显示英文」与「未分类」是同一批名字。
 *
 * 输出：每个样本的未命中名（含计数、_kind、is_worker、首次出现时间），以及名表覆盖情况。
 *
 * 用法：node scripts/research/probe-unit-name-coverage.mjs
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

const tr = JSON.parse(readFileSync(join(REPO, "data.json"), "utf8"));

/** 名表规模，以及关键名是否存在。 */
console.log("=== data.json 名表规模 ===");
for (const table of ["unit", "build", "upgrade"]) {
  const keys = Object.keys(tr[table] ?? {});
  console.log(`  ${table}: ${keys.length} 条`);
}
const probe = ["Barracks", "SupplyDepot", "CommandCenter", "TechLab", "Reactor", "BarracksTechLab", "BarracksReactor"];
for (const p of probe) {
  const hits = ["unit", "build", "upgrade"].filter((t) => tr[t]?.[p]);
  console.log(`  ${p.padEnd(18)} → ${hits.length ? hits.join("/") + "：" + JSON.stringify(tr[hits[0]][p]) : "四表都没有"}`);
}

/** 与生产 `data.js` 完全一致的查找逻辑。 */
const tables = ["unit", "build", "upgrade"];
const lookup = (name) => {
  const target = String(name).toLowerCase();
  for (const table of tables) {
    const hit = Object.entries(tr[table] ?? {}).find(([k]) => k.toLowerCase() === target);
    if (hit) return { table, zh: String(hit[1]?.zh ?? hit[1]) };
  }
  return null;
};

const MORPH_NOISE = /Lowered|Flying|Uprooted|Phased|Burrowed|Cocoon|LiberatorAG|VikingAssault/;
/** 与生产 `data.js` 的 `cleanUnitName` 一致：剥掉旧链路拼进名字的错误标注。 */
const WERROR_NOISE = /\s*\((?:Error on build time|upgrade missing)\)\s*$/i;

console.log("\n=== 各样本未命中清单 ===");
const globalMiss = new Map(); // name -> {count, samples:Set, kinds:Set, first:{file,t,supply,isWorker}}
for (const name of readdirSync(join(REPO, "sampleTest")).filter((n) => n.endsWith(".SC2Replay")).sort()) {
  const buf = new Uint8Array(readFileSync(join(REPO, "sampleTest", name)));
  const d = await extractReplayData(buf, { decompressor: createWasmDecompressor() });
  const misses = [];
  let total = 0;
  for (const team of d.teams) {
    for (const p of team.players) {
      for (const it of p.build_order) {
        if (it._kind === "recall") continue;
        total++;
        const u = String(it.unit || "").replace(WERROR_NOISE, "");
        if (MORPH_NOISE.test(u)) continue; // 与生产一致：变形噪声在分类阶段丢弃
        if (lookup(u)) continue;
        misses.push({ u, kind: it._kind, worker: !!it.is_worker, t: it.start_time, supply: it.supply, player: `${p.name}(${p.race})` });
        const g = globalMiss.get(u) ?? { count: 0, samples: new Set(), kinds: new Set(), workers: new Set(), first: null };
        g.count++;
        g.samples.add(name.replace(".SC2Replay", ""));
        g.kinds.add(it._kind);
        g.workers.add(it.is_worker ? "农民" : "非农民");
        if (!g.first) g.first = { file: name.replace(".SC2Replay", ""), t: it.start_time, supply: it.supply, player: `${p.name}(${p.race})` };
        globalMiss.set(u, g);
      }
    }
  }
  console.log(`\n### ${name}  build=${d.client_version}  建造项 ${total}，未命中 ${misses.length}`);
  for (const m of misses) {
    console.log(`   ${String(m.supply ?? "-").padStart(3)}  ${String(m.t).padStart(4)}s  ${m.worker ? "农" : "  "}  ${m.kind.padEnd(4)}  ${m.u}   (${m.player})`);
  }
}

console.log("\n=== 未命中名汇总（跨样本） ===");
for (const [name, g] of [...globalMiss.entries()].sort((a, b) => b.count - a.count)) {
  console.log(`  ${name.padEnd(28)} ×${String(g.count).padStart(3)}  kind=[${[...g.kinds].join(",")}]  ${[...g.workers].join("/")}  样本=${[...g.samples].join(", ")}`);
}
