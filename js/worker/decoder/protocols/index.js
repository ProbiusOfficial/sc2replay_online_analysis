/**
 * 协议版本选择。
 *
 * ## 为什么匹配单位是「补丁」而不是 baseBuild
 *
 * 实测结论（plans/ROUTE-C-WASM-REFACTOR-PLAN.md §6-P1）：SC2 **只在补丁级别
 * 变更协议**，同一个补丁下会连发多个 baseBuild，它们的协议定义完全相同。
 *
 * 具体例证：样本里 95841 / 96163 / 96314 / 96516 四个 baseBuild 的
 * `m_version` 都是 `5.0.15`，用同属 5.0.15 的 `protocol95299` 可完整解码
 * （tracker / game / message 事件全部读到流末尾）。
 *
 * 所以官方 `json/` 目录是稀疏的（92 个版本跨 11 年），这不是数据缺失，
 * 而是「只在补丁级别发布定义」。按 baseBuild 精确匹配会把 4/5 的样本
 * 误判成「不支持」。
 *
 * ## 选择顺序
 *
 * 1. 求 `bound` = 官方版本表里 ≤ baseBuild 的最大值（即该录像所属补丁的定义）。
 * 2. `bound` 已内置 → 直接用它，**不算降级**（这是它的正确协议）。
 * 3. 未内置 → 取内置版本里与 baseBuild 数值最接近的一份，**标 degraded**。
 *
 * 第 3 步用「数值距离」而不是「取更旧的」，是因为补丁之间 build 号跨度差异极大
 * （5.0.15 → 5.0.16 差 2065，而 97425 → 97563 只差 138），数值更近的通常同代。
 */
import { VersionedDecoder } from "../decoder.js";
import { AVAILABLE_BUILDS, OFFICIAL_BUILDS, PROTOCOL_TABLES, } from "./registry.generated.js";
/** 官方版本表里 ≤ build 的最大值；若 build 比官方最老的还老则返回 null。 */
function officialBound(build) {
    let low = 0;
    let high = OFFICIAL_BUILDS.length - 1;
    let found = null;
    while (low <= high) {
        const mid = (low + high) >> 1;
        const value = OFFICIAL_BUILDS[mid];
        if (value <= build) {
            found = value;
            low = mid + 1;
        }
        else {
            high = mid - 1;
        }
    }
    return found;
}
/** 内置版本里与本录像 build 数值最接近的一份。 */
function nearestAvailable(build) {
    let best = AVAILABLE_BUILDS[0];
    let bestDistance = Math.abs(best - build);
    for (const candidate of AVAILABLE_BUILDS) {
        const distance = Math.abs(candidate - build);
        if (distance < bestDistance) {
            best = candidate;
            bestDistance = distance;
        }
    }
    return best;
}
/**
 * 为给定 baseBuild 选一份协议表。
 *
 * @param baseBuild 录像 header 里的 `m_version.m_baseBuild`。
 * @throws 当 baseBuild 不是正整数时（说明 header 没读对，属于调用方错误）。
 */
export function selectProtocolTables(baseBuild) {
    if (!Number.isInteger(baseBuild) || baseBuild <= 0) {
        throw new Error(`非法的 baseBuild：${String(baseBuild)}`);
    }
    const bound = officialBound(baseBuild);
    if (bound !== null && Object.hasOwn(PROTOCOL_TABLES, bound)) {
        return {
            tables: PROTOCOL_TABLES[bound],
            protocolBuild: bound,
            degraded: false,
            note: bound === baseBuild
                ? `协议精确匹配 baseBuild ${baseBuild}`
                : `baseBuild ${baseBuild} 与该协议同属一个补丁（官方定义 ${bound}）`,
        };
    }
    const fallback = nearestAvailable(baseBuild);
    const distance = Math.abs(fallback - baseBuild);
    const boundText = bound === null ? "早于官方最早收录的版本" : `所属补丁为 ${bound}`;
    return {
        tables: PROTOCOL_TABLES[fallback],
        protocolBuild: fallback,
        degraded: true,
        note: `baseBuild ${baseBuild} ${boundText}，该补丁的官方定义未内置；` +
            `改用最接近的 ${fallback}（相差 ${distance}）。解析结果可能不完整。`,
    };
}
/** 已内置的协议版本，供诊断与测试使用。 */
export { AVAILABLE_BUILDS, OFFICIAL_BUILDS };
/**
 * 从 `replay.header` 字节里探测 baseBuild。
 *
 * 这解决一个「先有鸡还是先有蛋」：选协议要靠 baseBuild，而 header 本身
 * 也要协议才能解。官方 Python 的做法是拿录像自报的 build 去 import 对应模块
 * （`versions.build()`），对我们没内置的 build 就直接失败 —— 这条不能照搬。
 *
 * 实际做法是**从最新往旧逐个试**，第一个能读出正整数 `m_baseBuild` 的就采用。
 * 依据：`m_version` 是 header 的第二个字段，结构跨补丁稳定（实测用 95299 的
 * 定义能正确读出 4.2.1 老录像的 baseBuild、耗时与地图名）。
 *
 * 注意：探测成功**不等于**该协议能解这个录像 —— 跨补丁时 header 照读不误，
 * 只有 tracker 流才会崩。所以探测结果只是用来选正式协议，不能当匹配判据。
 */
export function probeBaseBuild(headerBytes) {
    const candidates = [...AVAILABLE_BUILDS].sort((a, b) => b - a);
    let lastError = null;
    for (const build of candidates) {
        const tables = PROTOCOL_TABLES[build];
        try {
            const decoder = new VersionedDecoder(headerBytes, tables.TYPE_INFOS);
            const header = decoder.instance(tables.TYPEIDS.replayHeader);
            const baseBuild = Number(header?.m_version?.m_baseBuild);
            if (Number.isInteger(baseBuild) && baseBuild > 0) {
                return { baseBuild, probeBuild: build };
            }
        }
        catch (error) {
            lastError = error;
        }
    }
    throw new Error(`所有内置协议都读不出 replay.header 的 baseBuild：${String(lastError)}`);
}
