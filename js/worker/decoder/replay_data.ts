/**
 * P1c：`ReplayData` 组装 —— 取代旧 Pyodide 链路的 `extract_replay_data`。
 *
 * ## 对齐对象
 *
 * 不是官方 s2protocol，而是**已下线的旧链路**：`tools/baseline/parse_script.py`（原
 * `js/parse_script.js` 的 `PARSE_SCRIPT`，基于 sc2reader 1.9.0 + spawningtool 3.0.0，
 * 现已迁出 `js/` 且不再被站点加载）。参照物是 `tests/baseline/*.json`
 * 冻结快照，见 `scripts/freeze-baseline.py`。验收：`scripts/verify-replay-data.mjs`。
 *
 * ## 输出形状（逐字段复刻，别自作主张）
 *
 * ```jsonc
 * {
 *   "map_name": "Taito Citadel LE",   // details.m_title（UTF-8），**不是** m_mapName
 *   "game_length": 1026,              // frames // fps（fps 见下）
 *   "client_version": 95841,          // header.m_version.m_build
 *   "region": "us",                   // details.m_cacheHandles[0] 的 server 段，小写；sg → sea
 *   "start_time": 1772479397,         // details.m_timeUTC − real_length（见 startTimeSeconds）
 *   "winner": "Shameless",            // 胜方玩家名；多队用 " / " 拼
 *   "teams": [{ "players": [ ... ] }],
 *   "chat": [{ "time", "player", "pid", "target", "text" }],
 *   "sandbox": { "units": [...], "minX", "minY", "maxX", "maxY" }
 * }
 * ```
 *
 * ## 时间基准有两套，**不要统一**
 *
 * | 字段 | 基准 | 来源 |
 * | ---- | ---- | ---- |
 * | `build_order[].start_time`、`worker_deaths[].time`、`chat[].time` | **16 fps** | `frame >> 4` |
 * | `game_length`、`stats[].minute`、`workers_curve[].t` | **fps 由常量集决定**（22.4 / 16） | `frame / fps` |
 * | `sandbox.units[]` 的 `b / d / done / chg[][0] / pos[]` | **同上（常量集 fps）** | `frame / fps` |
 *
 * 前者沿用 sc2reader 的 `Event.second = frame >> 4`；后者沿用 spawningtool 的
 * `FRAMES_PER_SECOND`（`lotv_constants` = 22.4、`hots_constants` / `coop_constants` = 16）。
 * 两套混用是旧链路的真实行为，页面上的图表也依赖它，所以照搬。
 *
 * ## fps 怎么定（`spawningtool/parser.py::set_constants`）
 *
 * ```python
 * if cooperative: constants = coop_constants          # fps = 16
 * else:
 *     constants = lotv if expansion == 'LotV' else hots
 *     for event in tracker_events:                    # 伪造「早期 LotV 用 HotS 常量」的补丁
 *         if event.frame > 1: break
 *         if event is PlayerStatsEvent and frame == 1 and int(food_used) == 12:
 *             constants = lotv                        # → fps = 22.4
 * ```
 *
 * `expansion` 用**依赖 hash** 判定（`chrono.ts::expansionFromDetails`），不是 build 号 ——
 * `HotS/38215` 与 `LotV/base` 的 build 区间在数值上重叠，build 号无法唯一确定资料片。
 */

import {
  decodeReplayAttributesEvents,
  decodeReplayDetails,
  decodeReplayGameEvents,
  decodeReplayHeader,
  decodeReplayInitData,
  decodeReplayMessageEvents,
  decodeReplayTrackerEvents,
  type DecodedEvent,
} from "./events.js";
import { openMpqArchive, type MpqArchive, type MpqDecompressor } from "./mpq.js";
import { probeBaseBuild, selectProtocolTables } from "./protocols/index.js";
import {
  collectTagToUnitName,
  extractBuildOrder,
  toLegacyEntry,
  type BuildOrderEntry,
} from "./build_order.js";
import { collectRecalls, mergeRecalls, type RecallRow } from "./recall.js";
import {
  chronoModel,
  collectChronoBoosts,
  expansionFromDetails,
  isCooperative,
  unixTimestampFromDetails,
  userIdToPlayerId,
} from "./chrono.js";
import { abilityLinksForBuild } from "./data/ability_links.generated.js";
import {
  GAME_SPEED_ATTRIBUTE_ID,
  GAME_SPEED_FACTOR,
  GAME_SPEED_LOOKUP,
  RACE_ATTRIBUTE_ID,
  RACE_LOOKUP,
} from "./data/lobby_properties.generated.js";

/**
 * 全局属性的 scope id（`resources.py:370` 硬编码的 `self.attributes[16]`）。
 * 玩家自己的属性在 scope == 玩家槽位 id，**不是**这一格。
 */
const GLOBAL_ATTRIBUTE_SCOPE = 16;

/** 旧链路 `WORKER_NAMES`。只有这三类才算农民。 */
const WORKER_NAMES: readonly string[] = ["SCV", "Probe", "Drone"];

/** `lotv_constants.FRAMES_PER_SECOND`。 */
const LOTV_FRAMES_PER_SECOND = 22.4;
/** `hots_constants` / `coop_constants.FRAMES_PER_SECOND`。 */
const BASIC_FRAMES_PER_SECOND = 16;

/**
 * sc2reader 的 `self.game_fps`（`resources.py:248`，**恒为 16.0**，全库只有这一处写它）。
 * 这是 `start_time` 那条链的底数，与上面 spawningtool 的常量集**无关**。
 */
const SC2READER_BASE_FPS = 16.0;
/** sc2reader 的 `self.game_fps * 1.4`（`resources.py:279`，`build >= 34784` 视为 LotV 录像）。 */
const SC2READER_LOTV_FPS = 22.4;
/** `resources.py:278` 的 LotV 判定阈值。 */
const SC2READER_LOTV_MIN_BUILD = 34784;

// ---------------------------------------------------------------------------
// 输出类型
// ---------------------------------------------------------------------------

export interface ReplayDataChatRow {
  /** `frame >> 4`（16 fps 秒）。 */
  time: number;
  /** 发言者名。查不到时为空串（旧链路 `getattr(ev.player, "name", "")`）。 */
  player: string;
  /**
   * **`_userid.m_userId`（工作集槽位 id），不是最终 pid。**
   * 旧链路打印的是 sc2reader 的 `ChatEvent.pid`，即协议里那 5 bit 的原值。
   */
  pid: number;
  /** 聊天频道：0=公开、2=盟友、4=观察者。 */
  target: number;
  text: string;
}

/** `build_order` 里的一条。`_kind` 为 `"unit"`，recall 行为 `"recall"`。 */
export type ReplayDataBuildOrderRow =
  | {
      start_time: number;
      supply: number | null;
      unit: string;
      _kind: "unit";
      is_worker: boolean;
    }
  | {
      start_time: number;
      supply: null;
      unit: "";
      _kind: "recall";
      target: null;
      is_worker: false;
    };

export interface ReplayDataWorkerDeath {
  /** `frame >> 4`（16 fps 秒）。 */
  time: number;
  unit: string;
  /** 击杀者单位名；拿不到则回落击杀方玩家名；都没有为 `null`。 */
  killer: string | null;
}

export interface ReplayDataWorkersCurvePoint {
  /** 分钟（`sec / 60`，sec 走 fps 基准）。 */
  t: number;
  /** 该秒的 `workers_active_count`，缺失按前值填充。 */
  w: number;
}

export interface ReplayDataStatsRow {
  /** 1 起的分钟序号（`int(dsec / 60) + 1`）。 */
  minute: number;
  workers: number;
  army_minerals: number;
  army_vespene: number;
  minerals_rate: number;
  vespene_rate: number;
  food_used: number;
  food_made: number;
  workers_killed: number;
  workers_lost: number;
}

/** 沙盘模拟里的一条单位记录（{@link ReplayDataSandbox}）。 */
export interface ReplayDataSandboxUnit {
  /** 初始单位类型名；此后的演化看 {@link chg}。 */
  n: string;
  /** upkeep 玩家 id；**0 = 中立地图单位**（矿/气泉/可破坏物/Xel'Naga 塔）。 */
  p: number;
  /** 出生时刻（秒，`gameloop / fps`，与 `game_length` 同基准）。 */
  b: number;
  /** 出生坐标（世界单位 = tracker 原值 ×4，建筑/矿永不动，直接画在出生点）。 */
  x: number;
  y: number;
  /** 死亡时刻（秒）；活到终局为 `null`。 */
  d: number | null;
  /** 死亡坐标（世界单位，`SUnitDiedEvent` 自带精确落点）；未死为 `null`。 */
  dx: number | null;
  dy: number | null;
  /** 建造完成时刻（秒，首个 `SUnitDoneEvent`）；非建造单位为 `null`。 */
  done: number | null;
  /** 类型变化 `[秒, 新类型名][]`（变形 / 模式切换 / 装载运输变更）。 */
  chg: Array<[number, string]>;
  /**
   * 位置采样扁平表 `[秒, x, y, ...]`。**只有动过的单位才有**：
   * `SUnitPositionsEvent` 只上报「在动」的单位（实测每 240 gameloop 一批、
   * 按 unitTagIndex 滚动轮转，开局约 2 分钟后才开始出现），采样点之间由渲染端插值。
   * 语义照搬 sc2reader `events/tracker.py::UnitPositionsEvent`：
   * `unit_index` 从 `m_firstUnitIndex` 起每三元组累加 `items[i]`，坐标 = `items[i+1] * 4`。
   */
  pos?: number[];
}

/**
 * 沙盘模拟数据 —— 从 tracker 流重建的「单位级时间线」，是页面上沙盘回放的唯一数据源。
 *
 * 录像里**没有地图几何**：地图尺寸、地形、出生点都不在录像文件里。坐标范围从单位
 * 坐标极值推得；矿线 / 出生点这些「地形锚点」来自开局第 0 帧的中立单位（它们自带坐标）。
 */
export interface ReplayDataSandbox {
  /** 全部单位（中立 / 农民 / 军队 / 建筑），出生序。 */
  units: ReplayDataSandboxUnit[];
  /** 坐标极值（世界单位）。 */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** `upgrades[]` 的一条：某玩家一项科技完成。 */
export interface ReplayDataUpgradeRow {
  /** upkeep 玩家 id。 */
  pid: number;
  /** 升级内部名（如 `TerranInfantryWeaponsLevel1`、`zerglingattackspeed`、`Stimpack`）。 */
  name: string;
  /** 完成时刻（秒，`gameloop / fps`，与 `game_length` 同基准）。 */
  time: number;
  /** `SUpgradeEvent` 的原始 count（同名累计次数，绝大多数为 1）。 */
  count: number;
}

/** 某玩家按**整秒桶**聚合的指令数（`SCmdEvent`，与 `game_length` 同基准的秒下标）。 */
export interface ReplayDataCommandSeries {
  /** 每秒指令数 —— APM(t) = Σ apm[t−60..t]。 */
  apm: number[];
  /**
   * 每秒**去重**指令数 —— EPM 近似。口径：同一玩家 `ability:cmdIndex` 签名相同、
   * 间隔 ≤16 gameloop 的连点折叠为 1 次（业界无统一 EPM 定义，这是自洽近似，
   * 别当官方口径引用）。
   */
  epm: number[];
}

/**
 * 指令聚合（键 = upkeep 玩家 id 的十进制字符串）与镜头轨迹。
 * 镜头扁平表 `[pid, 秒, x, y, ...]`，坐标 = 原始值 / 64（实测世界单位，含 2018 老 build），
 * 按时间升序 —— 同一玩家任一时刻的「当前镜头」= 最后一条 ≤t 的样本。
 */
export interface ReplayDataCameraTrack {
  commands: Record<string, ReplayDataCommandSeries>;
  cameras: number[];
}

/**
 * `SPlayerStatsEvent` 的 **39 个计分字段**，写法是官方 `m_scoreValue*` 的**后缀**。
 *
 * 这 39 个字段就是官方客户端回放 overlay（Resources / Income / Spending / Army / Losses）
 * 所用的**同一张表**；`ReplayDataStatsRow` 只挑了其中 10 个做逐分钟摘要，
 * 完整的 39 条时间序列走 {@link ReplayDataStatsSeries}。
 *
 * 顺序按官方口径分组，不要随手重排 —— 前端的分组展示按这个顺序读。
 */
export const STATS_SERIES_FIELDS = [
  // 资源余额
  "MineralsCurrent",
  "VespeneCurrent",
  // 收入
  "MineralsCollectionRate",
  "VespeneCollectionRate",
  // 人口
  "FoodUsed",
  "FoodMade",
  "WorkersActiveCount",
  // 支出 · 存量（Used Current）
  "MineralsUsedCurrentEconomy",
  "MineralsUsedCurrentTechnology",
  "MineralsUsedCurrentArmy",
  "VespeneUsedCurrentEconomy",
  "VespeneUsedCurrentTechnology",
  "VespeneUsedCurrentArmy",
  // 支出 · 在建（Used In Progress）
  "MineralsUsedInProgressEconomy",
  "MineralsUsedInProgressTechnology",
  "MineralsUsedInProgressArmy",
  "VespeneUsedInProgressEconomy",
  "VespeneUsedInProgressTechnology",
  "VespeneUsedInProgressArmy",
  // 支出 · 活跃兵力（Used Active Forces）
  "MineralsUsedActiveForces",
  "VespeneUsedActiveForces",
  // 战损（Lost）
  "MineralsLostEconomy",
  "MineralsLostTechnology",
  "MineralsLostArmy",
  "VespeneLostEconomy",
  "VespeneLostTechnology",
  "VespeneLostArmy",
  // 战果（Killed）
  "MineralsKilledEconomy",
  "MineralsKilledTechnology",
  "MineralsKilledArmy",
  "VespeneKilledEconomy",
  "VespeneKilledTechnology",
  "VespeneKilledArmy",
  // 自伤（Friendly Fire）—— 实测短局全为 0，长局才有值，只能做条件性发现项
  "MineralsFriendlyFireEconomy",
  "MineralsFriendlyFireTechnology",
  "MineralsFriendlyFireArmy",
  "VespeneFriendlyFireEconomy",
  "VespeneFriendlyFireTechnology",
  "VespeneFriendlyFireArmy",
] as const;

/**
 * 39 个计分字段的**完整**时间序列（列式）。
 *
 * 与 `stats[]` 的区别很重要：
 *
 * | | `stats[]` | `stats_series` |
 * |---|---|---|
 * | 粒度 | **逐分钟桶**（同分钟后到者覆盖） | **事件原始采样点**（每 160 gameloop ≈ 7.1 实秒 @LotV） |
 * | 缺失处理 | 前向填充到 `maxMinute` | **不填充、不插值** —— 有几点就是几点 |
 * | 时间基准 | `int(loop/16/1.4/60)+1`（硬编码 1.4） | `gameloop / fps`，**与 `game_length` 同一基准** |
 * | 字段数 | 10 | **39** |
 *
 * 所以画曲线要用 `stats_series`；`stats[]` 只作为旧链路对拍与逐分钟摘要保留。
 */
export interface ReplayDataStatsSeries {
  /** 采样点时间（秒），与 `game_length` 同基准。长度 = 采样点数。 */
  t: number[];
  /** 字段后缀（见 {@link STATS_SERIES_FIELDS}）→ 序列，长度恒等于 `t.length`。 */
  v: Record<string, number[]>;
}

export interface ReplayDataPlayer {
  name: string;
  /** **`pick_race` 的首字母**（大厅属性），可能是 `"R"`（Random）。取不到时 `"?"`。 */
  race: string;
  build_order: ReplayDataBuildOrderRow[];
  worker_deaths: ReplayDataWorkerDeath[];
  workers_curve: ReplayDataWorkersCurvePoint[];
  /** 逐分钟摘要（10 字段，前向填充）—— 旧链路口径，保留用于对拍。 */
  stats: ReplayDataStatsRow[];
  /** 39 字段的完整原始采样序列 —— **画图用这个**。 */
  stats_series: ReplayDataStatsSeries;
}

export interface ReplayDataTeam {
  players: ReplayDataPlayer[];
}

export interface ReplayData {
  map_name: string;
  game_length: number;
  client_version: number | null;
  region: string;
  start_time: number | null;
  winner: string | null;
  teams: ReplayDataTeam[];
  chat: ReplayDataChatRow[];
  /** 沙盘模拟的单位级时间线（`SUnitBorn/Init/Done/Died/TypeChange/OwnerChange/Positions` 重建）。 */
  sandbox: ReplayDataSandbox;
  /** 科技升级完成时间线（`SUpgradeEvent`，含 `Spray` 系 / `RewardDance` 系等噪声行，由展示端过滤）。 */
  upgrades: ReplayDataUpgradeRow[];
  /** 逐秒 APM/EPM 桶与镜头轨迹（`SCmdEvent` / `SCameraUpdateEvent`）。 */
  tracks: ReplayDataCameraTrack;
}

export interface ExtractReplayDataOptions {
  /** 解压器。Worker / Node 里传 `createWasmDecompressor()`。 */
  decompressor?: MpqDecompressor;
  /**
   * 覆盖时间戳（秒）。缺省用 `details.m_timeUTC`。仅测试用。
   * 注意它同时影响 `start_time` 与建造时长回滚 —— 与旧链路一致。
   */
  replayTimestamp?: number | null;
  /**
   * `build_order` 的虫族起点口径，透传给 `extractBuildOrder`。
   *
   * - `true`（**默认，要发布的行为**）：靠 Egg tag 回溯取精确起点，零数据表依赖。
   * - `false`（parity）：虫族也一律查表，口径迁就旧链路，**仅供对拍**。
   *
   * 两者产出**同一组单位**，只允许起点有秒级取整差（`scripts/verify-build-order.mjs`
   * 已把这条钉死）。对拍脚本用 `false` 拿到与基线**逐条精确相等**的 build_order，
   * 再用 `true` 复核单位集合不变。
   */
  exactZergStart?: boolean;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const decoder = new TextDecoder();

/** 定长字节串取字符串。协议里所有名字都是 `Uint8Array`。 */
function text(value: unknown): string {
  if (value instanceof Uint8Array) return decoder.decode(value);
  return value == null ? "" : String(value);
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** `functools.partial(max, 0)` —— sc2reader 的 `clamp`。 */
function clamp(value: unknown): number {
  return Math.max(0, num(value));
}

/**
 * Python `int()` —— 向零截断。JS 的 `Math.trunc` 语义相同，
 * **不要**用 `Math.floor`（对负数会差 1，虽然本模块的输入都是非负）。
 */
function pyInt(value: number): number {
  return Math.trunc(value);
}

/**
 * `DepotFile(bytes).server`：`bytes[4:8].decode("utf8").strip("\x00 ").lower()`。
 *
 * 句柄是定长 40 字节：`fourcc(4) + server(4) + sha256(32)`。
 * Python 的 `strip("\x00 ")` 去的是**两端**的 `\x00` 与空格。
 */
function depotServer(handle: Uint8Array): string {
  const raw = decoder.decode(handle.subarray(4, 8));
  return raw.replace(/^[\x00 ]+/, "").replace(/[\x00 ]+$/, "").toLowerCase();
}

/** `replay.region`：第一个 cacheHandle 的 server，`sg` 归一到 `sea`。 */
function replayRegion(details: Record<string, unknown>): string {
  const handles = details.m_cacheHandles as Uint8Array[] | undefined;
  if (!handles || handles.length === 0) return "";
  const server = depotServer(handles[0]);
  return server === "sg" ? "sea" : server;
}

// ---------------------------------------------------------------------------
// 实体（players / teams）
// ---------------------------------------------------------------------------

/**
 * 一个「实体」= `initData.lobby_state.slots` 里 control=2 且非观察，或 control=3（电脑）。
 *
 * `pid` 的分配**包含观察者**（观察者也占号），所以不能拿槽位下标当 pid ——
 * 这是 `sc2reader/resources.py::load_players` 的原始行为，必须照搬。
 */
interface Entity {
  pid: number;
  /** 槽位下标。 */
  sid: number;
  isHuman: boolean;
  isObserver: boolean;
  /** 队伍号（`slot.team_id + 1`）；观察者为 null。 */
  teamId: number | null;
  /** 0 起的 details 下标（观察者不占）。 */
  detailIndex: number;
  name: string;
  /** 大厅属性 `Race` 的可读名；查不到为 null。 */
  pickRace: string | null;
  /** details 里的 `m_result`：1=Win / 2=Loss / 其他=null。 */
  result: "Win" | "Loss" | null;
  /** `slot.m_userId`，用于把 chat / 指令的 userId 映射到实体。 */
  userId: number | null;
}

/**
 * 复刻 `load_players` 的槽位遍历。
 *
 * ```python
 * for slot_id, slot in enumerate(initData["lobby_state"]["slots"]):
 *     if slot["control"] == 2:
 *         if slot["observe"] == 0: Participant(...); detail_id += 1; player_id += 1
 *         else:                    Observer(...);                     player_id += 1
 *     elif slot["control"] == 3 and detail_id < len(details["players"]):
 *         Computer(...); detail_id += 1; player_id += 1
 *     # control 0/1（空位 / 开放位）不产生实体，也不占号
 * ```
 */
function buildEntities(
  initData: Record<string, unknown>,
  details: Record<string, unknown>,
  attributes: ReturnType<typeof decodeReplayAttributesEvents>,
): Entity[] {
  const lobbyState = (initData.m_syncLobbyState as Record<string, unknown> | undefined)
    ?.m_lobbyState as Record<string, unknown> | undefined;
  const slots = (lobbyState?.m_slots as Record<string, unknown>[] | undefined) ?? [];
  const userData =
    ((initData.m_syncLobbyState as Record<string, unknown> | undefined)
      ?.m_userInitialData as Record<string, unknown>[] | undefined) ?? [];
  const detailPlayers = (details.m_playerList as Record<string, unknown>[] | undefined) ?? [];

  const entities: Entity[] = [];
  let detailIndex = 0;
  let pid = 1;

  for (let sid = 0; sid < slots.length; sid += 1) {
    const slot = slots[sid];
    const control = num(slot.m_control, 0);
    const observe = num(slot.m_observe, 0);
    const userIdRaw = slot.m_userId;
    const userId = userIdRaw === null || userIdRaw === undefined ? null : num(userIdRaw);

    if (control === 2) {
      const isHuman = true;
      if (observe === 0) {
        const detail = detailPlayers[detailIndex];
        entities.push({
          pid,
          sid,
          isHuman,
          isObserver: false,
          teamId: slot.m_teamId === null || slot.m_teamId === undefined ? null : num(slot.m_teamId) + 1,
          detailIndex,
          name: userData[userId ?? -1] ? text(userData[userId ?? -1].m_name) : "",
          pickRace: pickRaceOf(attributes, pid),
          result: resultOf(detail),
          userId,
        });
        detailIndex += 1;
        pid += 1;
      } else {
        // 观察者也占一个 pid，但不进 teams。
        entities.push({
          pid,
          sid,
          isHuman,
          isObserver: true,
          teamId: null,
          detailIndex: -1,
          name: userData[userId ?? -1] ? text(userData[userId ?? -1].m_name) : "",
          pickRace: null,
          result: null,
          userId,
        });
        pid += 1;
      }
      continue;
    }

    if (control === 3 && detailIndex < detailPlayers.length) {
      const detail = detailPlayers[detailIndex];
      entities.push({
        pid,
        sid,
        isHuman: false,
        isObserver: false,
        teamId: slot.m_teamId === null || slot.m_teamId === undefined ? null : num(slot.m_teamId) + 1,
        detailIndex,
        name: text(detail.m_name),
        pickRace: pickRaceOf(attributes, pid),
        result: resultOf(detail),
        userId,
      });
      detailIndex += 1;
      pid += 1;
    }
    // control 0 / 1：空位与开放位，不产生实体。
  }

  return entities;
}

/** `details.m_result`：1=Win、2=Loss、其它=None。 */
function resultOf(detail: Record<string, unknown> | undefined): "Win" | "Loss" | null {
  if (!detail) return null;
  const r = num(detail.m_result, -1);
  if (r === 1) return "Win";
  if (r === 2) return "Loss";
  return null;
}

/**
 * `objects.py::Player.__init__`：`pick_race = attribute_data.get("Race", "Unknown")`。
 *
 * 注意链路：`attributes.events` 的 4 字符码 → `RACE_LOOKUP` → 可读名；
 * **查不到时 sc2reader 置 `None`（不是回落 "Unknown"）** —— 因为键仍会被写入 dict。
 */
function pickRaceOf(
  attributes: ReturnType<typeof decodeReplayAttributesEvents>,
  pid: number,
): string | null {
  const scope = attributes.scopes[pid];
  const list = scope?.[RACE_ATTRIBUTE_ID];
  if (!list || list.length === 0) return "Unknown"; // 键缺失 → `.get(..., "Unknown")`
  // 同一 (scope, attrid) 多次出现时后者覆盖（`attributes[player][name] = value`）。
  const raw = decoder.decode(list[list.length - 1].value);
  return Object.prototype.hasOwnProperty.call(RACE_LOOKUP, raw) ? RACE_LOOKUP[raw] : null;
}

/** 旧链路 `(player.pick_race or "?")[0]`。 */
function raceInitial(pickRace: string | null): string {
  const s = pickRace || "?";
  return s.length > 0 ? s[0] : "?";
}

// ---------------------------------------------------------------------------
// start_time
// ---------------------------------------------------------------------------

/**
 * `replay.speed` —— 全局 scope（16）里 `Game Speed`（attrid 3000）的可读名。
 *
 * `resources.py:370`：`self.speed = self.attributes[16].get("Game Speed", 1.0)`。
 * 键缺失时 sc2reader 塞进去的是数字 `1.0`，随后 `GAME_SPEED_FACTOR[exp].get(speed, 1.0)`
 * 也查不到、照样回落到 `1.0` —— 所以两种「没有」在数值上等价，这里统一返回 `null`
 * 表示「用默认系数 1.0」，不区分。
 */
function gameSpeedOf(attributes: ReturnType<typeof decodeReplayAttributesEvents>): string | null {
  const list = attributes.scopes[GLOBAL_ATTRIBUTE_SCOPE]?.[GAME_SPEED_ATTRIBUTE_ID];
  if (!list || list.length === 0) return null;
  // 同一 (scope, attrid) 多次出现时后者覆盖（`attributes[player][name] = value`）。
  const raw = decoder.decode(list[list.length - 1].value);
  return Object.prototype.hasOwnProperty.call(GAME_SPEED_LOOKUP, raw) ? GAME_SPEED_LOOKUP[raw] : null;
}

/**
 * `replay.start_time` → Unix 秒。sc2reader 两处叠加：
 *
 * ```python
 * fps = 16.0
 * if 34784 <= self.build: fps = 22.4                  # resources.py:274-279
 * length = utils.Length(seconds=int(frames / fps))    # resources.py:280-282
 * real   = length.seconds // FACTOR[expansion].get(speed, 1.0)   # resources.py:431-433
 * start  = unix_timestamp - real.seconds              # resources.py:435-437
 * ```
 *
 * **这里的 `fps` 由 build 号决定，与 `game_length` 那套（spawningtool 的常量集、由
 * `cooperative` / 资料片决定）是两条独立规则。** 两者在本仓库样本上对 CN_PVT 故意不同：
 * `game_length` = 6323 // 16 = 395（coop 常量），而 `start_time` 的中间量 = 6323 // 22.4 = 282。
 * 别为了「看起来统一」把它们合成一个 fps。
 *
 * `expansion` 未知时 sc2reader 会 `KeyError`（`GAME_SPEED_FACTOR[""]`），这里回落到系数 1.0。
 */
function startTimeSeconds(
  unixTs: number,
  build: number,
  frames: number,
  expansion: string | null,
  speed: string | null,
): number {
  const fps = build >= SC2READER_LOTV_MIN_BUILD ? SC2READER_LOTV_FPS : SC2READER_BASE_FPS;
  const lengthSeconds = pyInt(frames / fps);
  const table: Readonly<Record<string, number>> | undefined = GAME_SPEED_FACTOR[expansion ?? ""];
  const factor = table?.[speed ?? ""] ?? 1.0;
  return unixTs - Math.floor(lengthSeconds / factor);
}

// ---------------------------------------------------------------------------
// 常量集（fps）
// ---------------------------------------------------------------------------

/**
 * `set_constants` 的 fps 判定。
 *
 * `PlayerStatsEvent` 的 `food_used` 在 sc2reader 里是 `clamp(stats[29]) / 4096.0`，
 * 而那个 hack 判的是 `int(event.food_used) == 12`（截断后的值）。
 */
function framesPerSecond(
  cooperative: boolean,
  expansion: string | null,
  trackerEvents: DecodedEvent[],
): number {
  if (cooperative) return BASIC_FRAMES_PER_SECOND; // coop_constants

  let fps = expansion === "LotV" ? LOTV_FRAMES_PER_SECOND : BASIC_FRAMES_PER_SECOND;
  for (const event of trackerEvents) {
    // 原始顺序即帧序；`if event.frame > 1: break`
    if (event._gameloop > 1) break;
    if (!event._event.endsWith("SPlayerStatsEvent")) continue;
    if (event._gameloop !== 1) continue;
    const stats = event.m_stats as Record<string, unknown> | undefined;
    if (pyInt(clamp(stats?.m_scoreValueFoodUsed) / 4096) === 12) {
      fps = LOTV_FRAMES_PER_SECOND;
    }
  }
  return fps;
}

// ---------------------------------------------------------------------------
// 单位对象（worker_deaths 需要）
// ---------------------------------------------------------------------------

interface UnitObject {
  name: string;
  /** `owner` = **upkeeper**（不是 controller），见 `context.py::handleUnitBornEvent`。 */
  ownerPid: number;
}

function tagKey(index: unknown, recycle: unknown): string {
  return `${num(index, -1)}/${num(recycle, -1)}`;
}

/**
 * 复刻 `sc2reader/engine/plugins/context.py` 的 `replay.objects` 维护。
 *
 * 关键点（都踩过）：
 * - **`SUnitDiedEvent` 不会从 `objects` 里删单位**（只删 `active_units`），所以死掉的
 *   单位仍可被后续事件查到 —— 击杀者早已阵亡也能拿到名字。
 * - **`owner` 取的是 `m_upkeepPlayerId`**（`handleUnitBornEvent` 里 `unit.owner = unit_upkeeper`），
 *   不是 `m_controlPlayerId`。两者在本仓库样本里相同，但别想当然。
 * - `change_type` 只改**类型名**，不改 owner。
 */
function buildUnitObjects(trackerEvents: DecodedEvent[]): Map<string, UnitObject> {
  const objects = new Map<string, UnitObject>();
  for (const event of trackerEvents) {
    const name = event._event;
    if (name.endsWith("SUnitBornEvent") || name.endsWith("SUnitInitEvent")) {
      const key = tagKey(event.m_unitTagIndex, event.m_unitTagRecycle);
      if (objects.has(key)) continue; // `if event.unit_id in replay.objects` → 复用旧对象
      objects.set(key, {
        name: text(event.m_unitTypeName),
        ownerPid: num(event.m_upkeepPlayerId, 0),
      });
      continue;
    }
    if (name.endsWith("SUnitTypeChangeEvent")) {
      const unit = objects.get(tagKey(event.m_unitTagIndex, event.m_unitTagRecycle));
      if (unit) unit.name = text(event.m_unitTypeName);
      continue;
    }
    if (name.endsWith("SUnitOwnerChangeEvent")) {
      const unit = objects.get(tagKey(event.m_unitTagIndex, event.m_unitTagRecycle));
      if (unit) unit.ownerPid = num(event.m_upkeepPlayerId, 0);
    }
  }
  return objects;
}

// ---------------------------------------------------------------------------
// 沙盘单位时间线
// ---------------------------------------------------------------------------

/**
 * 中立单位的保留判据：保留**地图锚点**（矿 / 气泉 / Xel'Naga 塔 / 可破坏物）。
 * 其余中立单位（野怪 CarrionBird、ForceField、LabBot 之类）对沙盘是噪声，丢弃。
 * 开局 1 秒内的中立单位无条件保留（出生点 / 矿线一定在里面）。
 */
const SANDBOX_NEUTRAL_KEEP = /MineralField|Geyser|XelNagaTower|Destructible|Collapsible/;
/** 开局多少 gameloop 内的中立单位无条件保留。 */
const SANDBOX_NEUTRAL_START_LOOPS = 16;

interface SandboxUnit {
  index: number;
  n: string;
  p: number;
  bLoop: number;
  x: number;
  y: number;
  dLoop: number | null;
  dx: number | null;
  dy: number | null;
  doneLoop: number | null;
  chg: Array<[number, string]>;
  pos: number[];
}

/**
 * 从 tracker 流重建沙盘单位时间线。
 *
 * 与 `buildUnitObjects` 的关键差异：那里只查「名字 / 归属」，这里还要**位置与生死**，
 * 所以必须维护「unitTagIndex → 活着的单位」活动表 —— `SUnitPositionsEvent` 只带
 * tag 的 index 部分（没有 recycle），死亡即从活动表摘除，index 复用自然落到新单位。
 *
 * 实测对拍结论（`scripts/research/probe-sandbox-poc.mjs`，5 样本 × 含 2018 build 62848）：
 * 位置事件不包含任何静态单位（矿 / 不可移动建筑 0 命中），映射到的移动轨迹全部合理
 * （侦察 Probe 走位、凤凰骚扰、军队聚群、同单位相邻采样速度连续）。
 */
function buildSandbox(trackerEvents: DecodedEvent[], fps: number): ReplayDataSandbox {
  const toSec = (loop: number): number => Math.round((loop / Math.max(fps, 1)) * 10) / 10;

  const units = new Map<string, SandboxUnit>();
  const order: SandboxUnit[] = [];
  const byIndex = new Map<number, SandboxUnit>();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const trackPoint = (x: number, y: number): void => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  for (const event of trackerEvents) {
    const name = event._event;
    const loop = num(event._gameloop, 0);

    if (name.endsWith("SUnitBornEvent") || name.endsWith("SUnitInitEvent")) {
      const key = tagKey(event.m_unitTagIndex, event.m_unitTagRecycle);
      if (units.has(key)) continue; // 与 buildUnitObjects 同一防重判据
      const x = num(event.m_x, 0) * 4;
      const y = num(event.m_y, 0) * 4;
      const unit: SandboxUnit = {
        index: num(event.m_unitTagIndex, -1),
        n: text(event.m_unitTypeName),
        p: num(event.m_upkeepPlayerId, 0),
        bLoop: loop,
        x,
        y,
        dLoop: null,
        dx: null,
        dy: null,
        doneLoop: null,
        chg: [],
        pos: [],
      };
      units.set(key, unit);
      order.push(unit);
      byIndex.set(unit.index, unit);
      trackPoint(x, y);
      continue;
    }

    if (name.endsWith("SUnitTypeChangeEvent")) {
      const unit = units.get(tagKey(event.m_unitTagIndex, event.m_unitTagRecycle));
      if (unit) unit.chg.push([loop, text(event.m_unitTypeName)]);
      continue;
    }

    if (name.endsWith("SUnitOwnerChangeEvent")) {
      const unit = units.get(tagKey(event.m_unitTagIndex, event.m_unitTagRecycle));
      if (unit) unit.p = num(event.m_upkeepPlayerId, 0);
      continue;
    }

    if (name.endsWith("SUnitDoneEvent")) {
      const unit = units.get(tagKey(event.m_unitTagIndex, event.m_unitTagRecycle));
      if (unit && unit.doneLoop === null) unit.doneLoop = loop;
      continue;
    }

    if (name.endsWith("SUnitDiedEvent")) {
      const key = tagKey(event.m_unitTagIndex, event.m_unitTagRecycle);
      const unit = units.get(key);
      if (unit) {
        unit.dLoop = loop;
        unit.dx = num(event.m_x, 0) * 4;
        unit.dy = num(event.m_y, 0) * 4;
        trackPoint(unit.dx, unit.dy);
        if (byIndex.get(unit.index) === unit) byIndex.delete(unit.index);
      }
      continue;
    }

    if (name.endsWith("SUnitPositionsEvent")) {
      const items = event.m_items;
      if (!Array.isArray(items)) continue;
      let index = num(event.m_firstUnitIndex, 0);
      for (let i = 0; i + 2 < items.length; i += 3) {
        index += num(items[i], 0);
        const x = num(items[i + 1], 0) * 4;
        const y = num(items[i + 2], 0) * 4;
        const unit = byIndex.get(index);
        if (!unit) continue; // 位置事件指向的单位必须仍活着，否则是映射错误，宁缺毋滥
        unit.pos.push(toSec(loop), x, y);
        trackPoint(x, y);
      }
      continue;
    }
  }

  const outUnits: ReplayDataSandboxUnit[] = [];
  for (const u of order) {
    if (u.p === 0 && u.bLoop > SANDBOX_NEUTRAL_START_LOOPS && !SANDBOX_NEUTRAL_KEEP.test(u.n)) {
      continue;
    }
    const rec: ReplayDataSandboxUnit = {
      n: u.n,
      p: u.p,
      b: toSec(u.bLoop),
      x: u.x,
      y: u.y,
      d: u.dLoop === null ? null : toSec(u.dLoop),
      dx: u.dx,
      dy: u.dy,
      done: u.doneLoop === null ? null : toSec(u.doneLoop),
      chg: u.chg.map(([loop2, n2]) => [toSec(loop2), n2] as [number, string]),
    };
    if (u.pos.length > 0) rec.pos = u.pos;
    outUnits.push(rec);
  }

  return {
    units: outUnits,
    minX: Number.isFinite(minX) ? minX : 0,
    minY: Number.isFinite(minY) ? minY : 0,
    maxX: Number.isFinite(maxX) ? maxX : 0,
    maxY: Number.isFinite(maxY) ? maxY : 0,
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export async function extractReplayData(
  buffer: Uint8Array,
  options: ExtractReplayDataOptions = {},
): Promise<ReplayData> {
  const archive = await openMpqArchive(buffer, { decompressor: options.decompressor });
  const headerBytes = archive.readHeaderContent();
  if (!headerBytes) throw new Error("录像缺少 MPQ user data header —— 不是有效的 SC2Replay？");
  const baseBuild = probeBaseBuild(headerBytes).baseBuild;
  const selection = selectProtocolTables(baseBuild);

  const header = decodeReplayHeader(selection, headerBytes);
  const details = decodeReplayDetails(selection, await readRequired(archive, "replay.details"));
  const initData = decodeReplayInitData(selection, await readRequired(archive, "replay.initData"));
  const attributes = decodeReplayAttributesEvents(
    await readRequired(archive, "replay.attributes.events"),
  );
  const tracker = decodeReplayTrackerEvents(
    selection,
    await readRequired(archive, "replay.tracker.events"),
  );
  const game = decodeReplayGameEvents(selection, await readRequired(archive, "replay.game.events"));
  const message = decodeReplayMessageEvents(
    selection,
    await readRequired(archive, "replay.message.events"),
  );

  const version = (header.m_version as Record<string, unknown> | undefined) ?? {};
  const build = num(version.m_build, 0);
  const cooperative = isCooperative(initData);
  const expansion = expansionFromDetails(details);
  const fps = framesPerSecond(cooperative, expansion, tracker);

  // ---- 帧数 ----
  //
  // HotS 2.0.0.23925 的补丁：header 里的帧数会小于实际最后一帧，sc2reader 用后者覆盖
  // （`resources.py:614-621`）。仅在该 baseBuild 生效。
  const eventFrames = [...tracker, ...game, ...message].map((e) => e._gameloop);
  let frames = num(header.m_elapsedGameLoops, 0);
  if (baseBuild === 23925 && eventFrames.length > 0) {
    frames = Math.max(frames, Math.max(...eventFrames));
  }

  const unixTs =
    options.replayTimestamp !== undefined
      ? options.replayTimestamp
      : unixTimestampFromDetails(details);

  // `start_time` = `unix_timestamp - real_length`，不是裸的 `unix_timestamp`
  // （sc2reader 的 `replay.start_time` 是**开局**时刻，而 `m_timeUTC` 是结束时刻）。
  const startTime =
    unixTs === null
      ? null
      : startTimeSeconds(unixTs, build, frames, expansion, gameSpeedOf(attributes));

  const entities = buildEntities(initData, details, attributes);
  const players = entities.filter((e) => !e.isObserver);
  // `replay.player` 只含非观察者 —— `killer.name` 的回落必须走这张表（观察者拿不到名字）。
  const nameByPid = new Map<number, string>(players.map((e) => [e.pid, e.name]));
  // `ev.player` 对 chat 走的是实体表（观察者也有名字）。
  const nameByUserId = new Map<number, string>();
  for (const e of entities) {
    if (e.userId !== null && !nameByUserId.has(e.userId)) nameByUserId.set(e.userId, e.name);
  }

  // ---- build_order（三路混合 + 时空加速 + 星空加速）----
  const userToPlayer = userIdToPlayerId(initData, details);
  const model = chronoModel(unixTs, expansion, cooperative);
  const links = abilityLinksForBuild(build, expansion);
  const boosts = collectChronoBoosts({
    gameEvents: game,
    userToPlayer,
    tagToUnitName: collectTagToUnitName(tracker),
    links,
    model,
    totalFrames: frames,
  });
  const extracted = extractBuildOrder(tracker, {
    // 默认口径：虫族走 Egg 精确起点（比查表更准，这是要发布的行为）。
    exactZergStart: options.exactZergStart ?? true,
    replayTimestamp: unixTs,
    chrono: { boosts, multiplier: model.multiplier },
  });
  const recalls = collectRecalls({ gameEvents: game, userToPlayer, links });
  const buildOrders = mergeRecalls(extracted.byPlayer, recalls);

  // ---- worker_deaths / workers_curve / stats ----
  const unitObjects = buildUnitObjects(tracker);
  const workerDeaths = new Map<number, ReplayDataWorkerDeath[]>();
  // 旧链路是**全局累计计数**（`worker_kills_cum[pid] += 1`），不是每分钟重新计数；
  // `worker_kills_by_min[pid][minute]` 存的是那一刻的累计值。
  const workerKillsCum = new Map<number, number>();
  const workerLossesCum = new Map<number, number>();
  const killsByMinute = new Map<number, Map<number, number>>();
  const lossesByMinute = new Map<number, Map<number, number>>();
  const workersSecBucket = new Map<number, Map<number, number>>();
  const statsRaw = new Map<number, Map<number, ReplayDataStatsRow>>();
  // 39 字段的原始采样序列（列式）。与 statsRaw 刻意分开放，互不影响：
  // statsRaw 是「按分钟覆盖」，这里是「每个事件一个点、按到达顺序追加」。
  const statsSeries = new Map<number, ReplayDataStatsSeries>();
  const upgrades: ReplayDataUpgradeRow[] = [];

  for (const event of tracker) {
    if (event._event.endsWith("SUnitDiedEvent")) {
      const key = tagKey(event.m_unitTagIndex, event.m_unitTagRecycle);
      const unit = unitObjects.get(key);
      if (!unit) continue; // `if not unit: continue`
      if (!WORKER_NAMES.includes(unit.name)) continue;

      const ownerPid = unit.ownerPid;
      const sec = event._gameloop >> 4; // 16 fps 基准
      const killerPid = num(event.m_killerPlayerId, 0);
      const killerUnit = unitObjects.get(tagKey(event.m_killerUnitTagIndex, event.m_killerUnitTagRecycle));
      // `killing_unit.name` 优先；为空则回落击杀方**玩家名**（不是单位名）。
      let killerName: string | null = killerUnit ? killerUnit.name : null;
      if (!killerName) killerName = nameByPid.get(killerPid) ?? null;

      if (ownerPid !== 0) {
        const list = workerDeaths.get(ownerPid);
        const row: ReplayDataWorkerDeath = { time: sec, unit: unit.name, killer: killerName };
        if (list) list.push(row);
        else workerDeaths.set(ownerPid, [row]);

        const minute = Math.max(1, pyInt(sec / 1.4 / 60) + 1);
        const total = (workerLossesCum.get(ownerPid) ?? 0) + 1;
        workerLossesCum.set(ownerPid, total);
        upsert(lossesByMinute, ownerPid, minute, total);
      }
      if (killerPid !== 0) {
        const minute = Math.max(1, pyInt(sec / 1.4 / 60) + 1);
        const total = (workerKillsCum.get(killerPid) ?? 0) + 1;
        workerKillsCum.set(killerPid, total);
        upsert(killsByMinute, killerPid, minute, total);
      }
      continue;
    }

    if (event._event.endsWith("SUpgradeEvent")) {
      // 科技升级完成时间线（沙盘 HUD 的「科技」行）。时间与 game_length 同基准；
      // `Spray*` / `RewardDance*` / `GameHeartActive` 这类噪声行原样保留，由展示端过滤。
      upgrades.push({
        pid: num(event.m_playerId, 0),
        name: text(event.m_upgradeTypeName),
        time: Math.round((event._gameloop / Math.max(fps, 1)) * 10) / 10,
        count: num(event.m_count, 1),
      });
      continue;
    }

    if (event._event.endsWith("SPlayerStatsEvent")) {
      const pid = num(event.m_playerId, 0);
      const stats = (event.m_stats as Record<string, unknown> | undefined) ?? {};
      const gsec = event._gameloop / 16.0;
      const dsec = gsec / 1.4;
      const minute = pyInt(dsec / 60) + 1;

      const bucket = statsRaw.get(pid) ?? new Map<number, ReplayDataStatsRow>();
      bucket.set(minute, {
        minute,
        workers: clamp(stats.m_scoreValueWorkersActiveCount),
        army_minerals: clamp(stats.m_scoreValueMineralsUsedCurrentArmy),
        army_vespene: clamp(stats.m_scoreValueVespeneUsedCurrentArmy),
        minerals_rate: clamp(stats.m_scoreValueMineralsCollectionRate),
        vespene_rate: clamp(stats.m_scoreValueVespeneCollectionRate),
        // sc2reader: `food_used = clamp(stats[29]) / 4096.0`，旧链路再 `int(...)`。
        food_used: pyInt(clamp(stats.m_scoreValueFoodUsed) / 4096),
        food_made: pyInt(clamp(stats.m_scoreValueFoodMade) / 4096),
        workers_killed: 0,
        workers_lost: 0,
      });
      statsRaw.set(pid, bucket);

      const secBucket = workersSecBucket.get(pid) ?? new Map<number, number>();
      secBucket.set(pyInt(dsec), clamp(stats.m_scoreValueWorkersActiveCount));
      workersSecBucket.set(pid, secBucket);

      // ---- 39 字段原始采样序列 ------------------------------------------------
      // 时间用 `gameloop / fps`，**fps 与 game_length 用的是同一个**（见 §时间基准）。
      // 不要在这里改用 `dsec`（那是硬编码 /1.4 的旧口径）——否则序列会比时间轴长 1.4 倍。
      const series = statsSeries.get(pid) ?? { t: [], v: {} as Record<string, number[]> };
      if (series.t.length === 0) {
        for (const f of STATS_SERIES_FIELDS) series.v[f] = [];
      }
      const t = event._gameloop / Math.max(fps, 1);
      series.t.push(Math.round(t * 10) / 10);
      for (const f of STATS_SERIES_FIELDS) {
        const raw = stats[`m_scoreValue${f}`];
        let value = typeof raw === "number" ? raw : 0;
        // 只有 FoodUsed / FoodMade 是 1/4096 定点（实测 49152/4096 = 12 恰为开局人口）；
        // 其余字段一律 **1:1 原始值**，不要顺手缩放。
        if (f === "FoodUsed" || f === "FoodMade") value = Math.round((value / 4096) * 10) / 10;
        series.v[f].push(value);
      }
      statsSeries.set(pid, series);
    }
  }

  // `max_minute`：**全部玩家** stats 的最大分钟（不只是当前玩家）。
  let maxMinute = 0;
  for (const bucket of statsRaw.values()) {
    for (const m of bucket.keys()) if (m > maxMinute) maxMinute = m;
  }

  // workers_curve：逐秒前向填充，从第一个采样点到最后一个采样点。
  const workersCurve = new Map<number, ReplayDataWorkersCurvePoint[]>();
  for (const [pid, secMap] of workersSecBucket) {
    if (secMap.size === 0) continue;
    const secs = [...secMap.keys()];
    const min = Math.min(...secs);
    const max = Math.max(...secs);
    let last = secMap.get(min) ?? 0;
    const curve: ReplayDataWorkersCurvePoint[] = [];
    for (let s = min; s <= max; s += 1) {
      const hit = secMap.get(s);
      if (hit !== undefined) last = hit;
      curve.push({ t: s / 60.0, w: last });
    }
    workersCurve.set(pid, curve);
  }

  // ---- chat ----
  const chat: ReplayDataChatRow[] = [];
  for (const event of message) {
    if (!event._event.endsWith("SChatMessage")) continue;
    const userId = (event._userid as Record<string, unknown> | undefined)?.m_userId;
    chat.push({
      time: event._gameloop >> 4,
      player: userId === null || userId === undefined ? "" : nameByUserId.get(num(userId)) ?? "",
      pid: userId === null || userId === undefined ? 0 : num(userId),
      target: num(event.m_recipient, 0),
      text: text(event.m_string),
    });
  }

  // ---- 沙盘单位时间线（时间与 game_length 同基准：gameloop / fps）----
  const sandbox = buildSandbox(tracker, fps);

  // ---- APM/EPM 桶 + 镜头轨迹（走 game 事件流）----
  // APM 口径对齐 starcraft2.ai（实测对拍）：`SCmdEvent`（下达指令）+
  // `SCmdUpdate*`（目标更新，一条指令派生 1~3 条）都算「动作」——原站同局平均 APM 97
  // = (SCmdEvent 1292 + SCmdUpdate 1518) / 29 分钟，逐位吻合。
  // EPM 近似：同签名（事件名/能力/粗粒度目标）≤16 gameloop 的连点折叠为 1 次；
  // 业界没有统一 EPM 定义，这是自洽近似，别当官方口径引用。
  const commandSeries: Record<string, ReplayDataCommandSeries> = {};
  const cameras: number[] = [];
  {
    let lastSig: string | null = null;
    let lastLoop = -1e9;
    let lastPid = -1;
    const bucket = (pid: number, kind: "apm" | "epm", sec: number): number[] => {
      const key = String(pid);
      commandSeries[key] ??= { apm: [], epm: [] };
      const arr = commandSeries[key][kind];
      while (arr.length <= sec) arr.push(0);
      return arr;
    };
    const isCmd = /NNet.Game.S(CmdEvent|CmdUpdateTargetPointEvent|CmdUpdateTargetUnitEvent|CmdUpdateDataEvent)$/;
    for (const event of game) {
      const uid = (event._userid as Record<string, unknown> | undefined)?.m_userId;
      const pid = uid === null || uid === undefined ? 0 : num(userToPlayer.get(num(uid)), 0);
      const loop = num(event._gameloop, 0);
      const name = event._event;

      if (name.endsWith("SCameraUpdateEvent")) {
        const target = (event.m_target as Record<string, unknown> | undefined) ?? {};
        if (target.x == null || target.y == null) continue;
        cameras.push(
          pid,
          Math.round((loop / Math.max(fps, 1)) * 10) / 10,
          Math.round(num(target.x) / 64), // 实测世界单位 = 原始值 / 64（含 2018 老 build）
          Math.round(num(target.y) / 64),
        );
        continue;
      }

      if (!isCmd.test(name)) continue;
      const sec = Math.max(0, Math.floor(loop / Math.max(fps, 1)));
      bucket(pid, "apm", sec)[sec] += 1;

      // 签名：能力（SCmdEvent）/ 事件名 + 粗粒度目标（SCmdUpdate*，quantize ≈ 8 world units）
      let sig: string;
      const abil = (event.m_abil as Record<string, unknown> | undefined) ?? null;
      if (abil) sig = `a${num(abil.m_abilLink, 0)}:${num(abil.m_abilCmdIndex, 0)}`;
      else {
        const tgt = (event.m_target as Record<string, unknown> | undefined) ?? {};
        const pt = (tgt.m_snapshotPoint ?? tgt) as Record<string, unknown>;
        sig = `${name.replace("NNet.Game.S", "")}:${Math.floor(num(pt.x) / 8192)}:${Math.floor(num(pt.y) / 8192)}:${num(tgt.m_tag, 0) % 997}`;
      }
      if (pid !== lastPid || sig !== lastSig || loop - lastLoop > 16) {
        bucket(pid, "epm", sec)[sec] += 1;
        lastSig = sig;
        lastLoop = loop;
        lastPid = pid;
      }
    }
  }

  // ---- teams / winner ----
  const teamIds = [...new Set(players.map((p) => p.teamId).filter((t): t is number => t !== null))].sort(
    (a, b) => a - b,
  );

  const teams: ReplayDataTeam[] = teamIds.map((teamId) => ({
    players: players
      .filter((p) => p.teamId === teamId)
      .map((p) => buildPlayer(p, buildOrders, workerDeaths, workersCurve, statsRaw, statsSeries, killsByMinute, lossesByMinute, maxMinute)),
  }));

  // team.result：成员结果唯一才成立，否则 "Unknown"（`load_players`）。
  const winners: string[] = [];
  for (const teamId of teamIds) {
    const members = players.filter((p) => p.teamId === teamId);
    const results = new Set(members.map((p) => p.result));
    if (results.size !== 1) continue;
    if ([...results][0] !== "Win") continue;
    winners.push(members.map((p) => p.name).join(" & "));
  }

  return {
    map_name: text(details.m_title),
    game_length: Math.floor(frames / Math.max(fps, 1)),
    client_version: build,
    region: replayRegion(details),
    start_time: startTime,
    winner: winners.length > 0 ? winners.join(" / ") : null,
    teams,
    chat,
    sandbox,
    upgrades,
    tracks: { commands: commandSeries, cameras },
  };
}

/** 读一个必需的文件；缺失就抛错（`readFile` 找不到时为 null）。 */
async function readRequired(archive: MpqArchive, name: string): Promise<Uint8Array> {
  const data = await archive.readFile(name);
  if (!data) throw new Error(`录像缺少必需的文件：${name}`);
  return data;
}

/** 把「某玩家某分钟」的累计值写进嵌套表。 */
function upsert(
  store: Map<number, Map<number, number>>,
  pid: number,
  minute: number,
  value: number,
): void {
  let bucket = store.get(pid);
  if (!bucket) {
    bucket = new Map<number, number>();
    store.set(pid, bucket);
  }
  // 同一分钟可能有多条（多次死亡落在同一分钟内），后到者覆盖 —— 与 Python 的
  // `worker_kills_by_min[pid][minute] = cum` 一致，累计值本身就是单调的。
  bucket.set(minute, value);
}

function buildPlayer(
  entity: Entity,
  buildOrders: ReadonlyMap<number, (BuildOrderEntry | RecallRow)[]>,
  workerDeaths: ReadonlyMap<number, ReplayDataWorkerDeath[]>,
  workersCurve: ReadonlyMap<number, ReplayDataWorkersCurvePoint[]>,
  statsRaw: ReadonlyMap<number, Map<number, ReplayDataStatsRow>>,
  statsSeries: ReadonlyMap<number, ReplayDataStatsSeries>,
  killsByMinute: ReadonlyMap<number, Map<number, number>>,
  lossesByMinute: ReadonlyMap<number, Map<number, number>>,
  maxMinute: number,
): ReplayDataPlayer {
  const pid = entity.pid;

  const rows = buildOrders.get(pid) ?? [];
  const build_order: ReplayDataBuildOrderRow[] = rows.map((row) => {
    if ("_kind" in row && row._kind === "recall") {
      return {
        start_time: row.start_time,
        supply: null,
        unit: "" as const,
        _kind: "recall" as const,
        target: null,
        is_worker: false as const,
      };
    }
    return toLegacyEntry(row as BuildOrderEntry);
  });

  // stats：逐分钟前向填充（`last_ek`），无任何历史则用空表。
  const bucket = statsRaw.get(pid);
  const stats: ReplayDataStatsRow[] = [];
  let lastKills = 0;
  let lastLosses = 0;
  let lastEntry: ReplayDataStatsRow | null = null;
  for (let m = 1; m <= maxMinute; m += 1) {
    const wk = killsByMinute.get(pid)?.get(m) ?? lastKills;
    const wl = lossesByMinute.get(pid)?.get(m) ?? lastLosses;
    lastKills = wk;
    lastLosses = wl;

    const raw = bucket?.get(m);
    const base: ReplayDataStatsRow = raw
      ? { ...raw }
      : lastEntry
        ? { ...lastEntry }
        : {
            minute: m,
            workers: 0,
            army_minerals: 0,
            army_vespene: 0,
            minerals_rate: 0,
            vespene_rate: 0,
            food_used: 0,
            food_made: 0,
            workers_killed: 0,
            workers_lost: 0,
          };
    if (raw) lastEntry = raw;
    base.minute = m;
    base.workers_killed = wk;
    base.workers_lost = wl;
    stats.push(base);
  }

  return {
    name: entity.name,
    race: raceInitial(entity.pickRace),
    build_order,
    worker_deaths: workerDeaths.get(pid) ?? [],
    workers_curve: workersCurve.get(pid) ?? [],
    stats,
    // 没有任何 SPlayerStatsEvent 的玩家（观战位、0 长局）给空序列，前端按空处理。
    stats_series: statsSeries.get(pid) ?? { t: [], v: {} },
  };
}
