"""枚举 sc2reader 各 LotV 版本里 ChronoBoost 家族的 ability_id（= (int_id<<5)|column）。

ability_id 的构造见 sc2reader/data/__init__.py:
    int_id_base = int_id << 5
    for index, ability_name in real_abils: build.add_ability(ability_id=int_id_base | index, ...)
"""
import os
import pkgutil

import sc2reader.data as D

DATA = os.path.dirname(D.__file__)

# str_id → [column names]
rows = {}
for line in pkgutil.get_data("sc2reader.data", "ability_lookup.csv").decode("utf8").splitlines():
    if not line:
        continue
    cols = line.split(",")
    rows[cols[0]] = cols[1:]

CHRONO_ROWS = {k: v for k, v in rows.items() if any("ChronoBoost" in (c or "") for c in v)}
print("ability_lookup.csv 里含 ChronoBoost 的行：")
for k, v in CHRONO_ROWS.items():
    print(f"  {k}: {[(i, c) for i, c in enumerate(v) if c]}")

print("\n各 LotV 版本的 ChronoBoost ability_id：")
union = {}
for f in sorted(os.listdir(os.path.join(DATA, "LotV"))):
    if not f.endswith("_abilities.csv"):
        continue
    ver = f.replace("_abilities.csv", "")
    ids = {}
    for line in pkgutil.get_data("sc2reader.data", f"LotV/{f}").decode("utf8").splitlines():
        if not line:
            continue
        int_id, str_id = line.strip().split(",")
        if str_id not in CHRONO_ROWS:
            continue
        base = int(int_id, 10) << 5
        for i, c in enumerate(CHRONO_ROWS[str_id]):
            if c:
                ids[base | i] = c
    print(f"  {ver:>8}: {sorted(ids.items())}")
    for k, v in ids.items():
        union.setdefault(k, set()).add(v)

print("\n所有 LotV 版本取并集后，每个 id 对应的名字（>1 个名字 = 冲突）：")
for k in sorted(union):
    print(f"  {k:>8} (link={k>>5:>5} cmd={k&31:>2}): {sorted(union[k])}")
print(f"\n并集大小 = {len(union)} 个 id")
