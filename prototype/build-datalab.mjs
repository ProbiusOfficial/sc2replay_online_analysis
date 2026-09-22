// 生成「录像数据分析工作台」原型：prototype/data-lab.html
//
// 只读 sampleTest/ 的录像，导出官方回放 overlay 口径的完整计分字段时间序列，
// 内联进单文件 HTML。不改动 js/ 下的生产代码。
//
//   node prototype/build-datalab.mjs
//
// 字段口径：`NNet.Replay.Tracker.SPlayerStatsEvent.m_stats` 的 39 个
// `m_scoreValue*` 字段（官方客户端 overlay 的 Resources / Income / Spending /
// Army / Losses 全部来自这一张表）。短名映射见 FIELD_MAP。
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
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
const {
  decodeReplayInitData,
  decodeReplayDetails,
  decodeReplayTrackerEvents,
} = await import(join(REPO, "js/worker/decoder/events.js"));
const { extractReplayData } = await import(join(REPO, "js/worker/decoder/replay_data.js"));

const short = (e) => e.slice(e.lastIndexOf(".") + 1);

// ---- 中文名表 -------------------------------------------------------------
// 直接复用站点运行时的 data.json（unit / build / upgrade / change 四张表），
// 保证原型与线上显示同一套译名，不另造一份。
const TR = JSON.parse(readFileSync(join(REPO, "data.json"), "utf8"));

const trIndex = (() => {
  const m = new Map();
  for (const table of ["upgrade", "unit", "build"]) {
    for (const [k, v] of Object.entries(TR[table] ?? {})) m.set(k.toLowerCase(), String(v.zh ?? k));
  }
  for (const group of Object.values(TR.change ?? {})) {
    for (const [k, v] of Object.entries(group ?? {})) m.set(k.toLowerCase(), String(v.zh ?? k));
  }
  return m;
})();
const hasIn = (table, name) =>
  !!name && Object.keys(TR[table] ?? {}).some((k) => k.toLowerCase() === String(name).toLowerCase());

/** 变形/切换类噪声：这些行是「模式的开关」而不是新建造，按旧链路口径过滤掉。 */
const MORPH_NOISE = /(Lowered|Flying|Uprooted|Phased|Burrowed|Cocoon|LiberatorAG|VikingAssault|SiegeMode|AssaultMode)/;

/**
 * 建造项分类。`_kind` 只有 `"unit"` / `"recall"` 两种，真正的「建筑 / 单位 / 升级」
 * 要靠 data.json 的名表反查——这是旧链路 `itemIsTechUpgrade()` 的同一套判据。
 */
function classifyBuildItem(it) {
  if (it._kind === "recall") return "recall";
  const u = it.unit || "";
  if (MORPH_NOISE.test(u)) return "morph";
  if (it.is_worker) return "worker";
  if (hasIn("upgrade", u)) return "upgrade";
  if (hasIn("build", u)) return "building";
  if (hasIn("unit", u)) return "unit";
  return "unknown";
}

// ---- 字段短名 -------------------------------------------------------------
// 分组对应官方 overlay 的表，便于前端按「官方口径」组织。
const FIELD_MAP = {
  m_scoreValueMineralsCurrent: "mCur",
  m_scoreValueVespeneCurrent: "vCur",
  m_scoreValueMineralsCollectionRate: "mRate",
  m_scoreValueVespeneCollectionRate: "vRate",
  m_scoreValueFoodUsed: "supUsed",
  m_scoreValueFoodMade: "supMade",
  m_scoreValueWorkersActiveCount: "workers",

  m_scoreValueMineralsUsedCurrentEconomy: "mUsedEco",
  m_scoreValueMineralsUsedCurrentTechnology: "mUsedTech",
  m_scoreValueMineralsUsedCurrentArmy: "mUsedArmy",
  m_scoreValueMineralsUsedInProgressEconomy: "mProgEco",
  m_scoreValueMineralsUsedInProgressTechnology: "mProgTech",
  m_scoreValueMineralsUsedInProgressArmy: "mProgArmy",
  m_scoreValueMineralsUsedActiveForces: "mActive",

  m_scoreValueVespeneUsedCurrentEconomy: "vUsedEco",
  m_scoreValueVespeneUsedCurrentTechnology: "vUsedTech",
  m_scoreValueVespeneUsedCurrentArmy: "vUsedArmy",
  m_scoreValueVespeneUsedInProgressEconomy: "vProgEco",
  m_scoreValueVespeneUsedInProgressTechnology: "vProgTech",
  m_scoreValueVespeneUsedInProgressArmy: "vProgArmy",
  m_scoreValueVespeneUsedActiveForces: "vActive",

  m_scoreValueMineralsLostEconomy: "mLostEco",
  m_scoreValueMineralsLostTechnology: "mLostTech",
  m_scoreValueMineralsLostArmy: "mLostArmy",
  m_scoreValueVespeneLostEconomy: "vLostEco",
  m_scoreValueVespeneLostTechnology: "vLostTech",
  m_scoreValueVespeneLostArmy: "vLostArmy",

  m_scoreValueMineralsKilledEconomy: "mKillEco",
  m_scoreValueMineralsKilledTechnology: "mKillTech",
  m_scoreValueMineralsKilledArmy: "mKillArmy",
  m_scoreValueVespeneKilledEconomy: "vKillEco",
  m_scoreValueVespeneKilledTechnology: "vKillTech",
  m_scoreValueVespeneKilledArmy: "vKillArmy",

  m_scoreValueMineralsFriendlyFireEconomy: "mFfEco",
  m_scoreValueMineralsFriendlyFireTechnology: "mFfTech",
  m_scoreValueMineralsFriendlyFireArmy: "mFfArmy",
  m_scoreValueVespeneFriendlyFireEconomy: "vFfEco",
  m_scoreValueVespeneFriendlyFireTechnology: "vFfTech",
  m_scoreValueVespeneFriendlyFireArmy: "vFfArmy",
};
const FIELDS = Object.keys(FIELD_MAP);

/** `m_name` 解出来是 `{0:79,1:66,...}` 的字节映射，不是 Uint8Array。 */
function decodeChars(v) {
  if (!v) return "";
  if (typeof v === "string") return v;
  const arr = Array.isArray(v) ? v : Object.keys(v).sort((a, b) => a - b).map((k) => v[k]);
  return new TextDecoder().decode(new Uint8Array(arr.map((c) => c & 0xff)));
}

const RACE_BY_CODE = { 0: "R", 1: "Z", 2: "P", 3: "T" };
const RACE_FULL = { T: "Terran", Z: "Zerg", P: "Protoss", R: "Random" };

const round1 = (n) => Math.round(n * 10) / 10;

const names = readdirSync(SAMPLE_DIR).filter((n) => n.endsWith(".SC2Replay")).sort();
const out = [];

for (const file of names) {
  const buf = new Uint8Array(readFileSync(join(SAMPLE_DIR, file)));
  const archive = await openMpqArchive(buf, { decompressor: createWasmDecompressor() });
  const headerBytes = archive.readHeaderContent();
  const sel = selectProtocolTables(probeBaseBuild(headerBytes).baseBuild);

  const init = decodeReplayInitData(sel, await archive.readFile("replay.initData"));
  const details = decodeReplayDetails(sel, await archive.readFile("replay.details"));
  const tracker = decodeReplayTrackerEvents(sel, await archive.readFile("replay.tracker.events"));

  // 元信息走生产管线的 extractReplayData，避免另造一份口径。
  const meta = await extractReplayData(buf, { decompressor: createWasmDecompressor() });

  const slots = init.m_syncLobbyState?.m_lobbyState?.m_slots ?? [];
  const users = init.m_syncLobbyState?.m_userInitialData ?? [];
  const setup = tracker.filter((e) => short(e._event) === "SPlayerSetupEvent");

  const nameByPid = new Map();
  for (const s of setup) {
    const slot = slots[s.m_slotId] ?? {};
    const user = users[s.m_userId] ?? {};
    nameByPid.set(s.m_playerId, {
      // 注意：**不要**在这里兜底成 `P${pid}`。AI/观战位常常在 userInitialData 里
      // 取不到名字，但 `extractReplayData()` 能正确给出（如「电脑难度（专家）」），
      // 兜底值非空会把它挡掉。空值留给下游按优先级回退。
      name: decodeChars(user.m_name),
      clan: decodeChars(user.m_clanTag),
      race: RACE_BY_CODE[slot.m_racePref?.m_race] ?? "?",
      color: slot.m_colorPref?.m_color ?? null,
    });
  }

  // ---- 统计事件 → 按 pid 分列的时间序列 ----------------------------------
  const statsEvents = tracker.filter((e) => short(e._event) === "SPlayerStatsEvent");
  const pids = [...new Set(statsEvents.map((e) => e.m_playerId))].sort((a, b) => a - b);

  // 时间基准：让时间轴总长等于生产管线给出的 game_length（自洽，不另立口径）。
  const maxLoop = Math.max(...statsEvents.map((e) => e._gameloop), 1);
  const totalSec = meta.game_length;
  const loopToSec = totalSec / maxLoop;

  const byPid = new Map(pids.map((p) => [p, { t: [], series: Object.fromEntries(FIELDS.map((f) => [FIELD_MAP[f], []])) }]));

  for (const e of statsEvents) {
    const bucket = byPid.get(e.m_playerId);
    if (!bucket) continue;
    bucket.t.push(round1(e._gameloop * loopToSec));
    const s = e.m_stats ?? {};
    for (const f of FIELDS) {
      const raw = s[f];
      let v = typeof raw === "number" ? raw : 0;
      // Food 是 1/4096 定点（实测 `778240 / 4096 = 190.0` 恰为整数）。
      if (f === "m_scoreValueFoodUsed" || f === "m_scoreValueFoodMade") v = round1(v / 4096);
      bucket.series[FIELD_MAP[f]].push(v);
    }
  }

  // extractReplayData 的玩家顺序 == SPlayerSetupEvent 的 playerId 顺序（1v1 已核）。
  const flat = meta.teams.flatMap((t) => t.players);
  if (flat.length !== pids.length) {
    throw new Error(`${file}: 玩家数 ${flat.length} != stats playerId 数 ${pids.length}，顺序假设不成立`);
  }

  // ---- 建造顺序 ----------------------------------------------------------
  // `start_time` 的单位是 **Normal 基准游戏秒**（= gameLoop / 16），
  // 而本页时间轴的 `t` 取自统计事件的实际 loop 区间（见 loopToSec）。
  // 所以要把 start_time 换算回 loop（×16）再乘 loopToSec，才能落在同一根轴上。
  // 这个因子是**按样本实测推导**的，不写死 1.4：LotV 得 1/1.4、老录像得 1，各自自洽。
  const boScale = 16 * loopToSec;

  const players = pids.map((pid, i) => {
    const info = nameByPid.get(pid) ?? {};
    const b = byPid.get(pid);
    const src = flat[i];
    const race = src.race && src.race !== "?" ? src.race : (info.race ?? "?");

    const bo = (src.build_order ?? [])
      .map((it) => {
        const kind = classifyBuildItem(it);
        return {
          t: round1(Math.max(0, (it.start_time ?? 0) * boScale)),
          raw: it.start_time ?? 0,
          supply: it.supply ?? null,
          unit: it.unit || "",
          zh: it._kind === "recall" ? "星空加速" : (trIndex.get(String(it.unit).toLowerCase()) ?? it.unit ?? ""),
          kind,
        };
      })
      .filter((it) => it.kind !== "morph")
      .sort((x, y) => x.t - y.t || (x.supply ?? 0) - (y.supply ?? 0));

    return {
      pid,
      name: info.name || src.name,
      clan: info.clan ?? "",
      race,
      raceFull: RACE_FULL[race] ?? "Unknown",
      t: b.t,
      series: b.series,
      buildOrder: bo,
      workerDeaths: (src.worker_deaths ?? []).map((w) => ({
        t: round1(Math.max(0, (w.time ?? 0) * boScale)),
        unit: w.unit || "",
      })),
    };
  });

  const sampleCount = players[0]?.t.length ?? 0;
  out.push({
    file,
    map: meta.map_name,
    duration: round1(meta.game_length),
    build: meta.client_version,
    region: meta.region,
    playedAt: meta.start_time,
    winner: meta.winner,
    winnerPid: players.find((p) => p.name === meta.winner)?.pid ?? null,
    sampleCount,
    sampleIntervalSec: sampleCount > 1 ? round1(totalSec / (sampleCount - 1)) : 0,
    players,
  });

  const boInfo = players.map((p) => {
    const c = {};
    for (const it of p.buildOrder) c[it.kind] = (c[it.kind] || 0) + 1;
    const last = p.buildOrder.at(-1)?.t ?? 0;
    // 自检：最后一条建造项应落在时长附近（>60% 且 ≤100%），否则说明时间轴换算错了。
    const cover = totalSec ? last / totalSec : 0;
    return `${p.name}:${p.buildOrder.length}项{${Object.entries(c).map(([k, v]) => `${k}=${v}`).join(",")}}尾=${last}s(${(cover * 100).toFixed(0)}%)`;
  });

  console.log(
    `${file}\n   ${meta.map_name} · ${Math.floor(meta.game_length / 60)}:${String(Math.round(meta.game_length % 60)).padStart(2, "0")} · build ${meta.client_version}\n` +
      `   ${players.map((p) => `${p.clan ? `<${p.clan}>` : ""}${p.name}(${p.race})`).join("  vs  ")}   采样 ${sampleCount} 点 / ${FIELDS.length} 字段 / 间隔 ${round1(totalSec / (sampleCount - 1))}s\n` +
      `   建造顺序 boScale=${round1(boScale * 1000) / 1000}  ${boInfo.join("  |  ")}`,
  );
}

// ---- 注入模板 -------------------------------------------------------------
const tpl = readFileSync(join(HERE, "data-lab.template.html"), "utf8");
const payload = JSON.stringify({ generated: new Date().toISOString().slice(0, 10), replays: out });
const html = tpl.replace("/*__DATA__*/null", payload);
const dest = join(HERE, "data-lab.html");
writeFileSync(dest, html);

const kb = (n) => `${(n / 1024).toFixed(0)}KB`;
console.log(`\n→ ${dest}  (${kb(html.length)}，其中数据 ${kb(payload.length)})`);
