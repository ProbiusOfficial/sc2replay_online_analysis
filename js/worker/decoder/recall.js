/**
 * 星空加速（`_kind: "recall"`）行提取 —— Mass Recall 家族（星灵群体传送）的指令。
 *
 * ## 术语先分清（旧站点把两者混着叫）
 *
 * | 名字         | 是什么                          | 在哪                          | 影响建造时长？ |
 * | ------------ | ------------------------------- | ----------------------------- | -------------- |
 * | **星空加速** | **Mass Recall**（本模块）        | 这里；旧站点 `_kind: "recall"` | **否**         |
 * | **时空加速** | **Chrono Boost**                | `chrono.ts`                   | 是（必须回推） |
 *
 * 显示名与语音读法现在都在 `js/lab/views.js`（建造顺序视图把它显示为「星空加速」、
 * 语音读作「加速」）。历史来源 `js/display_helpers.js::ABILITY_FALLBACK_ZH` 与
 * `js/voice_reader.js` 已在 2026-09-22 的 UI 重构中删除，此处仅存留沿革。
 *
 * ## 复刻对象与确切规格
 *
 * 对齐旧链路（`tools/baseline/parse_script.py`，原 `js/parse_script.js`；采集段 ≈56-95 行、
 * 并入 `build_order` 段 ≈256-266 行）：
 *
 * | 项 | 值 |
 * | -- | -- |
 * | 事件 | `SCmdEvent`（**不是** `SCmdUpdateTargetPointEvent` —— 实测后者 2064 条全不带 `m_abil`） |
 * | 能力 | `m_abil = { m_abilLink, m_abilCmdIndex }`，link 随补丁漂移，**必须按 datapack 区间取** |
 * | 目标 | `m_data.TargetPoint{ x, y, z }` —— **点目标，指令里没有目标单位** |
 * | 产出 | `{ start_time, supply: null, unit: "", _kind: "recall", target: null, is_worker: false }` |
 * | 期望 | US_TVP 427 / 739 / 937 s（Shameless）、hero 1129 s（herO），全库共 4 条 |
 *
 * `unit` / `target` **恒为空**是旧站点的真实行为（`getattr(point, "name", None)` → `None`
 * → `tgt or ""`），UI 与语音都已对该情况降级。所以这里**不发明目标名** ——
 * 强行填会与旧站点不一致。若将来要做「星空加速 → Nexus」，那是新增功能，见
 * `plans/RESEARCH-RECALL-FIX.md` §5 备选 C。
 *
 * ## ⚠️ 玩家归属必须走两跳桥
 *
 * 复用 `chrono.ts::userIdToPlayerId()`。**不能用 `userId + 1`**：
 * US_TVP 的指令带 `m_userId = 1`，而它属于 **Shameless**（`m_playerList` 第 2 个）。
 * 用 `userId + 1` 会落到 Percival 头上。
 *
 * ## 有意改进：按 `start_time` 有序并入，而不是 append 到末尾
 *
 * 旧链路把 recall 行 `append` 在 `build_order` 尾部（`tools/baseline/parse_script.py` 的并入段），
 * `README.md` 的 `build-260412` 条目已把它记为 bug：
 * 「修复 Python 将「星空加速 / recall」追加在 build_order 末尾导致未排序时，
 * 播报顺序与界面不一致、甚至出现跳到后期步骤的问题。」
 *
 * 所以 `mergeRecalls()` 按帧有序插入。验收脚本把这个**位置差**登记为已声明偏差
 * （对比的是多重集，位置另判）。
 *
 * ## 已知未覆盖
 *
 * - **不解析具体是哪一个能力**：生成表只存 link 集合，运行期拿不到
 *   `NexusMassRecall` / `MassRecallMothership*` 的名字。样本里只出现过 `NexusMassRecall`。
 * - **WoL / HotS 视频未实测**：区间表覆盖了，但没有真实数据验证过。
 * - **`m_cmdFlags = 256` 的含义未查**：旧链路不使用它，这里也不用。
 */
const GAME_LOOPS_PER_SECOND = 16;
/**
 * 扫描 game events，按玩家归集星空加速行。
 *
 * 单次线性扫描，事件原序（于是同一玩家内部天然按帧升序，`mergeRecalls` 仍会再兜一次底）。
 */
export function collectRecalls(input) {
    const { gameEvents, userToPlayer, links } = input;
    const out = new Map();
    // 没有 recall link（绝大多数录像）时直接返回，省掉整趟扫描。
    if (links.recall.size === 0)
        return out;
    for (const event of gameEvents) {
        const abil = event.m_abil;
        if (!abil)
            continue;
        if (!links.recall.has(Number(abil.m_abilLink)))
            continue;
        // 与 chrono 同口径：全区间内 cmdIndex 恒为 0（codegen 会断言，破了就报错）。
        if (Number(abil.m_abilCmdIndex) !== 0)
            continue;
        const userId = event._userid?.m_userId;
        if (userId === undefined || userId === null)
            continue;
        const pid = userToPlayer.get(Number(userId));
        if (pid === undefined)
            continue;
        const row = {
            playerId: pid,
            startFrame: event._gameloop,
            start_time: Math.trunc(event._gameloop / GAME_LOOPS_PER_SECOND),
            supply: null,
            unit: "",
            target: null,
            is_worker: false,
            _kind: "recall",
        };
        const list = out.get(pid);
        if (list)
            list.push(row);
        else
            out.set(pid, [row]);
    }
    return out;
}
/** 类型守卫。因 `RecallRow` 独有 `_kind` 字段，`BuildOrderEntry` 上没有它。 */
export function isRecallRow(row) {
    return row._kind === "recall";
}
/**
 * 把 recall 行按帧**有序并入** `build_order`（有意不同于旧链路的 append-to-end，见文件头）。
 *
 * 规则：
 * - 只比较 `startFrame`；同帧时 **tracker 行在前、recall 行在后**（稳定，可复现）；
 * - 传入的 `byPlayer` 必须是 `extractBuildOrder` 的产物（已按 `startFrame` 升序）；
 * - 输出**覆盖并集**：只出现在 `recalls` 里的玩家也会有一条（理论上不会发生，
 *   但比静默丢掉更安全）。
 */
export function mergeRecalls(byPlayer, recalls) {
    const out = new Map();
    const pids = new Set([...byPlayer.keys(), ...recalls.keys()]);
    for (const pid of pids) {
        const base = byPlayer.get(pid) ?? [];
        const extra = [...(recalls.get(pid) ?? [])].sort((a, b) => a.startFrame - b.startFrame);
        const merged = [];
        let i = 0;
        for (const entry of base) {
            while (i < extra.length && extra[i].startFrame < entry.startFrame) {
                merged.push(extra[i]);
                i += 1;
            }
            merged.push(entry);
        }
        while (i < extra.length) {
            merged.push(extra[i]);
            i += 1;
        }
        out.set(pid, merged);
    }
    return out;
}
