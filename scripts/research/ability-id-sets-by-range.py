"""按 sc2reader 的 datapack 区间，码出「时空加速」与「星空加速(Mass Recall)」两族 ability link 集合。

动机（本次调研的核心发现）：`m_abilLink` **不是全局唯一**的 —— 同一个 link 在不同补丁里是不同能力。
实测：LotV datapack `89720`（build 89634..95121）里 link 723 = `NexusMassRecall`，
而 `96883`（build 95122..97363）里 link 723 = `ChronoBoostEnergyCost`、link 724 = `NexusMassRecall`，
`97364` 里 link 724 = `ChronoBoostEnergyCost`、725 = `NexusMassRecall`。
所以跨版本取并集会把「星空加速」误判成「时空加速」（反之亦然）。必须**按区间**取集合。

区间来源：逐字复刻 `sc2reader/resources.py::register_default_datapacks()` 的 filter 上下界
（**注意上下界不等于文件名的数字**，例如 `89720` 那份表的区间是 `89634 <= build < 95122`）。

用法（托管 venv）：
    /Users/macmini/.workbuddy/binaries/python/envs/default/bin/python scripts/research/ability-id-sets-by-range.py
"""
import os
import pkgutil
import re

import sc2reader.data as D
from sc2reader import resources as R

DATA = os.path.dirname(D.__file__)

CHRONO_PAT = "ChronoBoost"
RECALL_NAMES = {
    "NexusMassRecall",
    "MassRecallMothership",
    "MothershipMassRecall",
    "MassRecallMothershipCore",
}


def load_abil_lookup():
    out = {}
    raw = pkgutil.get_data("sc2reader.data", "ability_lookup.csv").decode("utf8")
    for line in raw.splitlines():
        if not line:
            continue
        cols = line.split(",")
        out[cols[0]] = cols[1:]
    return out


LOOKUP = load_abil_lookup()


def families(str_id):
    """返回该 str_id 属于哪些族（chrono / recall）。"""
    cols = LOOKUP.get(str_id, [])
    fams = set()
    if CHRONO_PAT in str_id or any(CHRONO_PAT in c for c in cols if c):
        fams.add("chrono")
    if str_id in RECALL_NAMES or any(c in RECALL_NAMES for c in cols if c):
        fams.add("recall")
    return fams


def _datapack_file(expansion, key):
    """(expansion, datapack key) → 实际读取的 abilities.csv 路径。

    复刻 `sc2reader/data/__init__.py`：`hots_builds["38215"] = load_build("LotV", "base")`
    —— HotS 的 38215 这份表其实来自 LotV/base，文件名对不上，必须特判。
    """
    if expansion == "HotS" and key == "38215":
        return "LotV", "base"
    return expansion, key


def links_for(expansion, version):
    """读 <expansion>/<version>_abilities.csv，返回 {(link): fams} 与重复 int_id 表。"""
    expansion, version = _datapack_file(expansion, version)
    out = {}
    dups = {}
    raw = pkgutil.get_data("sc2reader.data", f"{expansion}/{version}_abilities.csv").decode("utf8")
    for line in raw.splitlines():
        if not line:
            continue
        parts = line.strip().split(",")
        if len(parts) != 2:
            continue
        int_id, str_id = parts
        if int_id in dups:
            dups[int_id].add(str_id)
        else:
            dups[int_id] = {str_id}
        fams = families(str_id)
        if not fams:
            continue
        base = int(int_id, 10) << 5
        for i, c in enumerate(LOOKUP.get(str_id, [])):
            if c:
                out.setdefault((base | i) >> 5, set()).update(fams)
    dup_only = {k: sorted(v) for k, v in dups.items() if len(v) > 1}
    return out, dup_only


# ---- 从 sc2reader/resources.py 抽出注册区间 ----
src = open(R.__file__, encoding="utf8").read()
body = src[src.index("def register_default_datapacks"):]
body = body[: body.index("# Internal Methods")]
RX = re.compile(
    r'datapacks\["(?P<exp>\w+)"\]\["(?P<key>[^"]+)"\],\s*\n\s*lambda r: r\.expansion == "(?P<exp2>\w+)" and (?P<cond>[^,]+),'
)
ranges = []
for m in RX.finditer(body):
    cond = m.group("cond").strip()
    lo = re.search(r"(\d+)\s*<=", cond)
    hi = re.search(r"<\s*(\d+)", cond)
    ranges.append(
        {
            "expansion": m.group("exp"),
            "key": m.group("key"),
            "lo": int(lo.group(1)) if lo else 0,
            "hi": int(hi.group(1)) if hi else None,
        }
    )

print(f"从 resources.py 抽出 {len(ranges)} 条区间\n")
print(f"{'expansion':10} {'table':8} {'区间':24} {'chrono links':40} {'recall links':40} 冲突")
results = []
for r in ranges:
    links, dups = links_for(r["expansion"], r["key"])
    if not links:
        continue
    chrono = sorted(k for k, v in links.items() if "chrono" in v)
    recall = sorted(k for k, v in links.items() if "recall" in v)
    both = sorted(set(chrono) & set(recall))
    rng = f"{r['lo']} <= b < {r['hi']}" if r["hi"] else f"{r['lo']} <= b"
    results.append({**r, "chrono": chrono, "recall": recall, "both": both})
    print(
        f"{r['expansion']:10} {r['key']:8} {rng:24} {str(chrono):40} {str(recall):40} "
        f"{'⚠️ ' + str(both) if both else 'ok'}"
    )

print("\n=== 跨区间并集（= 现在 chrono.ts 的做法）===")
u_chrono = sorted({k for r in results for k in r["chrono"]})
u_recall = sorted({k for r in results for k in r["recall"]})
print("并集 chrono links:", u_chrono)
print("并集 recall links:", u_recall)
print("并集冲突（同一 link 既 chrono 又 recall）:", sorted(set(u_chrono) & set(u_recall)))
print("\n⚠️ 并集冲突含义：用并集时，该 link 的指令会被两族同时命中，必然误判。")

print("\n=== 样本落点（build → 区间 → 集合）===")
# 样本全为 LotV（>= 38749）；只用 LotV 区间匹配即可，与 sc2reader 的 expansion 判定一致。
SAMPLE_BUILDS = {
    95841: "US_TVP",
    96163: "hero(w) vs reynor",
    96314: "CN_PVT_T-AI",
    96516: "CN_ZVP",
    62848: "US_TVR(T)_2018_old",
}
for build, label in SAMPLE_BUILDS.items():
    hit = None
    for r in results:
        if r["expansion"] != "LotV":
            continue
        if r["hi"] is None:
            if build >= r["lo"]:
                hit = r
        elif r["lo"] <= build < r["hi"]:
            hit = r
            break
    if hit:
        print(f"  build {build} ({label}): LotV/{hit['key']}  chrono={hit['chrono']}  recall={hit['recall']}")
    else:
        print(f"  build {build} ({label}): 未命中任何 LotV 区间")


print("\n=== 单个 datapack 内是否有重复 int_id（同一 id 两个名字）===")
for r in ranges:
    try:
        _, dups = links_for(r["expansion"], r["key"])
    except Exception as e:  # noqa: BLE001
        print(f"  {r['expansion']}/{r['key']}: 读取失败 {e}")
        continue
    if dups:
        print(f"  {r['expansion']}/{r['key']}: ⚠️ {dups}")
print("（无输出 = 无重复）")
