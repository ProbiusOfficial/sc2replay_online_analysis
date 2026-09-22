/**
 * 数据适配层 —— 把生产解析器的 `ReplayData` 转成视图层（`js/lab/views.js`）要的形状。
 *
 * ## 这一层存在的唯一理由
 *
 * 视图层是从原型**逐字节提取**的（见 `scripts/extract-lab-views.mjs`），它假定数据长这样：
 *
 * ```js
 * DATA.replays[i] = {
 *   file, map, duration, build, region, playedAt, winner, sampleCount, sampleIntervalSec,
 *   players: [ { name, clan, race, raceFull, t[], series{}, buildOrder[], workerDeaths[] } ]
 * }
 * ```
 *
 * 而生产解析器给的是 `ReplayData`：39 字段是**列式**的 `stats_series`，建造顺序的
 * 「建筑/单位/升级」要靠 `data.json` 名表反查。转换集中在这里做，视图层一行都不用改。
 *
 * ## ⚠️ 一个必须对齐的坑：两名玩家的采样点数不一样
 *
 * 原型里的样本是构建期人工导出的，两个玩家等长；**真实录像不等长**
 * （实测 US_TVP：146 vs 145 —— 少一点的那方通常是先被推平的）。
 * 而 `views.js` 的 `nPts()` = `min(lenA, lenB)`，时间轴 / 事件检测 / 采样表都按**同一个索引**
 * 同时取两方的值 —— 长度不一致时 index 会对错时间点，而且**不报错，只是数据悄悄错位**。
 *
 * 所以这里把两方对齐到**同一时间网格（采样时刻的并集 + 前向填充）**，与 `ReplayData.stats[]`
 * 自己的填充口径一致。填充量记在 `alignment` 里，不藏起来。
 */

import { appState } from "../state.js";

/** 39 个计分字段的短名。**必须与原型 `build-datalab.mjs` 的 `FIELD_MAP` 完全一致。** */
export const FIELD_MAP = {
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

/** 短名列表（顺序与 `FIELD_MAP` 一致）。 */
export const SHORT_NAMES = Object.values(FIELD_MAP);

const RACE_FULL = { T: "Terran", Z: "Zerg", P: "Protoss", R: "Random" };

/**
 * 变形/模式切换类噪声 —— 这些行是「模式的开关」，不是新建造。
 * 判据与生产链路 `build_order.ts` 的排除表口径一致（见 docs/MAINTENANCE.md）。
 */
const MORPH_NOISE = /(Lowered|Flying|Uprooted|Phased|Burrowed|Cocoon|LiberatorAG|VikingAssault|SiegeMode|AssaultMode)/;

/**
 * 剥掉旧链路（spawningtool）在 build-time 表缺项时拼进单位名的错误标注，
 * 如 `GhostAlternate (Error on build time)`、`Frenzy (upgrade missing)`。
 * 这是解析层的内部状态，不属于单位名 —— 不剥掉会既查不到译名，
 * 又把报错文本原样显示给用户。
 */
const WERROR_NOISE = /\s*\((?:Error on build time|upgrade missing)\)\s*$/i;
const cleanUnitName = (u) => String(u ?? "").replace(WERROR_NOISE, "");

const r1 = (n) => Math.round(n * 10) / 10;

/* ==========================================================================
   建造项分类 —— `_kind` 只有 `unit` / `recall`，真正的类别要靠 data.json 名表反查
   ========================================================================== */

let zhIndex = null;

/**
 * 中文名索引：`data.json` 的 unit / build / upgrade / change 四张表展平。
 *
 * ⚠️ 顺序即优先级：change 表（状态名，如「兵营落地」「星轨起飞」）必须**先**展平，
 * 再让三张基础表覆盖它 —— 与旧 UI `display_helpers.js` 的「先查基础表、change 兜底」
 * 同一优先级。展平顺序写反（change 最后）会让建造顺序的兵营全部显示成「兵营落地」。
 */
function buildZhIndex() {
  const tr = appState.translationData;
  const m = new Map();
  if (!tr) return m;
  for (const group of Object.values(tr.change ?? {})) {
    for (const [k, v] of Object.entries(group ?? {})) m.set(k.toLowerCase(), String(v?.zh ?? k));
  }
  for (const table of ["upgrade", "unit", "build"]) {
    for (const [k, v] of Object.entries(tr[table] ?? {})) m.set(k.toLowerCase(), String(v?.zh ?? k));
  }
  return m;
}

function hasIn(table, name) {
  const tr = appState.translationData;
  if (!tr || !name) return false;
  const target = String(name).toLowerCase();
  return Object.keys(tr[table] ?? {}).some((k) => k.toLowerCase() === target);
}

/**
 * 建造项分类。
 *
 * `_kind` 只有 `"unit"` / `"recall"` 两种 —— **建筑 / 单位 / 升级在解析层没有区分**，
 * 必须靠 `data.json` 名表反查（与线上旧链路的 `itemIsTechUpgrade()` 同一判据）。
 * 漏了这一步，筛选器会把所有项都归进同一类。
 */
export function classifyBuildItem(it) {
  if (it._kind === "recall") return "recall";
  const u = cleanUnitName(it.unit);
  if (MORPH_NOISE.test(u)) return "morph";
  if (it.is_worker) return "worker";
  if (hasIn("upgrade", u)) return "upgrade";
  if (hasIn("build", u)) return "building";
  if (hasIn("unit", u)) return "unit";
  return "unknown";
}

/* ==========================================================================
   时间网格对齐
   ========================================================================== */

/** 采样时刻的并集，升序。 */
function unionGrid(timeArrays) {
  const set = new Set();
  for (const arr of timeArrays) for (const v of arr) set.add(v);
  return [...set].sort((a, b) => a - b);
}

/** 序列里重复时刻的个数（`长度 - 去重后长度`）。 */
const duplicatesIn = (times) => times.length - new Set(times).size;

/**
 * 把一条序列前向填充到网格上。
 * 网格首点之前的取值用该序列的第一个值（与 `stats[]` 的口径一致）；序列为空则全 0。
 */
function fillToGrid(values, ownTimes, grid) {
  const out = new Array(grid.length).fill(0);
  if (!values.length) return out;
  let k = 0;
  let cur = 0;
  for (let i = 0; i < grid.length; i++) {
    const g = grid[i];
    while (k < ownTimes.length && ownTimes[k] <= g + 1e-6) {
      cur = values[k];
      k++;
    }
    out[i] = cur;
  }
  return out;
}

/** 网格的中位间隔（秒），用于「采样间隔」展示。 */
function medianStep(grid) {
  if (grid.length < 2) return 0;
  const diffs = [];
  for (let i = 1; i < grid.length; i++) diffs.push(grid[i] - grid[i - 1]);
  diffs.sort((a, b) => a - b);
  return r1(diffs[Math.floor(diffs.length / 2)]);
}

/* ==========================================================================
   主转换
   ========================================================================== */

/** 解析器给出的 `ReplayData` → 视图层的单份录像模型。 */
function toLabReplay(file, d) {
  const raw = d.teams.flatMap((t) => t.players);

  // 视图层是两人对位布局（`players[0]` / `players[1]`）。多于两人时只取前两名并记数，
  // 让上层能如实提示「这是团队局，只显示了前两名」，而不是静默丢掉数据。
  const players = raw.slice(0, 2);

  const grid = unionGrid(players.map((p) => p.stats_series?.t ?? []));
  if (grid.length === 0) throw new Error("录像里没有玩家统计事件（SPlayerStatsEvent），无法做数据分析");

  // 对齐统计。⚠️ 不要用「Σ(网格长 - 该玩家长度)」来算补点数 —— 那会出负数，
  // 因为**同一玩家的序列里可能有重复时刻**（实测存在），并集去重后比单方还短。
  const ownLens = players.map((p) => p.stats_series?.t?.length ?? 0);
  const dups = players.map((p) => duplicatesIn(p.stats_series?.t ?? []));
  const filledPoints = players.reduce((s, p, i) => {
    const unique = (p.stats_series?.t?.length ?? 0) - dups[i];
    return s + (grid.length - unique);
  }, 0);

  const shaped = players.map((p, idx) => {
    const own = p.stats_series?.t ?? [];
    const series = {};
    for (const [long, short] of Object.entries(FIELD_MAP)) {
      const values = p.stats_series?.v?.[long.replace("m_scoreValue", "")] ?? [];
      series[short] = fillToGrid(values, own, grid);
    }

    const buildOrder = (p.build_order ?? [])
      .map((it) => {
        const unit = cleanUnitName(it.unit);
        return {
          t: Math.max(0, it.start_time ?? 0),
          supply: it.supply ?? null,
          unit,
          zh: it._kind === "recall" ? "星空加速" : (zhIndex.get(unit.toLowerCase()) ?? unit),
          kind: classifyBuildItem(it),
        };
      })
      .filter((it) => it.kind !== "morph")
      .sort((x, y) => x.t - y.t || (x.supply ?? 0) - (y.supply ?? 0));

    return {
      // `pid` 在这里是「对局内的玩家序号」，只用于对位显示（视图层的 WIN 徽标要它）。
      // 它不是协议里的 `m_playerId`，不要拿去做别的关联。
      pid: idx,
      name: p.name || "—",
      clan: "", // 生产链路尚未提取战队标签（ReplayData 里没有这个字段）
      race: p.race || "?",
      raceFull: RACE_FULL[p.race] ?? "Unknown",
      t: grid,
      series,
      buildOrder,
      workerDeaths: (p.worker_deaths ?? []).map((w) => ({ t: Math.max(0, w.time ?? 0), unit: w.unit || "" })),
    };
  });

  // `ReplayData.winner` 是**名字**不是 id；视图层的 WIN 徽标要的是玩家序号。
  const winnerPid = d.winner ? (shaped.find((p) => p.name === d.winner)?.pid ?? null) : null;

  return {
    file,
    map: d.map_name || "—",
    duration: d.game_length || 0,
    build: d.client_version ?? "—",
    region: d.region || "—",
    playedAt: d.start_time ?? null,
    winner: d.winner ?? null,
    winnerPid,
    playerCount: raw.length,
    sampleCount: grid.length,
    sampleIntervalSec: medianStep(grid),
    /**
     * 对齐信息，全部如实暴露，不藏：
     * - `gridPoints` 并集网格点数
     * - `rawSamples` 每名玩家的**原始**采样点数（含重复）
     * - `duplicateSamples` 每名玩家序列里的重复时刻数
     * - `filledPoints` 为对齐到网格而补的点数（按去重后长度算，恒 ≥ 0）
     */
    alignment: { gridPoints: grid.length, rawSamples: ownLens, duplicateSamples: dups, filledPoints },
    players: shaped,
  };
}

/**
 * 批量转换。
 *
 * @param {{file: string, data: object}[]} entries 已解析成功的录像
 * @returns {{replays: object[], failed: {file: string, error: string}[]}}
 *   单份录像转换失败**不会中断整批** —— 拖 5 个进去坏 1 个，另外 4 个照样能看。
 */
export function toLabReplays(entries) {
  zhIndex = buildZhIndex();
  const replays = [];
  const failed = [];
  for (const { file, data } of entries) {
    try {
      replays.push(toLabReplay(file, data));
    } catch (e) {
      failed.push({ file, error: e?.message ?? String(e) });
    }
  }
  return { replays, failed };
}

/** 名表是否已就绪 —— 未就绪时建造顺序的中文名会退化成英文原名（不是错误，但要知道）。 */
export function isTranslationReady() {
  return !!appState.translationData;
}
