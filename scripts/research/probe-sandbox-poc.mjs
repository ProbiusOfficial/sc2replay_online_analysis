// 沙盘回放 POC：验证 SUnitPositionsEvent 能否重建单位轨迹（docs/RESEARCH-REPLAY-ANALYSIS-FEATURES.md §6.4 遗留问题）。
//
// 解码语义照搬 sc2reader 1.9.0 `events/tracker.py::UnitPositionsEvent`：
//   unit_index = m_firstUnitIndex
//   每 3 个 items 一组 (delta, x, y)：unit_index += delta；坐标 = x*4, y*4
// 位置事件只带 unit tag 的 **index 部分**（无 recycle），用「born 建 index→单位、died 清除」的活动表映射。
//
// 用法：node scripts/research/probe-sandbox-poc.mjs [样本名过滤]

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SAMPLE_DIR = join(REPO, "sampleTest");
const filter = process.argv[2] ?? "";

const { initSync } = await import(join(REPO, "wasm/pkg/compute.js"));
initSync({ module: readFileSync(join(REPO, "wasm/pkg/compute_bg.wasm")) });
const { markComputeWasmReady, createWasmDecompressor } = await import(
  join(REPO, "js/worker/decoder/decompressors.js")
);
markComputeWasmReady();
const decompressor = createWasmDecompressor();

const { openMpqArchive } = await import(join(REPO, "js/worker/decoder/mpq.js"));
const { probeBaseBuild, selectProtocolTables } = await import(
  join(REPO, "js/worker/decoder/protocols/index.js")
);
const { decodeReplayHeader, decodeReplayTrackerEvents } = await import(
  join(REPO, "js/worker/decoder/events.js")
);

const WORKERS = new Set([
  "SCV", "Drone", "Probe", "MULE", "AutoTurret", "RobotCandy",
]);

function num(v, d = 0) {
  return typeof v === "number" ? v : d;
}
function txt(v) {
  return v instanceof Uint8Array ? new TextDecoder().decode(v) : String(v ?? "");
}
function tagKey(index, recycle) {
  return `${num(index, -1)}/${num(recycle, -1)}`;
}

/** 与未来 replay_data.ts 的组装同一套逻辑，这里独立复刻用于验证。 */
function buildSandbox(tracker) {
  const units = new Map(); // tagKey -> unit
  const byIndex = new Map(); // unitTagIndex -> unit（活动表：born 建、died 清）
  const order = []; // 出生序

  let stats = {
    born: 0, init: 0, died: 0, done: 0, typeChange: 0, ownerChange: 0,
    posEvents: 0, posApplied: 0, posMissed: 0, firstPosLoop: null,
  };

  for (const ev of tracker) {
    const name = ev._event;
    const loop = num(ev._gameloop);

    if (name.endsWith("SUnitBornEvent") || name.endsWith("SUnitInitEvent")) {
      if (name.endsWith("SUnitBornEvent")) stats.born++; else stats.init++;
      const key = tagKey(ev.m_unitTagIndex, ev.m_unitTagRecycle);
      if (units.has(key)) continue;
      const idx = num(ev.m_unitTagIndex);
      const u = {
        key,
        index: idx,
        name: txt(ev.m_unitTypeName),
        pid: num(ev.m_upkeepPlayerId),
        bornLoop: loop,
        x: num(ev.m_x) * 4,
        y: num(ev.m_y) * 4,
        diedLoop: null,
        deathXY: null,
        doneLoop: null,
        chg: [],
        pos: [],
        lastXY: null,
      };
      units.set(key, u);
      order.push(u);
      byIndex.set(idx, u);
      continue;
    }

    if (name.endsWith("SUnitTypeChangeEvent")) {
      stats.typeChange++;
      const u = units.get(tagKey(ev.m_unitTagIndex, ev.m_unitTagRecycle));
      if (u) u.chg.push([loop, txt(ev.m_unitTypeName)]);
      continue;
    }

    if (name.endsWith("SUnitOwnerChangeEvent")) {
      stats.ownerChange++;
      const u = units.get(tagKey(ev.m_unitTagIndex, ev.m_unitTagRecycle));
      if (u) u.pid = num(ev.m_upkeepPlayerId);
      continue;
    }

    if (name.endsWith("SUnitDoneEvent")) {
      stats.done++;
      const u = units.get(tagKey(ev.m_unitTagIndex, ev.m_unitTagRecycle));
      if (u && u.doneLoop == null) u.doneLoop = loop;
      continue;
    }

    if (name.endsWith("SUnitDiedEvent")) {
      stats.died++;
      const key = tagKey(ev.m_unitTagIndex, ev.m_unitTagRecycle);
      const u = units.get(key);
      const x = num(ev.m_x) * 4, y = num(ev.m_y) * 4;
      if (u) {
        u.diedLoop = loop;
        u.deathXY = [x, y];
        if (byIndex.get(u.index) === u) byIndex.delete(u.index);
      }
      continue;
    }

    if (name.endsWith("SUnitPositionsEvent")) {
      stats.posEvents++;
      if (stats.firstPosLoop == null) stats.firstPosLoop = loop;
      const items = (ev.m_items ?? []).map(Number);
      let idx = num(ev.m_firstUnitIndex);
      for (let i = 0; i + 2 < items.length; i += 3) {
        idx += items[i];
        const x = items[i + 1] * 4, y = items[i + 2] * 4;
        const u = byIndex.get(idx);
        if (!u) { stats.posMissed++; continue; }
        stats.posApplied++;
        u.pos.push(loop, x, y);
        u.lastXY = [x, y];
      }
      continue;
    }
  }

  return { units: order, stats };
}

function analyze(label, sb, totalLoops) {
  const { units, stats } = sb;
  // ⚠️ 这里的「建筑」只是按名字的粗分类，仅供统计参考（Marine 也有 Done 事件，
  // 不能拿 doneLoop 当建筑判据 —— 见下方静态校验的注释）。
  const BUILDING_RE = /CommandCenter|Orbital|Planetary|Nexus|Hatchery|Lair|Hive|SupplyDepot|Pylon|Assimilator|Extractor|Refinery|Barracks|Factory|Starport|Gateway|Forge|EngineeringBay|CyberneticsCore|TwilightCouncil|TemplarArchive|DarkShrine|Robotics|Stargate|FleetBeacon|SpawningPool|EvolutionChamber|RoachWarren|BanelingNest|HydraliskDen|Spire|GreaterSpire|UltraliskCavern|InfestationPit|CreepTumor|SpineCrawler|SporeCrawler|PhotonCannon|ShieldBattery|Bunker|MissileTurret|SensorTower|Armory|FusionCore|TechLab|Reactor/;
  const byKind = { neutral: 0, worker: 0, building: 0, army: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const withPos = [];
  for (const u of units) {
    minX = Math.min(minX, u.x); maxX = Math.max(maxX, u.x);
    minY = Math.min(minY, u.y); maxY = Math.max(maxY, u.y);
    if (u.pid === 0) byKind.neutral++;
    else if (WORKERS.has(u.name)) byKind.worker++;
    else if (BUILDING_RE.test(u.name)) byKind.building++;
    else byKind.army++;
    if (u.pos.length) withPos.push(u);
  }

  // 一致性校验 ①：位置事件应当**只包含动过的单位** —— 真正的静态单位
  // （中立矿/气泉 + 不可移动建筑）理论上一个都不该出现（2026-09-22 实测结论，
  // 见 docs/RESEARCH-REPLAY-ANALYSIS-FEATURES.md §6.4 附注）。⚠️ 不能拿
  // 「有 SUnitDoneEvent」当静态判据：Marine 造完也有 Done 事件，会得出假阳性。
  const IMMOBILE = /MineralField|Geyser|XelNagaTower|Destructible|Collapsible|SupplyDepot|Pylon|Assimilator|Extractor|Refinery|Forge|Gateway|PhotonCannon|Nexus|Hatchery|Lair|Hive|SpawningPool|EvolutionChamber|RoachWarren|BanelingNest|HydraliskDen|Spire|UltraliskCavern|InfestationPit|CreepTumor|TwilightCouncil|TemplarArchive|DarkShrine|CyberneticsCore|FleetBeacon|RoboticsFacility|RoboticsBay|Stargate|Armory|EngineeringBay|FusionCore|TechLab|Reactor|Bunker|MissileTurret|SensorTower|ShieldBattery/;
  const isStatic = (u) => (u.pid === 0 && /MineralField|Geyser|XelNaga|Destructible|Collapsible/.test(u.name)) || (u.pid !== 0 && IMMOBILE.test(u.name) && !/CommandCenter|Orbital|Planetary|Barracks|Factory|Starport/.test(u.name));
  let staticChecked = 0, staticMismatch = 0;
  for (const u of withPos) {
    if (!isStatic(u)) continue;
    for (let i = 0; i + 2 < u.pos.length; i += 3) {
      staticChecked++;
      const dx = u.pos[i + 1] - u.x, dy = u.pos[i + 2] - u.y;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) staticMismatch++;
    }
  }

  // 一致性校验 ②：死亡坐标 vs 最后已知位置（采样有延迟，距离过大才可疑）
  let deathChecked = 0, deathFar = 0;
  const farSamples = [];
  for (const u of withPos) {
    if (u.deathXY == null || u.lastXY == null) continue;
    deathChecked++;
    const d = Math.hypot(u.deathXY[0] - u.lastXY[0], u.deathXY[1] - u.lastXY[1]);
    if (d > 120) { deathFar++; if (farSamples.length < 5) farSamples.push(`${u.name}@${u.key} d=${Math.round(d)}`); }
  }

  // 采样密度：有轨迹单位的相邻点间隔（gameloop）
  const gaps = [];
  for (const u of withPos.slice(0, 200)) {
    for (let i = 3; i + 2 < u.pos.length; i += 3) gaps.push(u.pos[i] - u.pos[i - 3]);
  }
  gaps.sort((a, b) => a - b);

  const jsonRough = JSON.stringify(units.map(u => ({
    n: u.name, p: u.pid, b: u.bornLoop, x: u.x, y: u.y,
    d: u.diedLoop, g: u.chg, s: u.pos,
  }))).length;

  console.log(`\n===== ${label} =====`);
  console.log(`事件计数:`, JSON.stringify(stats));
  console.log(`单位总数 ${units.length}`, JSON.stringify(byKind));
  console.log(`坐标范围 x[${minX},${maxX}] y[${minY},${maxY}]  (${Math.round((maxX - minX) / 4)}×${Math.round((maxY - minY) / 4)} tiles)`);
  console.log(`带轨迹单位 ${withPos.length} / ${units.length}`);
  if (gaps.length) console.log(`采样间隔(grameloop) 中位 ${gaps[Math.floor(gaps.length / 2)]} · p90 ${gaps[Math.floor(gaps.length * 0.9)]}`);
  console.log(`静态单位出现在位置事件的样本: ${staticChecked} 个（预期 ≈ 0 —— 该事件只上报「在动」的单位）`);
  console.log(`死亡点 vs 末位置: ${deathChecked} 个中有 ${deathFar} 个距离>120`, farSamples.join(" ; "));
  console.log(`粗算沙盘 JSON 大小: ${(jsonRough / 1024).toFixed(0)} KB`);
}

const samples = readdirSync(SAMPLE_DIR).filter(f => f.endsWith(".SC2Replay") && f.includes(filter));
for (const f of samples) {
  const bytes = readFileSync(join(SAMPLE_DIR, f));
  const t0 = Date.now();
  const archive = await openMpqArchive(bytes, { decompressor });
  const headerBytes = archive.readHeaderContent();
  const baseBuild = probeBaseBuild(headerBytes).baseBuild;
  const selection = selectProtocolTables(baseBuild);
  const header = decodeReplayHeader(selection, headerBytes);
  void header;
  const trackerBytes = await archive.readFile("replay.tracker.events");
  const tracker = decodeReplayTrackerEvents(selection, trackerBytes);
  const totalLoops = tracker.length ? Number(tracker[tracker.length - 1]._gameloop) : 0;

  const sb = buildSandbox(tracker);
  analyze(f, sb, totalLoops);
  console.log(`(build ${baseBuild} · 解码+组装耗时 ${Date.now() - t0}ms)`);
}
