#!/usr/bin/env python3
"""
codegen：把 spawningtool 的 LotV 常量表转成 TS 数据模块。

为什么是 spawningtool 而不是 sc2reader 的 train_commands.json
------------------------------------------------------------
两者都能给出建造时长，但量纲和新鲜度不同（均为 2026-09-21 实测）：

| 来源                                | 数值单位                       | 覆盖                     |
| ----------------------------------- | ------------------------------ | ------------------------ |
| `sc2reader/data/train_commands.json`| **16 fps 游戏秒**（精确实测）   | WoL/HotS 时代，缺 LotV 单位 |
| `spawningtool/lotv_constants.py`    | 源码是"暴雪显示秒"，**导入时** `*= 22.4` 后变成 **16 fps 游戏帧** | 当前 LotV 平衡，142 个条目 |

实测依据（`scripts/research/build-order-timebase.mjs` + `calibrate-lotv.mjs`）：
- 虫族 `Egg → Born` 的 Δ 帧在 16 fps 下全是整数：Drone 272 / Overlord 400 / Zergling 384 /
  Hydralisk 528 / Viper 640 —— 与 `train_commands.json` 的 17/25/24/33/40 秒严格吻合。
- `train_commands.json` 记 Oracle=60s，但 LotV 实为 37s；它在 LotV 录像上会系统性偏老。
- 旧站点（已下线的 Pyodide 链路）用的就是 spawningtool（`sc2reader 1.9.0` + `spawningtool 3.0.0`，
  经 `micropip` 装 PyPI 版），所以**要对齐 P1c 就必须用它**。

因此本脚本以 `lotv_constants.py` 为唯一来源，把 `build_time` 统一成 **16 fps 游戏帧**，
并保留 `race / type / is_morph / built_from` 供上层使用。

用法（托管 venv）：
    TMPDIR=<venv>/tmp <venv>/bin/python scripts/gen-build-times.py
    TMPDIR=<venv>/tmp <venv>/bin/python scripts/gen-build-times.py --check
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from string import Template

REPO = Path(__file__).resolve().parent.parent
OUT_TS = REPO / "js" / "worker" / "decoder" / "data" / "build_times.generated.ts"

RACE_CODE = {"Terran": "T", "Protoss": "P", "Zerg": "Z"}
TYPE_CODE = {"Unit": "Unit", "Building": "Building", "Upgrade": "Upgrade"}

# parser.py BuildEvent.is_worker() —— 逐字照搬，别自己发明。
WORKER_UNITS = ["SCV", "Drone", "Probe", "Infested SCV", "Primal Drone"]

HEADER = '''/**
 * 建造时长数据表 —— **自动生成，请勿手改**。
 *
 * 由 `scripts/gen-build-times.py` 从 spawningtool 的 `lotv_constants.py` 产出。
 * 来源：spawningtool $version（PyPI），源码 sha256 `$sha`。
 *
 * ## 单位约定（关键，先读这段再用）
 *
 * 本文件所有 `loops` 都是 **16 fps 游戏帧**（game loops），不是秒，也不是"暴雪显示秒"。
 * spawningtool 源码里写的是显示秒，它在该模块**导入时**统一做了 `build_time *= 22.4`
 * （`FRAMES_PER_SECOND`），换算完就是游戏帧。这正是 `frame = born_frame - build_time`
 * 量纲自洽的原因 —— 也是本项目实测确认的「时间基准是 16 fps」那条结论的落地点。
 *
 * 所以上层取值时：
 * ```
 * startFrame = bornFrame - BUILD_TIMES[unit].loops;   // 都是 game loop
 * startTime  = Math.trunc(startFrame / 16);           // 与旧链路 `tools/baseline/parse_script.py` 的 `>> 4` 一致
 * ```
 *
 * ## 来源选择依据
 *
 * 备选来源 `sc2reader/data/train_commands.json` 的数值虽精确（16 fps 游戏秒），
 * 但停在 WoL/HotS 时代：Oracle 记 60s 而 LotV 实为 37s，且缺 Cyclone / Liberator /
 * Adept 等 LotV 单位。要与旧链路（已下线的 Pyodide 路径）对齐、且对 LotV 录像正确，只能用本表。
 */

/** 游戏逻辑帧率。SC2 录像的 `_gameloop` 就是这个基准。 */
export const GAME_LOOPS_PER_SECOND = 16;

/** spawningtool 的换算常数；`源码显示秒 × 22.4 = 本表 loops`。 */
export const SPAWNINGTOOL_FRAMES_PER_SECOND = 22.4;

/** 折跃门提速生效的最低 build（`WARPGATE_PERCENTAGE_BUILD`）。低于它的录像不受影响。 */
export const WARPGATE_PERCENTAGE_BUILD = $warpgateBuild;

/** 单位 / 建筑 / 升级的建造时长。 */
export interface BuildTimeEntry {
  /** 建造耗时，单位 **16 fps 游戏帧**。 */
  loops: number;
  /** 所属种族；升级没有种族时为 null。 */
  race: "T" | "P" | "Z" | null;
  type: "Unit" | "Building" | "Upgrade";
  /** 是否为变形单位（如 Baneling / BroodLord），spawningtool 用它对建筑形态变速。 */
  morph: boolean;
  /** 出兵建筑（spawningtool 的 `built_from`），时空加速 / 折跃门判定要用。 */
  from: string[];
}

export const BUILD_TIMES: Record<string, BuildTimeEntry> = $buildTimes;

/**
 * 不该出现在建造表里的单位（spawningtool `BO_EXCLUDED`，逐字照搬）。
 *
 * 里面是三类东西，都不是"玩家主动造出来的东西"：
 * - 技能/召唤产物：`MULE` / `CalldownMULE` 系、`Locust*`、`Broodling`、`Changeling*`；
 * - 地图/引擎辅助对象：`InvisibleTargetDummy`（实测 2505 条，量最大）、`ParasiticBomb*`；
 * - 模式切换的另一个形态：`DisruptorPhased`、`AdeptPhaseShift`、`OracleStasisTrap`。
 *
 * 不过滤掉会直接毁掉建造表 —— 实测 `InvisibleTargetDummy` 一个就能顶掉全部真实条目。
 */
export const EXCLUDED_UNITS: string[] = $excluded;

/** 只在"变形歧义"时排除的形态名（spawningtool `BO_CHANGED_EXCLUDED`）。 */
export const CHANGED_EXCLUDED_UNITS: string[] = $changedExcluded;

/** 不参与建造表的行为类升级（喷涂）。 */
export const UPGRADE_EXCLUDED: string[] = $upgradeExcluded;

/** `is_worker` 判定集合，照搬 `parser.py` 的 `BuildEvent.is_worker()`。 */
export const WORKER_UNITS: string[] = $workerUnits;

/**
 * 平衡性热修的历史值，用于按录像时间戳回滚（`build_data_for_timestamp`）。
 * 形如 `unit → [[被取代的时间戳(UTC 秒), 当时的 loops], ...]`，**由旧到新**。
 * 时间戳缺失时一律用当前值。
 */
export const BUILD_DATA_HISTORY: Record<string, [number, number][]> = $history;

/** spawningtool 会追踪的能力名（时空加速 / 折跃门提速判定用，尚未落地的部分）。 */
export const TRACKED_ABILITIES: string[] = $tracked;
'''


def load_constants():
    """从托管 venv 里读已安装的 spawningtool 常量模块（版本可追溯）。"""
    try:
        from spawningtool import lotv_constants as C  # type: ignore
    except ImportError as exc:  # pragma: no cover
        raise SystemExit(
            "读不到 spawningtool。请用托管 venv 运行：\n"
            "  TMPDIR=<venv>/tmp <venv>/bin/python scripts/gen-build-times.py\n"
            f"原始错误：{exc}"
        )
    return C


def emit_list(items) -> str:
    if not items:
        return "[]"
    inner = ", ".join(json.dumps(x, ensure_ascii=False) for x in items)
    return f"[{inner}]"


def emit_build_times(build_data) -> str:
    lines = []
    for unit in sorted(build_data):
        v = build_data[unit]
        race = RACE_CODE.get(v.get("race") or "", "null")
        race = "null" if race == "null" else f'"{race}"'
        typ = v.get("type", "Unit")
        if typ not in TYPE_CODE:
            raise SystemExit(f"{unit}: 未知 type {typ!r}")
        loops = v["build_time"]
        # 保留浮点原值（如 604.8），不做四舍五入 —— spawningtool 也是保留浮点，
        # 只在最后 `int(frame) >> 4` 处截断。提前 round 会让结果偏 1 帧。
        loops_txt = repr(float(loops)) if loops != int(loops) else str(int(loops))
        froms = ", ".join(json.dumps(x, ensure_ascii=False) for x in v.get("built_from", []))
        lines.append(
            f"  {json.dumps(unit, ensure_ascii=False)}: "
            f"{{ loops: {loops_txt}, race: {race}, type: \"{typ}\", "
            f"morph: {'true' if v.get('is_morph') else 'false'}, from: [{froms}] }},"
        )
    return "{\n" + "\n".join(lines) + "\n}"


def emit_history(history) -> str:
    lines = []
    for unit in sorted(history):
        entries = ", ".join(f"[{int(ts)}, {float(v)!r}]" for ts, v in history[unit])
        lines.append(f"  {json.dumps(unit, ensure_ascii=False)}: [{entries}],")
    return "{\n" + "\n".join(lines) + "\n}"


def main() -> int:
    check_only = "--check" in sys.argv
    C = load_constants()

    src = Path(C.__file__).read_text(encoding="utf-8")
    sha = hashlib.sha256(src.encode("utf-8")).hexdigest()
    version = _package_version()

    text = Template(HEADER).substitute(
        version=version,
        sha=sha,
        warpgateBuild=int(C.WARPGATE_PERCENTAGE_BUILD),
        buildTimes=emit_build_times(C.BUILD_DATA),
        excluded=emit_list(sorted(C.BO_EXCLUDED)),
        changedExcluded=emit_list(sorted(C.BO_CHANGED_EXCLUDED)),
        upgradeExcluded=emit_list(sorted(C.BO_UPGRADES_EXCLUDED)),
        workerUnits=emit_list(WORKER_UNITS),
        history=emit_history(C.BUILD_DATA_HISTORY),
        tracked=emit_list(sorted(C.TRACKED_ABILITIES)),
    )

    if check_only:
        if not OUT_TS.exists():
            print(f"❌ 缺少生成物：{OUT_TS}")
            return 1
        if OUT_TS.read_text(encoding="utf-8") != text:
            print(f"❌ {OUT_TS.relative_to(REPO)} 与当前常量表不一致 —— 请重新生成")
            return 1
        print(f"✅ {OUT_TS.relative_to(REPO)} 与常量表一致（sha256 {sha[:12]}）")
        return 0

    OUT_TS.parent.mkdir(parents=True, exist_ok=True)
    OUT_TS.write_text(text, encoding="utf-8")

    units = sum(1 for v in C.BUILD_DATA.values() if v["type"] == "Unit")
    buildings = sum(1 for v in C.BUILD_DATA.values() if v["type"] == "Building")
    upgrades = sum(1 for v in C.BUILD_DATA.values() if v["type"] == "Upgrade")
    print(f"✅ {OUT_TS.relative_to(REPO)}")
    print(f"   来源 spawningtool {version}，源码 sha256 {sha[:12]}")
    print(f"   BUILD_TIMES {len(C.BUILD_DATA)} 条（Unit {units} / Building {buildings} / Upgrade {upgrades}）")
    print(f"   EXCLUDED {len(C.BO_EXCLUDED)} / CHANGED_EXCLUDED {len(C.BO_CHANGED_EXCLUDED)} / UPGRADE_EXCLUDED {len(C.BO_UPGRADES_EXCLUDED)}")
    print(f"   BUILD_DATA_HISTORY {len(C.BUILD_DATA_HISTORY)} 个单位有历史值")
    return 0


def _package_version() -> str:
    try:
        from importlib.metadata import version

        return version("spawningtool")
    except Exception:  # pragma: no cover
        return "(未知)"


if __name__ == "__main__":
    raise SystemExit(main())
