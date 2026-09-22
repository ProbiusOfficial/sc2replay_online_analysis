#!/usr/bin/env python3
"""
codegen：把 sc2reader 的「能力 id ↔ 名称」表按 **datapack 区间** 压成两族 `m_abilLink` 集合。

为什么要按区间
--------------
`ability_id = (m_abilLink << 5) | m_abilCmdIndex`，而能力名不在录像里 —— 只能靠
`<expansion>/<version>_abilities.csv` 反查。问题是 **`m_abilLink` 不是全局唯一的**：
同一个 link 在不同补丁里是不同能力。实测三连移（LotV）：

| datapack  | 有效区间                | link 723                | link 724                | link 725            |
| --------- | ----------------------- | ----------------------- | ----------------------- | ------------------- |
| `89720`   | `89634 ≤ b < 95122`     | `NexusMassRecall`       | —                       | —                   |
| `96883`   | `95122 ≤ b < 97364`     | `ChronoBoostEnergyCost` | `NexusMassRecall`       | —                   |
| `97364`   | `97364 ≤ b`             | `RavenShredderMissile`  | `ChronoBoostEnergyCost` | `NexusMassRecall`   |

跨版本取并集会同时命中两族 → 必然误判（实测 US_TVP 的 3 条 `NexusMassRecall` 在并集下
被判成「时空加速」）。所以必须按区间取集合。

区间语义：**优先级 + 首个匹配**（不是「按 lo 排序的显式窗口」）
-------------------------------------------------------------
`sc2reader/resources.py::register_datapack()` 是 `registered_datapacks.insert(0, ...)`，
其文档明确写着 datapack 按 **reverse registration order** 检查（后注册者优先）。
配对的框选条件是 `lambda r: r.expansion == "X" and <cond>`。

后果：`LotV/base` 的框选条件是 `34784 <= r.build`（**无上界**），但它注册在
`LotV/44401` 之前 → 优先级更低 → **有效窗口被更高优先级的兄弟裁成 `[34784, 44401)`**。
所以本表**按优先级顺序**排列、查询时取**首个匹配**；不要按 `lo` 重排，也不要因为看到
「`base` 的 hi 是 null 却排在 `44401` 后面」就以为写错了 —— 那正是优先级语义。

用法（托管 venv）
-----------------
    TMPDIR=<venv>/tmp <venv>/bin/python scripts/gen-ability-links.py
    TMPDIR=<venv>/tmp <venv>/bin/python scripts/gen-ability-links.py --check
"""

from __future__ import annotations

import hashlib
import json
import pkgutil
import re
import sys
from pathlib import Path
from string import Template

import sc2reader.data as D
from sc2reader import resources as R

REPO = Path(__file__).resolve().parent.parent
OUT_TS = REPO / "js" / "worker" / "decoder" / "data" / "ability_links.generated.ts"

# ---- 两族的判据 ----
#
# 时空加速：能力名里含 `ChronoBoost`（实测只有 `TimeWarp` 与 `ChronoBoostEnergyCost` 两行）。
# 星空加速（Mass Recall）：4 个名字的并集；后三个在样本里没出现过，只做静态枚举。
CHRONO_PAT = "ChronoBoost"
RECALL_NAMES = frozenset(
    {
        "NexusMassRecall",
        "MassRecallMothership",
        "MothershipMassRecall",
        "MassRecallMothershipCore",
    }
)

# 资料片在 `register_default_datapacks()` 里的**注册顺序**（= 优先级从低到高）。
EXPANSION_REGISTRATION_ORDER = ("WoL", "HotS", "LotV")

HEADER = '''/**
 * 能力 link 集合（时空加速 / 星空加速）—— **自动生成，请勿手改**。
 *
 * 由 `scripts/gen-ability-links.py` 从 sc2reader 的 datapack 元数据产出。
 * 来源：sc2reader $version；`resources.py` sha256 `$sha`。
 *
 * ## 为什么不能只存一份集合（这是本模块存在的唯一理由）
 *
 * `ability_id = (m_abilLink << 5) | m_abilCmdIndex`，而 **`m_abilLink` 不是全局唯一的** ——
 * 同一个 link 在不同补丁里是不同能力。实测三连移（LotV）：
 *
 * | datapack | 有效区间            | link 723                | link 724                | link 725            |
 * | -------- | ------------------- | ----------------------- | ----------------------- | ------------------- |
 * | `89720`  | `89634 ≤ b < 95122` | `NexusMassRecall`       | —                       | —                   |
 * | `96883`  | `95122 ≤ b < 97364` | `ChronoBoostEnergyCost` | `NexusMassRecall`       | —                   |
 * | `97364`  | `97364 ≤ b`         | `RavenShredderMissile`  | `ChronoBoostEnergyCost` | `NexusMassRecall`   |
 *
 * 跨版本取并集会同时命中两族 → 必然误判（实测 US_TVP 的 3 条 `NexusMassRecall` 在并集下
 * 被判成「时空加速」）。**每个区间内部两族集合都不相交**，这正是按区间取集合能成立的前提。
 *
 * ## ⚠️ 区间语义是「优先级 + 首个匹配」，不是「按 lo 排序的窗口」
 *
 * `sc2reader/resources.py::register_datapack()` 做的是 `registered_datapacks.insert(0, ...)`，
 * 其文档写明按 **reverse registration order** 检查（**后注册者优先**）。
 *
 * 于是 `LotV/base` 虽然框选条件是 `34784 <= build`（无上界），但它注册在 `LotV/44401` 之前，
 * 优先级更低 —— **有效窗口被更高优先级的兄弟裁成 `[34784, 44401)`**。
 *
 * 所以本数组**按优先级从高到低排列**，`abilityLinksForBuild()` 取**首个匹配**。
 * 不要按 `lo` 重排、也不要把 `base` 的 `hi: null` 「修」成 `44401`：
 * 前者会改变结果，后者会丢掉「优先级」这个唯一正确语义。
 *
 * 各条目的**有效窗口**（生成时模拟优先级算出，仅供人读，不参与运行）：
 *
$effective
 *
 * ## 区间从哪来
 *
 * 逐字复刻 `sc2reader/resources.py::register_default_datapacks()` 的 filter 条件，
 * 上下界**不等于文件名**（`89720` 那份表的条件区间是 `89634 ≤ b < 95122`）。
 * 特例：`HotS/38215` 实际读 `LotV/base`（`sc2reader/data/__init__.py:462`）。
 *
 * ## 查询键 —— 别用错 build
 *
 * 应当传 `header.m_version.m_build`（对应 sc2reader 的 `replay.build = versions[4]`）。
 * **不是 `m_baseBuild`**（那是 `versions[5]`；本仓库的 `probeBaseBuild()` 取的是它，
 * 两者用途不同）。样本录像里两者恰好相等（95841 / 96163 / 96314 / 96516 / 62848），
 * 但协议上不保证。
 *
 * ## 已做的静态校验（生成时断言，失败即报错，绝不静默产出）
 *
 * 1. filter 的 `r.expansion` 与注册键一致；
 * 2. 每个区间内 `chrono ∩ recall == ∅`；
 * 3. 所有命中的 `m_abilCmdIndex` 都是 `0`（否则报错 —— 「只认 cmd 0」的前提被打破）；
 * 4. 覆盖完整性：`(资料片, build)` 在已声明边界内的每一种组合都能命中某一条。
 */

/** 资料片。判定见 `chrono.ts::expansionFromDetails()`（依赖 hash，权威）或 `expansionFromBaseBuild()`。 */
export type Expansion = "WoL" | "HotS" | "LotV";

export interface AbilityLinkRange {
  expansion: Expansion;
  /** datapack 键（`<expansion>/<key>_abilities.csv` 的文件名去后缀）。 */
  table: string;
  /** 框选下界（`lo <= build`）。 */
  lo: number;
  /** 框选上界（`build < hi`）；`null` 表示无上界，**不代表有效窗口无上界** —— 见文件头「优先级」。 */
  hi: number | null;
  /** 时空加速（Chrono Boost）家族的 `m_abilLink`，升序。 */
  chrono: readonly number[];
  /** 星空加速（Mass Recall）家族的 `m_abilLink`，升序。 */
  recall: readonly number[];
}

/**
 * 全部区间，**按优先级从高到低**（= sc2reader 的注册顺序取反）。
 * 查询必须取**首个匹配**，且必须同时带资料片（不同资料片的框选范围在数值上重叠）。
 */
export const ABILITY_LINK_RANGES: readonly AbilityLinkRange[] = $ranges;

export interface AbilityLinks {
  chrono: ReadonlySet<number>;
  recall: ReadonlySet<number>;
}

/** 未知 build / 未知资料片时的返回值。两组都空，调用方据此静默跳过（旧链路也是查不到就跳过）。 */
export const NO_ABILITY_LINKS: AbilityLinks = { chrono: new Set(), recall: new Set() };

/** 取**首个匹配**的区间 —— 顺序即优先级，不能改。 */
export function abilityLinksForBuild(
  build: number,
  expansion: Expansion | null | undefined,
): AbilityLinks {
  if (!expansion) return NO_ABILITY_LINKS;
  for (const range of ABILITY_LINK_RANGES) {
    if (range.expansion !== expansion) continue;
    if (build < range.lo) continue;
    if (range.hi !== null && build >= range.hi) continue;
    return { chrono: new Set(range.chrono), recall: new Set(range.recall) };
  }
  return NO_ABILITY_LINKS;
}
'''


def load_abil_lookup() -> dict[str, list[str]]:
    """`ability_lookup.csv` → `str_id → [下标 0 的名字, 下标 1 的名字, ...]`。

    等价于 sc2reader 的 `ABIL_LOOKUP`（`data/__init__.py` 读的是同一份文件）。
    """
    out: dict[str, list[str]] = {}
    raw = pkgutil.get_data("sc2reader.data", "ability_lookup.csv").decode("utf8")
    for line in raw.splitlines():
        if not line:
            continue
        cols = line.split(",")
        out[cols[0]] = cols[1:]
    return out


ABIL_LOOKUP = load_abil_lookup()


def family_of(name: str) -> set[str]:
    fams: set[str] = set()
    if CHRONO_PAT in name:
        fams.add("chrono")
    if name in RECALL_NAMES:
        fams.add("recall")
    return fams


def _resolve_table(expansion: str, key: str) -> tuple[str, str]:
    """`(expansion, datapack key)` → 实际读取的 csv 路径前缀。

    `hots_builds["38215"] = load_build("LotV", "base")` —— HotS 的这份表其实来自
    `LotV/base`，文件名对不上，必须特判（`sc2reader/data/__init__.py:462`）。
    """
    if expansion == "HotS" and key == "38215":
        return "LotV", "base"
    return expansion, key


def links_for(expansion: str, key: str) -> tuple[dict[int, set[str]], dict[int, set[int]]]:
    """读一份 abilities.csv，返回 `link → 家族集合` 与 `link → 命中的 cmd 下标集合`。

    逐字复刻 `sc2reader/data/__init__.py::load_build()` 的能力段：

    ```python
    int_id_base = int(int_id, 10) << 5
    abils = ABIL_LOOKUP[str_id]
    real_abils = [(i, a) for i, a in enumerate(abils) if a.strip() != ""]
    if len(real_abils) == 0: real_abils = [(0, str_id)]
    for index, ability_name in real_abils:
        build.add_ability(ability_id=int_id_base | index, name=ability_name, ...)
    ```

    即 **csv 第一列就是 link**（不是整条 ability_id），下标来自 `ability_lookup.csv` 的列序。
    """
    expansion, key = _resolve_table(expansion, key)
    raw = pkgutil.get_data("sc2reader.data", f"{expansion}/{key}_abilities.csv").decode("utf8")

    fams_by_link: dict[int, set[str]] = {}
    index_by_link: dict[int, set[int]] = {}

    for line in raw.splitlines():
        if not line:
            continue
        parts = line.strip().split(",")
        if len(parts) != 2:
            continue
        int_id_base, str_id = parts
        # sc2reader 这里是 `ABIL_LOOKUP[str_id]`，缺键会 KeyError —— 我们也照实报错。
        abils = ABIL_LOOKUP.get(str_id)
        if abils is None:
            raise SystemExit(
                f"{expansion}/{key}: `{str_id}` 不在 ability_lookup.csv 里（sc2reader 会 KeyError）"
            )

        real = [(i, a) for i, a in enumerate(abils) if a.strip() != ""]
        if not real:
            real = [(0, str_id)]

        link = int(int_id_base, 10)
        for index, ability_name in real:
            fams = family_of(ability_name)
            if not fams:
                continue
            fams_by_link.setdefault(link, set()).update(fams)
            index_by_link.setdefault(link, set()).add(index)

    return fams_by_link, index_by_link


def extract_ranges() -> list[dict]:
    """从 `sc2reader/resources.py` 抽出**注册顺序**的 datapack 条件（含一致性校验）。"""
    src = Path(R.__file__).read_text(encoding="utf8")
    body = src[src.index("def register_default_datapacks"):]
    body = body[: body.index("# Internal Methods")]
    pattern = re.compile(
        r'datapacks\["(?P<exp>\w+)"\]\["(?P<key>[^"]+)"\],\s*\n\s*'
        r'lambda r: r\.expansion == "(?P<exp2>\w+)" and (?P<cond>[^,]+),'
    )
    out = []
    for m in pattern.finditer(body):
        if m.group("exp") != m.group("exp2"):
            raise SystemExit(
                f"filter 与注册键不一致：datapacks[{m.group('exp')}] 的 filter 写的是 {m.group('exp2')}"
            )
        cond = m.group("cond").strip()
        lo = re.search(r"(\d+)\s*<=", cond)
        hi = re.search(r"<\s*(\d+)", cond)
        out.append(
            {
                "expansion": m.group("exp"),
                "key": m.group("key"),
                "lo": int(lo.group(1)) if lo else 0,
                "hi": int(hi.group(1)) if hi else None,
            }
        )
    if not out:
        raise SystemExit(
            "没能从 resources.py 抽出任何区间 —— sc2reader 版本可能变了，去看 register_default_datapacks()"
        )
    # 注册顺序必须是 (WoL..., HotS..., LotV...)，否则「注册顺序取反」这个优先级模型不成立。
    seen = [r["expansion"] for r in out]
    order_index = [EXPANSION_REGISTRATION_ORDER.index(e) for e in seen]
    if order_index != sorted(order_index):
        raise SystemExit(f"注册顺序不是 WoL→HotS→LotV，优先级模型需要重推：{seen}")
    return out


def _winner(ordered: list[dict], build: int, expansion: str) -> dict | None:
    """按「优先级 + 首个匹配」取区间。**必须带资料片** —— 不同资料片的框选范围在数值上重叠。"""
    for r in ordered:  # ordered 已是优先级从高到低
        if r["expansion"] != expansion:
            continue
        if build < r["lo"]:
            continue
        if r["hi"] is not None and build >= r["hi"]:
            continue
        return r
    return None


def effective_windows(ordered: list[dict]) -> list[tuple[dict, int, int | None]]:
    """按「优先级 + 首个匹配」模拟，算出每个条目的**有效窗口** `[lo, hi)`。

    生成物注释里要写人类可读的有效窗口（否则 `base` 的 `hi: null` 会让人以为它吞掉一切）。
    做法：把边界切成若干段，每段取左端点当代表点，看该点被哪条命中。**按资料片分开算**，
    否则优先级高的资料片会把它自己根本不会匹配的条目「吃掉」（如 LotV/base 会盖掉 HotS/38215）。
    """
    merged: list[list] = []
    for exp in EXPANSION_REGISTRATION_ORDER:
        group = [r for r in ordered if r["expansion"] == exp]
        if not group:
            continue
        cuts = set()
        for r in group:
            cuts.add(r["lo"])
            if r["hi"] is not None:
                cuts.add(r["hi"])
        cuts = sorted(cuts)
        probes = [cuts[0] - 1] + cuts

        segments: list[tuple[dict, int, int | None]] = []
        for i, point in enumerate(probes):
            w = _winner(group, point, exp)
            if w is None:
                continue
            end = cuts[0] if i == 0 else (cuts[i] if i < len(cuts) else None)
            segments.append((w, point, end))

        for w, lo, hi in segments:
            if merged and merged[-1][0] is w and merged[-1][2] == lo:
                merged[-1][2] = hi
            else:
                merged.append([w, lo, hi])
    return [(w, lo, hi) for w, lo, hi in merged]


def build_ranges() -> tuple[list[dict], list[str]]:
    """产出**优先级顺序**的区间，附人类可读的有效窗口说明。"""
    registered = extract_ranges()
    ordered = list(reversed(registered))  # 后注册者优先

    rows = []
    for r in ordered:
        fams_by_link, index_by_link = links_for(r["expansion"], r["key"])
        if not fams_by_link:
            continue
        # 校验 3：只认 cmd 0。若某条命中项的下标不是 0，前提被打破 → 直接报错。
        odd = {link: sorted(idx) for link, idx in index_by_link.items() if any(i != 0 for i in idx)}
        if odd:
            raise SystemExit(
                f"{r['expansion']}/{r['key']}: 命中的 cmdIndex 不全是 0 → {odd}\n"
                "「只认 m_abilCmdIndex === 0」的前提被打破，必须改成 (link, cmd) 对偶表。"
            )
        chrono = sorted(link for link, v in fams_by_link.items() if "chrono" in v)
        recall = sorted(link for link, v in fams_by_link.items() if "recall" in v)
        both = sorted(set(chrono) & set(recall))
        # 校验 2：区间内两族不得相交
        if both:
            raise SystemExit(f"{r['expansion']}/{r['key']}: 区间内 chrono 与 recall 相交 → {both}")
        rows.append(
            {
                "expansion": r["expansion"],
                "table": r["key"],
                "lo": r["lo"],
                "hi": r["hi"],
                "chrono": chrono,
                "recall": recall,
            }
        )

    # 校验 4：覆盖完整性。按资料片分开探，确保没有「谁都不匹配」的缝隙。
    wins = effective_windows(rows)
    for exp in EXPANSION_REGISTRATION_ORDER:
        group = [r for r in rows if r["expansion"] == exp]
        if not group:
            continue
        lowest = min(r["lo"] for r in group)
        probes = set()
        for r in group:
            probes.add(r["lo"])
            probes.add(r["lo"] - 1)
            if r["hi"] is not None:
                probes.add(r["hi"])
                probes.add(r["hi"] - 1)
        for p in sorted(probes):
            if p < lowest:
                continue
            if _winner(group, p, exp) is None:
                raise SystemExit(f"{exp} build {p} 无任何区间匹配 —— 区间表有缝隙")

    lines = []
    for r, lo, hi in wins:
        rng = f"{lo} ≤ build < {hi}" if hi is not None else f"{lo} ≤ build"
        lines.append(f" *   {r['expansion']:5} {r['table']:8} {rng}")
    return rows, lines


def _version() -> str:
    try:
        from importlib.metadata import version

        return version("sc2reader")
    except Exception:  # pragma: no cover
        return "(未知)"


def emit_ranges(rows: list[dict]) -> str:
    lines = []
    for r in rows:
        hi = "null" if r["hi"] is None else str(r["hi"])
        chrono = ", ".join(str(x) for x in r["chrono"])
        recall = ", ".join(str(x) for x in r["recall"])
        lines.append(
            f"  {{ expansion: {json.dumps(r['expansion'])}, table: {json.dumps(r['table'])}, "
            f"lo: {r['lo']}, hi: {hi}, chrono: [{chrono}], recall: [{recall}] }},"
        )
    return "[\n" + "\n".join(lines) + "\n]"


def main() -> int:
    check_only = "--check" in sys.argv

    resources_src = Path(R.__file__).read_text(encoding="utf8")
    sha = hashlib.sha256(resources_src.encode("utf8")).hexdigest()

    rows, effective = build_ranges()
    text = Template(HEADER).substitute(
        version=_version(), sha=sha, ranges=emit_ranges(rows), effective="\n".join(effective)
    )

    if check_only:
        if not OUT_TS.exists():
            print(f"❌ 缺少生成物：{OUT_TS}")
            return 1
        if OUT_TS.read_text(encoding="utf8") != text:
            print(f"❌ {OUT_TS.relative_to(REPO)} 与 sc2reader 的 datapack 元数据不一致 —— 请重新生成")
            return 1
        print(f"✅ {OUT_TS.relative_to(REPO)} 与 datapack 元数据一致（{len(rows)} 条区间）")
        return 0

    OUT_TS.parent.mkdir(parents=True, exist_ok=True)
    OUT_TS.write_text(text, encoding="utf8")

    print(f"✅ {OUT_TS.relative_to(REPO)}")
    print(f"   来源 sc2reader {_version()}，resources.py sha256 {sha[:12]}")
    print(f"   {len(rows)} 条区间（按优先级排列）")
    for exp in EXPANSION_REGISTRATION_ORDER:
        group = [r for r in rows if r["expansion"] == exp]
        if group:
            print(f"   {exp:5} {len(group):2} 条")
    print("   有效窗口：")
    for line in effective:
        print("  " + line.replace(" *   ", "   "))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
