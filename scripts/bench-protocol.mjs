/**
 * 解码性能基准：确认 TS 解码器在真实录像上的耗时与吞吐。
 *
 * 关注点：`VersionedDecoder.vint()` 为了不丢 64 位精度用了 BigInt，
 * 需要确认它没有把解码拖慢到不可接受。对比基线是「官方 Python 实现」的
 * 大致量级（Python 解一场 30 分钟对局约数秒）。
 *
 * 用法：node scripts/bench-protocol.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const { initSync } = await import(join(REPO, "wasm/pkg/compute.js"));
initSync({ module: readFileSync(join(REPO, "wasm/pkg/compute_bg.wasm")) });
const { markComputeWasmReady, createWasmDecompressor } = await import(
  join(REPO, "js/worker/decoder/decompressors.js")
);
markComputeWasmReady();
const { openMpqArchive } = await import(join(REPO, "js/worker/decoder/mpq.js"));
const { selectProtocolTables, probeBaseBuild } = await import(
  join(REPO, "js/worker/decoder/protocols/index.js")
);
const events = await import(join(REPO, "js/worker/decoder/events.js"));

const decompressor = createWasmDecompressor();
const samples = readdirSync(join(REPO, "sampleTest"))
  .filter((f) => f.endsWith(".SC2Replay"))
  .sort();

console.log("流解码耗时（毫秒，含 MPQ 解压）");
console.log(
  `  ${"录像".padEnd(38)} ${"协议".padStart(6)} ${"MPQ".padStart(8)} ${"header".padStart(7)} ` +
    `${"details".padStart(8)} ${"initData".padStart(9)} ${"tracker".padStart(8)} ` +
    `${"game".padStart(8)} ${"message".padStart(8)} ${"事件数".padStart(8)}`,
);

let totalMs = 0;
let totalEvents = 0;

for (const name of samples) {
  const bytes = new Uint8Array(readFileSync(join(REPO, "sampleTest", name)));
  const t0 = performance.now();
  const archive = await openMpqArchive(bytes, { decompressor });
  const t1 = performance.now();

  const { baseBuild } = probeBaseBuild(archive.readHeaderContent());
  const selection = selectProtocolTables(baseBuild);

  const t2 = performance.now();
  events.decodeReplayHeader(selection, archive.readHeaderContent());
  const t3 = performance.now();
  events.decodeReplayDetails(selection, await archive.readFile("replay.details"));
  const t4 = performance.now();
  events.decodeReplayInitData(selection, await archive.readFile("replay.initData"));
  const t5 = performance.now();
  const tracker = events.decodeReplayTrackerEvents(
    selection,
    await archive.readFile("replay.tracker.events"),
  );
  const t6 = performance.now();
  const game = events.decodeReplayGameEvents(
    selection,
    await archive.readFile("replay.game.events"),
  );
  const t7 = performance.now();
  const message = events.decodeReplayMessageEvents(
    selection,
    await archive.readFile("replay.message.events"),
  );
  const t8 = performance.now();

  const eventCount = tracker.length + game.length + message.length;
  totalMs += t8 - t0;
  totalEvents += eventCount;

  const label = name.length > 36 ? `${name.slice(0, 33)}…` : name;
  console.log(
    `  ${label.padEnd(38)} ${String(selection.protocolBuild).padStart(6)} ` +
      `${(t1 - t0).toFixed(1).padStart(8)} ${(t3 - t2).toFixed(2).padStart(7)} ` +
      `${(t4 - t3).toFixed(2).padStart(8)} ${(t5 - t4).toFixed(2).padStart(9)} ` +
      `${(t6 - t5).toFixed(1).padStart(8)} ${(t7 - t6).toFixed(1).padStart(8)} ` +
      `${(t8 - t7).toFixed(2).padStart(8)} ${String(eventCount).padStart(8)}`,
  );
}

console.log(
  `\n合计 ${totalMs.toFixed(0)} ms / ${totalEvents.toLocaleString()} 条事件 ` +
    `= ${((totalEvents / totalMs) * 1000).toFixed(0)} 事件/秒`,
);
