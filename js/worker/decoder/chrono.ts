/**
 * 时空加速（Chrono Boost）的时间回退模型 —— 逐行为对齐 spawningtool 3.0.0。
 *
 * ## 为什么需要它
 *
 * 非虫族单位没有 Egg 那样的「开始」事件，起点只能由 `出生帧 − 建造时长` 回推。
 * 但星灵建筑被加速时，实际耗时比表里的时长短，回推出的起点会偏早。
 * spawningtool 的做法是：把加速时段与「假想的生产区间」求交，按倍率把起点**往后推**。
 *
 * ## ⚠️ 这里刻意复刻了 spawningtool 的一个**判定缺陷**（不是我们引入的）
 *
 * `set_chronoboost_data` 用**录像时间戳**决定加速模型：
 *
 * ```
 * if  expansion == 'LotV' and 1513641600 > ts > 1510617600:   倍率 1.0（4.0 的 10 秒 +100%）
 * elif (expansion == 'LotV' and 1510617600 > ts > 1441238400) or cooperative:
 *                                                            倍率 0.15（LotV 连续加速）
 * else:                                                      倍率 0.5（HotS 的 20 秒 +50%）
 * ```
 *
 * 两个时间窗口是 2015-09 ~ 2017-12。**2017-12-19 之后的录像一律掉进 `else`**，
 * 于是现代 LotV 录像被套上了 HotS 的「+50% / 20 秒」模型。
 * 实测确认：CN_ZVP（2026 年）`chronoboost_multiplier = 0.5`，加速区间长度恰好 320 帧 = 16×20。
 *
 * **本模块保持与之一致**，原因是 P1c 的目标是「换引擎但输出不变」——
 * 基线 `tests/baseline/` 冻结的就是这套数值。修掉这个缺陷属于**独立议题**，
 * 一旦修改，页面上的星灵建造时间会与旧站点不同，应在产品层面单独拍板。
 *
 * ## ⚠️ 能力 link **不是全局唯一**的（这是接入本模块时最容易踩的坑）
 *
 * 判据是 `m_abilLink`，而它随补丁漂移 —— 同一个 link 在不同 datapack 里是不同能力。
 * 实测（LotV）：link 723 在 `89720` 里是 `NexusMassRecall`，在 `96883` 里变成
 * `ChronoBoostEnergyCost`；724 又在 `97364` 里变成 `ChronoBoostEnergyCost`。
 *
 * 所以本模块**不再自带并集常量**，而是由调用方传入 `abilityLinksForBuild()` 的结果
 * （见 `data/ability_links.generated.ts`）。若传并集，US_TVP 的 3 条 `NexusMassRecall`
 * 会被误判成时空加速 —— 之前没炸只是因为下游还要求 `m_data.TargetUnit` 能解析出名字，
 * 而 recall 是点目标。那是「碰巧正确」，不是「设计正确」。
 *
 * ## 已验证
 *
 * CN_ZVP `Goblincore`：Nexus 加速区间 `[967, 1287]`，Probe 出生 1087、表值 268.8 帧
 * → `overlap = 1087 − max(967, 818.2) = 120`，`reduction = int(120 × 0.5) = 60`
 * → 起点 `878.2`，与 spawningtool 逐位一致。
 */

import { type AbilityLinks } from "./data/ability_links.generated.js";
import type { DecodedEvent } from "./events.js";

const GAME_LOOPS_PER_SECOND = 16;

/** HotS：20 秒 × 16 fps。 */
const HOTS_BOOST_LOOPS = 16 * 20;
/** 4.0 过渡期：10 秒 × 22.4。 */
const LOTV40_BOOST_LOOPS = 22.4 * 10;

/** 4.0 过渡期窗口（秒）。 */
const WINDOW_LOTV40_START = 1510617600;
const WINDOW_LOTV40_END = 1513641600;
/** LotV 连续加速窗口（秒）。 */
const WINDOW_LOTV_START = 1441238400;

export type ChronoKind = "hots" | "lotv" | "lotv40";

export interface ChronoModel {
  kind: ChronoKind;
  /** 加速倍率的**扣减比例**：`实际耗时 = 表值 / (1 + multiplier)` 的等价实现是 `起点 += overlap × multiplier`。 */
  multiplier: number;
  /** 单次加速的持续帧数。`lotv`（连续模型）不用这个值。 */
  durationLoops: number;
}

/**
 * spawningtool 选择加速模型的条件。
 *
 * @param unixTimestamp 录像完成时间（Unix 秒）
 * @param expansion `"LotV"` / `"HotS"` / `"WoL"`
 * @param cooperative `m_gameOptions.m_cooperative`（或任意 slot 有 commander）
 */
export function chronoModel(
  unixTimestamp: number | null | undefined,
  expansion: string | null | undefined,
  cooperative: boolean,
): ChronoModel {
  const ts = unixTimestamp ?? 0;

  // Python: `expansion == 'LotV' and 1513641600 > ts > 1510617600`
  if (expansion === "LotV" && ts > WINDOW_LOTV40_START && ts < WINDOW_LOTV40_END) {
    return { kind: "lotv40", multiplier: 1, durationLoops: LOTV40_BOOST_LOOPS };
  }

  // Python: `expansion == 'LotV' and 1510617600 > ts > 1441238400 or cooperative`
  // 注意 `and` 优先级高于 `or`，所以 cooperative 单独就能命中这一支 —— 必须保留。
  if ((expansion === "LotV" && ts > WINDOW_LOTV_START && ts < WINDOW_LOTV40_START) || cooperative) {
    return { kind: "lotv", multiplier: 0.15, durationLoops: 0 };
  }

  return { kind: "hots", multiplier: 0.5, durationLoops: HOTS_BOOST_LOOPS };
}

/**
 * 估算资料片。**仅作为 `expansionFromDetails()` 的兜底** —— 它不是权威判据。
 *
 * 阈值取自各资料片最后一个 ladder 补丁的 baseBuild；对本仓库的样本
 * （62848 起，全为 LotV）没有影响，WoL/HotS 分支未实测。
 *
 * ⚠️ 与 sc2reader 的口径不同：sc2reader 用**依赖 hash** 判资料片（见
 * `expansionFromDetails`），不用 build 号。两者只在 HotS 晚期 / LotV 早期的
 * 重叠段（build 约 34784~40500）会分歧。别拿它当权威。
 */
export function expansionFromBaseBuild(baseBuild: number | null | undefined): "WoL" | "HotS" | "LotV" {
  const b = baseBuild ?? 0;
  if (b >= 38749) return "LotV"; // LotV 上线（3.0）
  if (b >= 26414) return "HotS"; // HotS 上线（2.0.4）
  return "WoL";
}

/**
 * 依赖 hash → 资料片。sha256 的原文是暴雪的标准依赖名，**顺序即优先级**。
 *
 * 逐字对应 `sc2reader/resources.py::register_default_datapacks` 之前的判定：
 *
 * ```python
 * dependency_hashes = [d.hash for d in details["cache_handles"]]
 * if sha256(b"Standard Data: Void.SC2Mod").hexdigest() in dependency_hashes:    expansion = "LotV"
 * elif sha256(b"Standard Data: Swarm.SC2Mod").hexdigest() in dependency_hashes:  expansion = "HotS"
 * elif sha256(b"Standard Data: Liberty.SC2Mod").hexdigest() in dependency_hashes: expansion = "WoL"
 * else:                                                                          expansion = ""
 * ```
 *
 * ⚠️ 是 `if/elif`，所以**必须先查 LotV**：实测一份 LotV 录像的 cacheHandles 里
 * Void / Swarm / Liberty 三份依赖**同时存在**（US_TVP 的 9 条句柄里三者都有）。
 */
const DEPENDENCY_HASHES: ReadonlyArray<readonly [string, "WoL" | "HotS" | "LotV"]> = [
  ["d92dfc48c484c59154270b924ad7d57484f2ab9a47621c7ab16431bf66c53b40", "LotV"],
  ["66093832128453efffbb787c80b7d3eec1ad81bde55c83c930dea79c4e505a04", "HotS"],
  ["421c8aa0f3619b652d23a2735dfee812ab644228235e7a797edecfe8b67da30e", "WoL"],
];

/**
 * 从 `replay.details.m_cacheHandles` 取依赖句柄的 sha256 段。
 *
 * 句柄是定长 40 字节：`fourcc(4) + uint32(4) + sha256(32)`（实测 9 条全部 40 字节，
 * 第 0..4 是 `s2ma`、第 4..8 是常量、第 8..40 才是 hash）。
 */
function cacheHandleHash(handle: unknown): string | null {
  if (!(handle instanceof Uint8Array) || handle.length < 40) return null;
  let hex = "";
  for (let i = 8; i < 40; i += 1) hex += handle[i].toString(16).padStart(2, "0");
  return hex;
}

/**
 * 资料片判定 —— **权威版**，与 sc2reader 同源（依赖 hash）。
 *
 * 返回 `null` 表示依赖列表里没有标准资料片依赖（自定义 mod / 合作任务改版等），
 * 调用方可以退回 `expansionFromBaseBuild(baseBuild)`。
 *
 * 为什么不能只用 build 号：`HotS/38215` 与 `LotV/base` 的框选范围在数值上重叠
 * （见 `data/ability_links.generated.ts` 文件头），build 号无法唯一确定资料片。
 */
export function expansionFromDetails(details: unknown): "WoL" | "HotS" | "LotV" | null {
  const handles = readPath(details, ["m_cacheHandles"]);
  if (!Array.isArray(handles)) return null;
  const present = new Set<string>();
  for (const handle of handles) {
    const hash = cacheHandleHash(handle);
    if (hash) present.add(hash);
  }
  if (present.size === 0) return null;
  for (const [hash, expansion] of DEPENDENCY_HASHES) {
    if (present.has(hash)) return expansion;
  }
  return null;
}


/** 某个建筑名上的加速区间列表，`[start, end]`，**按起点降序**（与 spawningtool 一致，回退时从最近的一段开始）。 */
export interface ChronoRanges {
  [buildingName: string]: Array<[number, number]>;
}

/** 玩家 id → 各建筑上的加速区间。 */
export type ChronoBoosts = Map<number, ChronoRanges>;

/**
 * 打包 tag → `"index/recycle"`。
 *
 * 游戏事件里 `TargetUnit.m_tag` 是 32 位打包值：`index = tag >>> 18`、`recycle = tag & 0x3FFFF`。
 * 实测 US_TVP / CN_ZVP 各 6 条指令，此编码 6/6 命中，反向编码 0/6。
 * 复现脚本：`scripts/research/chrono-tag-encoding.mjs`。
 */
export function packedTagKey(tag: number): string {
  return `${Math.floor(tag / 262144)}/${tag % 262144}`;
}

/** `"index/recycle"` —— 与 `build_order.ts` 的 `unitTagKey` 同格式。 */
export function unitTagKey(index: unknown, recycle: unknown): string {
  return `${index ?? "null"}/${recycle ?? "null"}`;
}

/**
 * `details.m_timeUTC` → Unix 秒。逐字复刻 sc2reader 的 `utils.windows_to_unix`：
 *
 * ```python
 * int((windows_time - 116444735995904000) / 10**7)
 * ```
 *
 * ⚠️ 常数是 `116444735995904000`，**不是** `11644473600 * 10**7`（差 0.4096 秒，
 * 恰好是决定截断方向的量）。实测：用错常数 hero 那条会得到 1768723971（应为 1768723972）。
 *
 * ⚠️ `m_timeUTC` 是 uint64（≈1.34e17），超出 Number 的 53 位精度，
 * **必须走 BigInt**，否则误差可达 0.4 秒。
 */
export function unixTimestampFromDetails(details: unknown): number {
  const raw = readPath(details, ["m_timeUTC"]);
  if (raw === undefined || raw === null) return 0;
  if (typeof raw === "bigint") return Number((raw - 116444735995904000n) / 10000000n);
  return Math.trunc((Number(raw) - 116444735995904000) / 1e7);
}

/**
 * 从 `replay.initData` + `replay.details` 取 `m_userId → 玩家 id`。
 *
 * 两步桥接，缺一不可：
 *
 * 1. `m_slots[i]` 给出 `m_workingSetSlotId → m_userId`；
 * 2. `details.m_playerList[j].m_workingSetSlotId` 反查回 userId，玩家 id = `j + 1`
 *    （与 sc2reader 的 pid 一致 —— pid 1/2 就是 playerList 的前两项）。
 *
 * ⚠️ **不能用 `m_workingSetSlotId + 1` 当 pid**。实测 `hero(w) vs reynor`：
 * herO 的 `m_workingSetSlotId` 是 **14**，但 pid 是 **2**；他的 chrono 指令带 `m_userId = 3`。
 * 错误的映射会把加速区间挂到 pid 15 上，导致该录像 27 条 chrono 全部失效。
 */
export function userIdToPlayerId(initData: unknown, details: unknown): Map<number, number> {
  const out = new Map<number, number>();

  const slots = readPath(initData, ["m_syncLobbyState", "m_lobbyState", "m_slots"]);
  if (!Array.isArray(slots)) return out;

  const userBySlot = new Map<number, number>();
  for (const slot of slots) {
    const rec = slot as Record<string, unknown>;
    const userId = rec?.m_userId;
    if (userId === null || userId === undefined) continue;
    userBySlot.set(Number(rec.m_workingSetSlotId), Number(userId));
  }

  const players = readPath(details, ["m_playerList"]);
  if (!Array.isArray(players)) return out;
  for (const [index, player] of players.entries()) {
    const rec = player as Record<string, unknown>;
    const userId = userBySlot.get(Number(rec?.m_workingSetSlotId));
    if (userId === undefined) continue; // 电脑对手没有 player slot
    out.set(userId, index + 1);
  }
  return out;
}

/** `m_gameOptions.m_cooperative`。CN_PVT（探姬 vs 电脑）为 `true`，普通天梯为 `false`。 */
export function isCooperative(initData: unknown): boolean {
  return readPath(initData, ["m_syncLobbyState", "m_gameDescription", "m_gameOptions", "m_cooperative"]) === true;
}

function readPath(root: unknown, path: string[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export interface CollectChronoInput {
  /** `replay.game.events` 的解码结果。 */
  gameEvents: DecodedEvent[];
  /** `userIdToPlayerId(initData, details)` 的结果。 */
  userToPlayer: Map<number, number>;
  /** tracker 单位 tag（`"index/recycle"`）→ 单位类型名。目标建筑名靠它解析。 */
  tagToUnitName: Map<string, string>;
  /**
   * 该录像对应的能力 link 集合，来自 `abilityLinksForBuild(header.m_version.m_build, expansion)`。
   * **不要传跨版本并集** —— 见文件头「能力 link 不是全局唯一的」。
   */
  links: AbilityLinks;
  model: ChronoModel;
  /** `replay.header.m_elapsedGameLoops`，连续模型需要它当收尾哨兵。 */
  totalFrames: number;
}

/**
 * 收集时空加速区间。与 spawningtool 的 `set_chronoboost_data` 同构。
 *
 * 只认目标能解析出名字的指令（对应 spawningtool 的 `and event.target`）。
 */
export function collectChronoBoosts(input: CollectChronoInput): ChronoBoosts {
  const { gameEvents, userToPlayer, tagToUnitName, links, model, totalFrames } = input;
  if (!links) {
    // 显式兜住 JS 调用方（TS 侧有类型保护）。以前这里是个模块级并集常量，
    // 静默用错集合是「碰巧正确」而不是「设计正确」。
    throw new Error(
      "collectChronoBoosts: 缺少 links —— 请传 abilityLinksForBuild(header.m_version.m_build, expansion) 的结果",
    );
  }

  /** pid → 按事件原序的 `[建筑名, 帧]`。 */
  const commands = new Map<number, Array<[string, number]>>();

  for (const event of gameEvents) {
    const abil = event.m_abil as Record<string, unknown> | undefined;
    if (!abil) continue;
    if (!links.chrono.has(Number(abil.m_abilLink))) continue;
    if (Number(abil.m_abilCmdIndex) !== 0) continue;

    const target = (event.m_data as Record<string, unknown> | undefined)?.TargetUnit as
      | Record<string, unknown>
      | undefined;
    if (!target || target.m_tag === undefined || target.m_tag === null) continue;

    const building = tagToUnitName.get(packedTagKey(Number(target.m_tag)));
    if (!building) continue;

    const userId = (event._userid as Record<string, unknown> | undefined)?.m_userId;
    if (userId === undefined || userId === null) continue;
    const pid = userToPlayer.get(Number(userId));
    if (pid === undefined) continue;

    const list = commands.get(pid);
    if (list) list.push([building, event._gameloop]);
    else commands.set(pid, [[building, event._gameloop]]);
  }

  return model.kind === "lotv"
    ? buildLotvBoosts(commands, totalFrames)
    : buildWindowedBoosts(commands, model.durationLoops);
}

/**
 * HotS / 4.0 模型：每次指令制造一个固定长度窗口 `[F, F + duration)`，
 * 同建筑的窗口若重叠就合并（`cur_end = F + duration`），最后**反转**成降序。
 */
function buildWindowedBoosts(
  commands: Map<number, Array<[string, number]>>,
  durationLoops: number,
): ChronoBoosts {
  const out: ChronoBoosts = new Map();

  for (const [pid, list] of commands) {
    const byBuilding = new Map<string, number[]>();
    for (const [building, frame] of list) {
      const frames = byBuilding.get(building);
      if (frames) frames.push(frame);
      else byBuilding.set(building, [frame]);
    }

    const ranges: ChronoRanges = {};
    for (const [building, frames] of byBuilding) {
      const merged: Array<[number, number]> = [];
      let current: [number, number] | null = null;
      for (const frame of frames) {
        if (!current) current = [frame, frame + durationLoops];
        else if (current[1] > frame) current[1] = frame + durationLoops;
        else {
          merged.push(current);
          current = [frame, frame + durationLoops];
        }
      }
      if (current) merged.push(current);
      merged.reverse(); // 回退时从最近的一段往前推
      ranges[building] = merged;
    }
    out.set(pid, ranges);
  }

  return out;
}

/**
 * LotV 连续模型：**一条指令表示「上一个目标从此刻起不再被加速」**。
 * 初态是 `Nexus` 从帧 0 起被加速；末尾用 `totalFrames` 收尾。
 *
 * spawningtool 自己也标注了它的局限：
 * 「如果玩家从不移动加速目标，结果可能不准」。
 */
function buildLotvBoosts(commands: Map<number, Array<[string, number]>>, totalFrames: number): ChronoBoosts {
  const out: ChronoBoosts = new Map();

  for (const [pid, list] of commands) {
    const ranges: ChronoRanges = {};
    let lastBuilding = "Nexus";
    let lastStartFrame = 0;

    const timeline: Array<[string, number]> = [...list, ["", totalFrames]];
    for (const [building, frame] of timeline) {
      const arr = ranges[lastBuilding];
      if (arr) arr.push([lastStartFrame, frame]);
      else ranges[lastBuilding] = [[lastStartFrame, frame]];
      lastBuilding = building;
      lastStartFrame = frame;
    }

    for (const key of Object.keys(ranges)) ranges[key].reverse();
    out.set(pid, ranges);
  }

  return out;
}

export interface AdjustedStart {
  /** 回退后的起点帧。可能是小数。 */
  startFrame: number;
  chronoboosted: boolean;
}

/**
 * 按加速区间把起点往后推。逐行对应 spawningtool 的 `adjust_build_time` 尾部。
 *
 * @param frame 事件帧（出生的那一刻 / 变形的那一刻 / 升级完成的那一刻）
 * @param buildLoops 表里的建造时长（帧）
 * @param builtFrom 该单位的产出建筑名列表（`BUILD_TIMES[unit].from`）
 */
export function applyChronoBoost(
  frame: number,
  buildLoops: number,
  playerId: number,
  builtFrom: readonly string[] | undefined,
  boosts: ChronoBoosts | null | undefined,
  multiplier: number,
): AdjustedStart {
  let projected = frame - buildLoops;
  let chronoboosted = false;

  const ranges = boosts?.get(playerId);
  if (ranges && builtFrom) {
    for (const building of builtFrom) {
      const list = ranges[building];
      if (!list) continue;
      for (const [rangeStart, rangeEnd] of list) {
        if (rangeEnd > projected && rangeStart < frame) {
          const overlap = Math.min(rangeEnd, frame) - Math.max(rangeStart, projected);
          projected += Math.trunc(overlap * multiplier);
          chronoboosted = true;
        }
      }
    }
  }

  // spawningtool: `if projected_start < 0: projected_start = 1`（取整误差导致）
  if (projected < 0) projected = 1;

  return { startFrame: projected, chronoboosted };
}

export { GAME_LOOPS_PER_SECOND as CHRONO_GAME_LOOPS_PER_SECOND };
