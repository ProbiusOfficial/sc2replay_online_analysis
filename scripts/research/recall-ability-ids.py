"""枚举 sc2reader 各版本里 Mass Recall 家族的 ability_id（= (int_id<<5)|column）。

背景：旧站点（原 `js/parse_script.js`，现冻结于 `tools/baseline/parse_script.py`）用 sc2reader 的 `CommandEvent.ability_name` 匹配
`{NexusMassRecall, MassRecallMothership, MothershipMassRecall, MassRecallMothershipCore}`
四名字来产出 `_kind: "recall"` 行。新解码器不跑 Python，所以要把这组名字**折算成数值 id 集合**
（与 chrono 的 `CHRONO_ABILITY_LINKS` 同一套做法），运行期只做集合成员判断。

ability_id 的构造见 sc2reader/data/__init__.py:
    int_id_base = int_id << 5
    for index, ability_name in real_abils: build.add_ability(ability_id=int_id_base | index, ...)

用法（托管 venv）：
    /Users/macmini/.workbuddy/binaries/python/envs/default/bin/python scripts/research/recall-ability-ids.py
"""
import os
import pkgutil

import sc2reader.data as D

DATA = os.path.dirname(D.__file__)
TARGET_NAMES = {
    "NexusMassRecall",
    "MassRecallMothership",
    "MothershipMassRecall",
    "MassRecallMothershipCore",
}

# str_id -> [column names]（列号即 m_abilCmdIndex）
rows = {}
for line in pkgutil.get_data("sc2reader.data", "ability_lookup.csv").decode("utf8").splitlines():
    if not line:
        continue
    cols = line.split(",")
    rows[cols[0]] = cols[1:]

print("ability_lookup.csv 里命中目标名字的行（列号 = m_abilCmdIndex）：")
hits = {}
for str_id, cols in rows.items():
    named = [(i, c) for i, c in enumerate(cols) if c]
    if not any(c in TARGET_NAMES for _, c in named):
        continue
    hits[str_id] = cols
    print(f"  str_id={str_id!r:28} 命名列={named}")

print(f"\n命中 str_id 数 = {len(hits)}")

print("\n各版本/资料片下的 ability_id：")
union = {}
for expansion in sorted(os.listdir(DATA)):
    d = os.path.join(DATA, expansion)
    if not os.path.isdir(d):
        continue
    for f in sorted(os.listdir(d)):
        if not f.endswith("_abilities.csv"):
            continue
        ver = f.replace("_abilities.csv", "")
        ids = {}
        for line in pkgutil.get_data("sc2reader.data", f"{expansion}/{f}").decode("utf8").splitlines():
            if not line:
                continue
            parts = line.strip().split(",")
            if len(parts) != 2:
                continue
            int_id, str_id = parts
            if str_id not in hits:
                continue
            base = int(int_id, 10) << 5
            for i, c in enumerate(hits[str_id]):
                if c:
                    ids[base | i] = c
        if ids:
            print(f"  {expansion}/{ver:>8}: {sorted(ids.items())}")
            for k, v in ids.items():
                union.setdefault(k, set()).add(v)

print("\n所有版本取并集后，每个 id 对应的名字（>1 个名字 = 冲突，必须警惕）：")
for k in sorted(union):
    print(f"  {k:>8} (link={k >> 5:>5} cmd={k & 31:>2}): {sorted(union[k])}")
print(f"\n并集大小 = {len(union)} 个 id")
print("links 集合 =", sorted({k >> 5 for k in union}))
print("cmdIndex 集合 =", sorted({k & 31 for k in union}))
