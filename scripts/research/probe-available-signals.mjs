// 探针：实测 5 个样本里「哪些信号真的有数据」。
//
// 目的：前端重设计前先钉死能力边界 —— 协议 typeinfo 里有字段 ≠ 录像里真有值。
// 本脚本只读、不改任何产物，输出人类可读清单。
//
//   node scripts/research/probe-available-signals.mjs
//   node scripts/research/probe-available-signals.mjs US_TVP
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
const { decodeReplayGameEvents, decodeReplayTrackerEvents } = await import(
  join(REPO, "js/worker/decoder/events.js")
);

const filter = process.argv[2];
const names = readdirSync(SAMPLE_DIR)
  .filter((n) => n.endsWith(".SC2Replay"))
  .filter((n) => !filter || n.includes(filter))
  .sort();

const short = (e) => e.slice(e.lastIndexOf(".") + 1);

/** 递归收集所有数值叶子的「键路径」，用于发现字段族。 */
function leafKeys(value, prefix, out) {
  if (value === null || value === undefined) return out;
  if (typeof value === "object" && !(value instanceof Uint8Array)) {
    for (const [k, v] of Object.entries(value)) leafKeys(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.add(prefix);
  }
  return out;
}

for (const name of names) {
  const archive = await openMpqArchive(
    new Uint8Array(readFileSync(join(SAMPLE_DIR, name))),
    { decompressor: createWasmDecompressor() },
  );
  const sel = selectProtocolTables(probeBaseBuild(archive.readHeaderContent()).baseBuild);
  const tracker = decodeReplayTrackerEvents(sel, await archive.readFile("replay.tracker.events"));
  const game = decodeReplayGameEvents(sel, await archive.readFile("replay.game.events"));

  console.log(`\n${"=".repeat(78)}\n### ${name}  (protocol ${sel.protocolBuild})\n${"=".repeat(78)}`);

  // ---- 1. 事件频次 --------------------------------------------------------
  const tally = (events) => {
    const m = new Map();
    for (const e of events) {
      const k = short(e._event);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m].sort((a, b) => b[1] - a[1]);
  };
  console.log(`\n-- tracker 流：${tracker.length} 条事件 --`);
  for (const [k, c] of tally(tracker)) console.log(`   ${String(c).padStart(7)}  ${k}`);
  console.log(`\n-- game 流：${game.length} 条事件 --`);
  for (const [k, c] of tally(game)) console.log(`   ${String(c).padStart(7)}  ${k}`);

  // ---- 2. SPlayerStatsEvent 的真实字段与采样 ------------------------------
  const statsEvents = tracker.filter((e) => short(e._event) === "SPlayerStatsEvent");
  if (statsEvents.length) {
    const keys = new Set();
    const nonZero = new Map();
    for (const e of statsEvents) {
      const s = e.m_stats ?? {};
      for (const [k, v] of Object.entries(s)) {
        keys.add(k);
        if (typeof v === "number" && v !== 0) nonZero.set(k, (nonZero.get(k) ?? 0) + 1);
      }
    }
    console.log(`\n-- SPlayerStatsEvent：${statsEvents.length} 条，覆盖 ${keys.size} 个字段 --`);
    console.log(`   采样帧（前 12 个 gameloop）: ${statsEvents.slice(0, 12).map((e) => e._gameloop).join(", ")}`);
    const gaps = [];
    for (let i = 1; i < Math.min(statsEvents.length, 400); i++) {
      gaps.push(statsEvents[i]._gameloop - statsEvents[i - 1]._gameloop);
    }
    const uniqGaps = [...new Set(gaps)].sort((a, b) => a - b);
    console.log(`   相邻采样间隔（前 400 条去重）: ${uniqGaps.slice(0, 8).join(", ")} gameloop`);
    console.log(`   字段（★ = 至少出现过一次非零值）：`);
    for (const k of [...keys].sort()) {
      const n = nonZero.get(k) ?? 0;
      console.log(`     ${n ? "★" : " "} ${k.padEnd(46)} 非零 ${n}/${statsEvents.length}`);
    }
  }

  // ---- 3. 关键信号的形态（坐标 / 指令 / 升级）----------------------------
  const show = (label, evName, limit = 2) => {
    const hits = game.filter((e) => short(e._event) === evName);
    console.log(`\n-- ${label}  ${evName}：${hits.length} 条 --`);
    for (const e of hits.slice(0, limit)) {
      console.log(
        "   ",
        JSON.stringify(e, (k, v) => (v instanceof Uint8Array ? `hex:${v.length}B` : v)).slice(0, 400),
      );
    }
    return hits.length;
  };

  show("位置（小地图可行性）", "SUnitPositionsEvent");
  show("指令-点目标（APM）", "SCmdUpdateTargetPointEvent");
  show("指令-单位目标（APM/EPM）", "SCmdUpdateTargetUnitEvent");
  show("指令队列状态（APM）", "SCommandManagerStateEvent");
  show("升级（科技时间线）", "SUpgradeEvent", 3);
  show("选择变化（操作分析）", "SSelectionDeltaEvent");
  show("镜头移动（视野分析）", "SCameraUpdateEvent");
  show("编队（操作分析）", "SControlGroupUpdateEvent");
  show("资源交易（团队赛）", "SResourceTradeEvent");
  show("聊天（局内消息）", "STriggerChatMessageEvent");
  show("单位易主（控制权变化）", "SUnitOwnerChangeEvent");
  show("ping（局内标记）", "STriggerPingEvent");
}

console.log("\n完成。");
