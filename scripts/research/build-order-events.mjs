// 决定性验证：能否用 Egg 的 TypeChange 事件精确定位虫族单位的建造起点？
// 思路：Born 事件带 m_creatorUnitTagIndex / m_creatorAbilityName → 去匹配 Egg 的 tag。
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
const tracker = decodeReplayTrackerEvents(selection, await archive.readFile("replay.tracker.events"));

const tagOf = (i, r) => `${i}/${r}`;

const changes = tracker.filter((e) => e._event.endsWith("SUnitTypeChangeEvent"));
const borns = tracker.filter((e) => e._event.endsWith("SUnitBornEvent"));
const inits = tracker.filter((e) => e._event.endsWith("SUnitInitEvent"));
const dones = tracker.filter((e) => e._event.endsWith("SUnitDoneEvent"));

console.log(`=== ${NAME} ===`);
console.log("\n全部 SUnitTypeChangeEvent（变形）：");
for (const e of changes) {
  console.log(`  gl=${String(e._gameloop).padStart(5)}  tag=${tagOf(e.m_unitTagIndex, e.m_unitTagRecycle).padEnd(9)} → ${txt(e.m_unitTypeName)}`);
}

// 用 creatorUnitTagIndex 反查：谁造出了这个单位
const eggByTag = new Map();
for (const e of changes) {
  if (txt(e.m_unitTypeName) === "Egg") eggByTag.set(tagOf(e.m_unitTagIndex, e.m_unitTagRecycle), e);
}
console.log(`\nEgg 的 tag 表：${[...eggByTag.keys()].join(", ")}`);

console.log("\nBorn 事件里 creatorUnitTagIndex 指向 Egg 的（= 能精确回推起点）：");
let hitEgg = 0;
const abilityNames = new Set();
for (const b of borns) {
  if (b.m_creatorAbilityName) abilityNames.add(txt(b.m_creatorAbilityName));
  const creator = tagOf(b.m_creatorUnitTagIndex, b.m_creatorUnitTagRecycle);
  const egg = eggByTag.get(creator);
  if (!egg) continue;
  hitEgg += 1;
  const delta = b._gameloop - egg._gameloop;
  console.log(
    `  ${txt(b.m_unitTypeName).padEnd(12)} born@${String(b._gameloop).padStart(5)}  creator=${creator.padEnd(9)}  egg@${String(egg._gameloop).padStart(5)}  Δ=${String(delta).padStart(4)} 帧 = ${(delta / 22.4).toFixed(2)}s@22.4fps / ${(delta / 16).toFixed(2)}s@16fps  ability=${txt(b.m_creatorAbilityName)}`,
  );
}
console.log(`  → 命中 ${hitEgg}/${borns.length} 条 Born`);

console.log(`\n所有 creatorAbilityName 取值：`);
console.log([...abilityNames].sort().map((a) => `  ${a}`).join("\n") || "  (无)");

// 对照：creatorUnitTagIndex 非 0 但不在 Egg 表里的
const orphan = borns.filter((b) => {
  const c = tagOf(b.m_creatorUnitTagIndex, b.m_creatorUnitTagRecycle);
  return c !== "0/0" && !eggByTag.has(c);
});
console.log(`\ncreatorTag 非 0 且不在 Egg 表的 Born：${orphan.length} 条（前 10）`);
for (const b of orphan.slice(0, 10)) {
  console.log(`  ${txt(b.m_unitTypeName).padEnd(12)} born@${String(b._gameloop).padStart(5)} creator=${tagOf(b.m_creatorUnitTagIndex, b.m_creatorUnitTagRecycle)} ability=${txt(b.m_creatorAbilityName)}`);
}

// 建筑：Init → Done 配对（同 tag）给出的天然 start/finish
console.log("\n建筑 Init→Done 配对（同 tag，天然起止时刻）：");
const doneByTag = new Map(dones.map((d) => [tagOf(d.m_unitTagIndex, d.m_unitTagRecycle), d]));
for (const i of inits) {
  const t = tagOf(i.m_unitTagIndex, i.m_unitTagRecycle);
  const d = doneByTag.get(t);
  const delta = d ? d._gameloop - i._gameloop : null;
  console.log(
    `  ${txt(i.m_unitTypeName).padEnd(22)} init@${String(i._gameloop).padStart(5)}  done@${d ? String(d._gameloop).padStart(5) : "  无"}  ${delta !== null ? `Δ=${delta} 帧 = ${(delta / 22.4).toFixed(1)}s@22.4fps / ${(delta / 16).toFixed(1)}s@16fps` : ""}`,
  );
}
