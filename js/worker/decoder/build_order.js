/**
 * `build_order` 抽取：把 tracker 事件还原成「谁在什么时候开始造什么东西」。
 *
 * 对齐对象是**现有 Pyodide 路径**（`sc2reader` + `spawningtool`），不是官方协议 ——
 * 所以本文档里每一处判定都写着「spawningtool 怎么做 / 我们为什么不一样」。
 * 基线快照在 `tests/baseline/`，验收脚本 `scripts/verify-build-order.mjs` 逐条对拍。
 *
 * ## 起点怎么来（三路混合，这是本模块的核心结论）
 *
 * 事件的语义决定了「不同对象走不同路径」，实测确认（见
 * `plans/RESEARCH-BUILD-ORDER-TIMING.md` 与 `scripts/research/`）：
 *
 * | 对象                | 起点来源                                        | 代价       | 精度 |
 * | ------------------- | ----------------------------------------------- | ---------- | ---- |
 * | 建筑（三族）        | `SUnitInitEvent` 的帧**本身就是起点**，不用回推 | 零数据表   | 精确 |
 * | 虫族单位（幼虫孵化）| `SUnitBornEvent.m_creatorUnitTagIndex` 指向的 Egg 的 `SUnitTypeChangeEvent` 帧 | 零数据表 | 精确 |
 * | 其它单位            | `Born 帧 − BUILD_TIMES[unit].loops`             | 188 条表   | 表精度 |
 * | 变形（Lair/Hive 等）| `SUnitTypeChangeEvent` 帧 − 建造时长            | 同表       | 表精度 |
 * | 升级                | `SUpgradeEvent` 帧 − 建造时长                   | 同表       | 表精度 |
 *
 * 时间基准是 **16 fps 游戏帧**（`_gameloop` 就是它），落成秒时用 `floor(帧 / 16)` ——
 * 与旧链路 `tools/baseline/parse_script.py` 的 `int(item["frame"]) >> 4` 一致。
 * （该文件是已下线的 Pyodide 链路留下的冻结参考，站点不再加载它。）
 *
 * ## 与旧链路的已知差异（有意为之，验收脚本会逐项报数）
 *
 * 1. **虫族起点更准**：旧链路对虫族也查表（Drone 268.8 帧），我们用 Egg 实测帧（272 帧）。
 *    影响是 0~1 秒的显示差。可用 `exactZergStart: false` 退回旧行为。
 * 2. **修掉 `get_supply` 的索引 bug**：spawningtool 在二分命中时 `return mid`（返回的是**下标**），
 *    我们返回真实补给值。所以 `supply` 字段不会与基线一致，验收脚本不判它失败。
 * 3. **补出 `finish_time`**：旧链路只有起点；建筑可由 `SUnitDoneEvent` 给出终点。
 * 4. **不生成 `(Error on build time)` 之外的伪单位**：未知单位仍按旧链路命名并保留，
 *    但会额外标出 `startSource: "fallback"`，让上层能一眼看出哪几条不可信。
 * 5. **CN_PVT 走 LotV 常量表**：该录像（探姬 vs 电脑）的 `m_gameOptions.m_cooperative`
 *    真的是 `true`，spawningtool 因此改用 `coop_constants`，其中 Marine/SCV 等时长与
 *    LotV 不同，还会把 Adept 之类标成 `(Error on build time)`。我们始终用 LotV 表。
 *    这是**有意的偏离**，不是缺陷。
 * 6. **幻象单位未过滤**：spawningtool 靠 sc2reader 的 `unit.hallucinated` 丢弃幻象，
 *    而该标记来自 `SSelectionDeltaEvent` 的 subgroup flags（`context.py:139`）——
 *    一个依赖选择事件时序的有状态量。我们的协议表把 `m_unitTypeName` 折成字符串
 *    （`_blob` 类型），幻象与真单位同名，**无法区分**。
 *    实测影响：2366 条里多 1 条（US_TVP 的一个幻象 Phoenix）。
 *
 * ## 尚未落地（明确不做，别误以为已覆盖）
 *
 * - **折跃门提速**：`WARPGATE_PERCENTAGE_BUILD`，5 个样本 baseBuild 全部低于它，判定不触发。
 *
 * ## 已落地（不要重复实现）
 *
 * - **时空加速修正**：见 `chrono.ts`。`options.chrono` 传入区间与倍率即可。
 * - **星空加速（`_kind: "recall"`）**：见 `recall.ts`。它是**指令**派生的行（来自
 *   `game.events`，不在 tracker 流里），所以本模块**不产出它** —— 由 `collectRecalls()`
 *   采集、`mergeRecalls()` 按帧有序并入本模块的 `byPlayer`。
 *   别指望在 `extractBuildOrder()` 的返回值里看到 `_kind: "recall"`。
 */
import { BUILD_DATA_HISTORY, BUILD_TIMES, CHANGED_EXCLUDED_UNITS, EXCLUDED_UNITS, GAME_LOOPS_PER_SECOND, UPGRADE_EXCLUDED, WORKER_UNITS, } from "./data/build_times.generated.js";
import { applyChronoBoost } from "./chrono.js";
/** 从定长字节串取字符串（tracker 里的名字都是 `Uint8Array`）。 */
function text(value) {
    if (value instanceof Uint8Array)
        return new TextDecoder().decode(value);
    return value == null ? "" : String(value);
}
function unitTagKey(index, recycle) {
    return `${index ?? "null"}/${recycle ?? "null"}`;
}
/**
 * 按录像时间戳回滚建造时长（对应 `build_data_for_timestamp`）。
 *
 * 存在的原因是**平衡性热修不一定会改 build number**，所以同一个 `baseBuild`
 * 可能是两套数值。`BUILD_DATA_HISTORY[unit]` 是「由旧到新」的
 * `[被取代的时间戳, 当时的 loops]`，取第一个还没被取代的那个值。
 */
export function resolveBuildTimes(timestamp) {
    if (!timestamp)
        return BUILD_TIMES;
    let overrides = null;
    for (const unit of Object.keys(BUILD_DATA_HISTORY)) {
        for (const [supersededAt, loops] of BUILD_DATA_HISTORY[unit]) {
            if (timestamp < supersededAt) {
                overrides ??= {};
                overrides[unit] = { ...BUILD_TIMES[unit], loops };
                break;
            }
        }
    }
    return overrides ? { ...BUILD_TIMES, ...overrides } : BUILD_TIMES;
}
/** 玩家补给序列：`[frame, 补给]`，按帧升序。 */
class SupplySeries {
    points = new Map();
    /** 照搬 spawningtool 的初值：`[[0, 6]]`。 */
    ensure(playerId) {
        if (!this.points.has(playerId))
            this.points.set(playerId, [{ frame: 0, value: 6 }]);
    }
    record(playerId, frame, value) {
        this.ensure(playerId);
        this.points.get(playerId).push({ frame, value });
    }
    /** 旧的 LotV 早期录像修正：帧 1 的补给若是 12，回写初值。 */
    patchInitial(playerId, frame, value) {
        if (frame !== 1 || value !== 12)
            return;
        const series = this.points.get(playerId);
        if (series && series.length === 1)
            series[0].value = 12;
    }
    /** 取「帧 ≤ frame 的最后一个记录」，没有则第一个，全空则 null。 */
    at(playerId, frame) {
        const series = this.points.get(playerId);
        if (!series || series.length === 0)
            return null;
        let lo = 0;
        let hi = series.length - 1;
        let best = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (series[mid].frame <= frame) {
                best = mid;
                lo = mid + 1;
            }
            else {
                hi = mid - 1;
            }
        }
        // spawningtool 在二分命中时会 `return mid`（返回下标而不是补给值）—— 那是 bug，这里返回真值。
        return best >= 0 ? series[best].value : series[0].value;
    }
}
/**
 * 抽取建造表。
 *
 * 单次按 tracker 事件原序扫描（与 spawningtool 的 `add_tracker_events` 同构），
 * 结束时按起点帧稳定升序排序 —— 稳定是关键：同帧事件要保持事件流原始次序。
 */
export function extractBuildOrder(trackerEvents, options = {}) {
    const exactZergStart = options.exactZergStart !== false;
    const table = resolveBuildTimes(options.replayTimestamp);
    const chronoBoosts = options.chrono?.boosts ?? null;
    const chronoMultiplier = options.chrono?.multiplier ?? 0;
    const supply = new SupplySeries();
    /** Egg tag → 出现帧。用于虫族单位的精确定位。 */
    const eggFrames = new Map();
    /** 建筑 tag → `SUnitInitEvent` 帧，用于配 `SUnitDoneEvent` 得终点。 */
    const initFrames = new Map();
    /**
     * unit tag → 归属玩家。
     *
     * 必要性：`SUnitTypeChangeEvent` **没有控制方字段**（协议里只有 tag + 新类型名），
     * 而 spawningtool 靠 sc2reader 反查 `event.unit.owner.pid`。我们照同样的思路，
     * 从 Born / Init 事件里把 tag 的所有者先记下来再查。
     */
    const tagOwner = new Map();
    const byPlayer = new Map();
    const stats = {
        excludedBorn: 0,
        frameZeroSkipped: 0,
        eggLinked: 0,
        fallbackTiming: 0,
        changedExcluded: 0,
        buildingWithoutTable: 0,
        chronoboosted: 0,
    };
    const push = (entry) => {
        const list = byPlayer.get(entry.playerId);
        if (list)
            list.push(entry);
        else
            byPlayer.set(entry.playerId, [entry]);
    };
    /**
     * 由「事件帧 − 建造时长」回推起点，并按时空加速修正。
     *
     * 旧链路对 unit（Born）/ morph（TypeChange）/ upgrade 三条路都调用 `adjust_build_time`，
     * 唯独建筑（Init）直接用事件帧 —— 这里保持一致。
     */
    const backProject = (frame, loops, playerId, builtFrom) => {
        if (!chronoBoosts)
            return { startFrame: frame - loops, chronoboosted: false };
        const result = applyChronoBoost(frame, loops, playerId, builtFrom, chronoBoosts, chronoMultiplier);
        if (result.chronoboosted)
            stats.chronoboosted += 1;
        return result;
    };
    // ── 预扫描：登记所有单位的 tag → 归属，**必须包含 frame 0** ──────────────
    // 主循环会跳过 frame 0（复刻 spawningtool 的 `if event.frame == 0: continue`），
    // 但开局就存在的 CommandCenter / Hatchery / Nexus 恰恰全在 frame 0。它们随后会
    // 变形（CommandCenter→OrbitalCommand、Hatchery→Lair→Hive），而
    // `SUnitTypeChangeEvent` **不带控制方字段**，只能靠这张表反查归属。
    // 若把登记放进主循环，开局建筑的 tag 永远查不到，这些 morph 会被整条丢弃 ——
    // 实测漏掉 `OrbitalCommand`×4 / `Lair`×1 / `Hive`×1，且因为少条目导致后续
    // 全部错位（US_TVP 一个玩家 328 条里错 317 条全是这一个原因）。
    for (const event of trackerEvents) {
        const kind = event._event.slice(event._event.lastIndexOf(".") + 1);
        if (kind === "SUnitBornEvent" || kind === "SUnitInitEvent") {
            tagOwner.set(unitTagKey(event.m_unitTagIndex, event.m_unitTagRecycle), Number(event.m_controlPlayerId));
        }
    }
    for (const event of trackerEvents) {
        // spawningtool: `if event.frame == 0: continue` —— 开局单位与地图中立全在这一帧。
        if (event._gameloop === 0) {
            stats.frameZeroSkipped += 1;
            continue;
        }
        const kind = event._event.slice(event._event.lastIndexOf(".") + 1);
        switch (kind) {
            case "SPlayerStatsEvent": {
                const pid = Number(event.m_playerId);
                const raw = event.m_stats?.m_scoreValueFoodUsed;
                // `m_scoreValueFoodUsed` 是 4096 定点（实测 49152 / 4096 = 12）。
                const value = Math.trunc(Number(raw) / 4096);
                supply.patchInitial(pid, event._gameloop, value);
                supply.record(pid, event._gameloop, value);
                break;
            }
            case "SUnitTypeChangeEvent": {
                const name = text(event.m_unitTypeName);
                const key = unitTagKey(event.m_unitTagIndex, event.m_unitTagRecycle);
                // Egg 是「孵化开始」的标志，本身不进建造表（表里没有 Egg），但它是虫族的定位锚点。
                if (name === "Egg") {
                    eggFrames.set(key, event._gameloop);
                    break;
                }
                if (CHANGED_EXCLUDED_UNITS.includes(name)) {
                    stats.changedExcluded += 1;
                    break;
                }
                const data = table[name];
                if (!data)
                    break; // 旧链路 KeyError 后直接 return，等价于丢弃。
                // 归属靠 tag 反查；查不到就当作无主（旧链路 `if not event.unit.owner: return`）。
                const owner = tagOwner.get(key);
                if (owner === undefined || owner === 0)
                    break;
                const loops = data.loops;
                const adjusted = backProject(event._gameloop, loops, owner, data.from);
                push({
                    playerId: owner,
                    startFrame: adjusted.startFrame,
                    finishFrame: event._gameloop,
                    start_time: Math.trunc(adjusted.startFrame / GAME_LOOPS_PER_SECOND),
                    supply: supply.at(owner, adjusted.startFrame),
                    unit: name,
                    type: data.type,
                    race: data.race,
                    is_worker: WORKER_UNITS.includes(name),
                    startSource: "morph",
                    fromEvent: "change",
                    buildLoops: loops,
                    is_chronoboosted: adjusted.chronoboosted,
                });
                break;
            }
            case "SUnitInitEvent": {
                const pid = Number(event.m_controlPlayerId);
                const name = text(event.m_unitTypeName);
                if (EXCLUDED_UNITS.includes(name) || pid === 0) {
                    stats.excludedBorn += 1;
                    break;
                }
                const key = unitTagKey(event.m_unitTagIndex, event.m_unitTagRecycle);
                initFrames.set(key, event._gameloop);
                tagOwner.set(key, pid);
                const data = table[name];
                // 建筑起点 = Init 帧本身，**不回推** —— 这是三路里最干净的一路。
                // 注意：旧链路的 `add_unit_init_event` 对建筑**不查建造时长表**，
                // 所以表里没有的建筑也不会带 `(Error on build time)` 标记（别自作聪明加）。
                push({
                    playerId: pid,
                    startFrame: event._gameloop,
                    finishFrame: null, // 由同 tag 的 SUnitDoneEvent 补齐
                    start_time: Math.trunc(event._gameloop / GAME_LOOPS_PER_SECOND),
                    supply: supply.at(pid, event._gameloop),
                    unit: name,
                    type: "Building",
                    race: data?.race ?? null,
                    is_worker: WORKER_UNITS.includes(name),
                    startSource: "init",
                    fromEvent: "init",
                    buildLoops: 0,
                    // 建筑不做时长回推、也不做加速修正 —— 与 spawningtool 的 `add_unit_init_event` 一致。
                    is_chronoboosted: false,
                });
                if (!data)
                    stats.buildingWithoutTable += 1;
                break;
            }
            case "SUnitDoneEvent": {
                const key = unitTagKey(event.m_unitTagIndex, event.m_unitTagRecycle);
                const initFrame = initFrames.get(key);
                if (initFrame === undefined)
                    break;
                // 把终点补回对应那条建筑记录（同 tag 唯一）。
                for (const list of byPlayer.values()) {
                    for (let i = list.length - 1; i >= 0; i -= 1) {
                        const item = list[i];
                        if (item.fromEvent === "init" && item.startFrame === initFrame && item.finishFrame === null) {
                            item.finishFrame = event._gameloop;
                            break;
                        }
                    }
                }
                break;
            }
            case "SUnitBornEvent": {
                const pid = Number(event.m_controlPlayerId);
                const name = text(event.m_unitTypeName);
                tagOwner.set(unitTagKey(event.m_unitTagIndex, event.m_unitTagRecycle), pid);
                if (pid === 0 || EXCLUDED_UNITS.includes(name)) {
                    stats.excludedBorn += 1;
                    break;
                }
                // 路径一：虫族单位 —— creatorTag 指向孵化它的 Egg，那一刻就是起点。
                const creatorKey = unitTagKey(event.m_creatorUnitTagIndex, event.m_creatorUnitTagRecycle);
                const eggFrame = exactZergStart ? eggFrames.get(creatorKey) : undefined;
                if (eggFrame !== undefined) {
                    stats.eggLinked += 1;
                    const data = table[name];
                    push({
                        playerId: pid,
                        startFrame: eggFrame,
                        finishFrame: event._gameloop,
                        start_time: Math.trunc(eggFrame / GAME_LOOPS_PER_SECOND),
                        supply: supply.at(pid, eggFrame),
                        unit: name,
                        type: data?.type ?? "Unit",
                        race: data?.race ?? null,
                        is_worker: WORKER_UNITS.includes(name),
                        startSource: "egg",
                        fromEvent: "born",
                        buildLoops: event._gameloop - eggFrame,
                        // Egg 帧是实测起点，不需要（也不应该）再做加速修正。
                        is_chronoboosted: false,
                    });
                    break;
                }
                // 路径二：查表回推。
                const data = table[name];
                if (!data) {
                    stats.fallbackTiming += 1;
                    push({
                        playerId: pid,
                        startFrame: event._gameloop,
                        finishFrame: event._gameloop,
                        start_time: Math.trunc(event._gameloop / GAME_LOOPS_PER_SECOND),
                        supply: supply.at(pid, event._gameloop),
                        unit: `${name} (Error on build time)`,
                        type: "Unit",
                        race: null,
                        is_worker: false,
                        startSource: "fallback",
                        fromEvent: "born",
                        buildLoops: 0,
                        is_chronoboosted: false,
                    });
                    break;
                }
                const adjusted = backProject(event._gameloop, data.loops, pid, data.from);
                push({
                    playerId: pid,
                    startFrame: adjusted.startFrame,
                    finishFrame: event._gameloop,
                    start_time: Math.trunc(adjusted.startFrame / GAME_LOOPS_PER_SECOND),
                    supply: supply.at(pid, adjusted.startFrame),
                    unit: name,
                    type: data.type,
                    race: data.race,
                    is_worker: WORKER_UNITS.includes(name),
                    startSource: "table",
                    fromEvent: "born",
                    buildLoops: data.loops,
                    is_chronoboosted: adjusted.chronoboosted,
                });
                break;
            }
            case "SUpgradeEvent": {
                const pid = Number(event.m_playerId);
                const name = text(event.m_upgradeTypeName);
                if (pid === 0 || UPGRADE_EXCLUDED.includes(name))
                    break;
                const data = table[name];
                const loops = data ? data.loops : 0;
                // 表里没有的升级，spawningtool 直接用 `event.frame`（不回推、不加速）。
                const adjusted = backProject(event._gameloop, loops, pid, data?.from);
                push({
                    playerId: pid,
                    startFrame: adjusted.startFrame,
                    finishFrame: event._gameloop,
                    start_time: Math.trunc(adjusted.startFrame / GAME_LOOPS_PER_SECOND),
                    supply: supply.at(pid, adjusted.startFrame),
                    unit: data ? name : `${name} (upgrade missing)`,
                    type: "Upgrade",
                    race: data?.race ?? null,
                    is_worker: false,
                    startSource: data ? "table" : "fallback",
                    fromEvent: "upgrade",
                    buildLoops: loops,
                    is_chronoboosted: adjusted.chronoboosted,
                });
                break;
            }
            default:
                break;
        }
    }
    // 稳定排序：同帧要保持事件流原序（对应 spawningtool 的 `sort(key=lambda a: a.frame)`）。
    for (const list of byPlayer.values())
        list.sort((a, b) => a.startFrame - b.startFrame);
    return { byPlayer, stats };
}
/**
 * tracker 单位 tag（`"index/recycle"`）→ 单位类型名。
 *
 * 用途：时空加速指令的目标只有打包 tag（`m_data.TargetUnit.m_tag`），
 * 需要把它还原成建筑名（`Nexus` / `Stargate` / `WarpGate` …）才能与
 * `BUILD_TIMES[unit].from` 对上。**必须包含 frame 0**（开局的 Nexus / CommandCenter）。
 */
export function collectTagToUnitName(trackerEvents) {
    const out = new Map();
    for (const event of trackerEvents) {
        const kind = event._event.slice(event._event.lastIndexOf(".") + 1);
        if (kind !== "SUnitBornEvent" && kind !== "SUnitInitEvent")
            continue;
        const key = unitTagKey(event.m_unitTagIndex, event.m_unitTagRecycle);
        // 后写覆盖先写：tag 被回收后新单位会顶掉旧名字，与 sc2reader 的 objects 表同语义。
        out.set(key, text(event.m_unitTypeName));
    }
    return out;
}
/**
 * 转成 `tools/baseline/parse_script.py` 里 `build_order` 条目的形状，便于与旧链路逐字段对拍。
 *
 * 注意 `_kind` 的映射**刻意复刻旧链路的行为**：该脚本判的是
 * `item.get("type") == "Upgrade"`，而 spawningtool 的 `to_dict()` 根本不输出 `type`，
 * 所以那个分支是死代码 —— 旧链路里除了 `recall`，所有条目（含建筑、升级）都是 `"unit"`。
 * 这里保留原语义以便对齐；上层要更准确的信息请直接用 `BuildOrderEntry.type`。
 */
export function toLegacyEntry(entry) {
    return {
        start_time: entry.start_time,
        supply: entry.supply,
        unit: entry.unit,
        _kind: "unit",
        is_worker: entry.is_worker,
    };
}
