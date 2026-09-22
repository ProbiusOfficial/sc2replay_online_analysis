#!/usr/bin/env python3
"""
把 sc2reader 里 `ReplayData` 需要的大厅/客户端常量编译成 TS —— **自动生成，勿手改**。

三张表：

| 来源                             | 名称                    | 用途                                                       |
| -------------------------------- | ----------------------- | ---------------------------------------------------------- |
| `data/attributes.json` attrid 3000 | `Game Speed`            | `replay.speed`，`start_time` 推算的查表键                   |
| `data/attributes.json` attrid 3001 | `Race`                  | `players[].race`（**`pick_race` 的首字母**，可能是 `R`）    |
| `constants.py`                     | `GAME_SPEED_FACTOR`     | `start_time = unix - (frames // fps) // FACTOR[资料片][速度]` |

为什么必须 codegen：前两张在 sc2reader 的 `data/attributes.json` 里，**不在协议表里**，
协议解出来的只是 4 个原始字节（见 `events.ts::decodeReplayAttributesEvents`）；
`GAME_SPEED_FACTOR` 是手写常量表，抄一遍就有抄错的风险。

用法：
    TMPDIR=<venv>/tmp <venv>/bin/python scripts/gen-lobby-properties.py           # 生成
    TMPDIR=<venv>/tmp <venv>/bin/python scripts/gen-lobby-properties.py --check   # 只校验
"""

from __future__ import annotations

import hashlib
import json
import pkgutil
import sys
from string import Template
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT_TS = REPO / "js" / "worker" / "decoder" / "data" / "lobby_properties.generated.ts"

# `sc2reader/constants.py` 用 `int(key)` 建 `LOBBY_PROPERTIES`，键就是十进制字符串。
# `resources.py:370` 拿 scope 16 的 `Game Speed` 当 `replay.speed`、
# `resources.py:1107` 拿 0xBB8(=3000) 当 Game Speed、0xBB9(=3001) 当 Race。
GAME_SPEED_ATTRIBUTE_ID = 3000
RACE_ATTRIBUTE_ID = 3001

# attrid → 期望的属性名。名字对不上说明 sc2reader 换了语义，直接报错而不是生成错的表。
WANTED = [
    (GAME_SPEED_ATTRIBUTE_ID, "Game Speed", "GAME_SPEED"),
    (RACE_ATTRIBUTE_ID, "Race", "RACE"),
]

HEADER = """/**
 * 大厅属性表 + 速度系数（`replay.attributes.events` / `constants.py`）
 * —— **自动生成，请勿手改**。
 *
 * 由 `scripts/gen-lobby-properties.py` 从 sc2reader 产出。
 * 来源：sc2reader $version；`data/attributes.json` sha256 `$sha`。
 *
 * ## 取值链（属性表）
 *
 * `replay.attributes.events` → `decodeReplayAttributesEvents()` → `{scope: {attrid: [原始 4 字节]}}`。
 * 取 `scope == 相关玩家`、`attrid == 表 id` 的那条，把 4 字节按 UTF-8 解成 4 字符码，在本表里查可读名。
 *
 * **查不到时 sc2reader 会置 `None`**（`objects.py::Attribute.__init__` 捕获 `KeyError` 的写法），
 * 不是回落到默认值 —— 本实现保持一致。
 *
 * 注意 `decodeReplayAttributesEvents` 输出的字节**已经是可查表的形态**：
 * 官方 s2protocol 的 `[::-1].strip(b'\\x00')` 与 sc2reader 的
 * `"".join(reversed(read_string(4)))` + `[::-1]` 两次反转，净效果相同（实测 `Fasr`/`Zerg` 直接命中）。
 */
$blocks"""

ATTR_BLOCK = """
/** `Game Speed` 的属性 id。用于 `start_time` 推算（查 `GAME_SPEED_FACTOR`）。 */
export const $const_id = $attrid;

/** 4 字符码 → 可读的 `$name` 名。 */
export const $const_lookup: Readonly<Record<string, string>> = {
$entries
};
"""

FACTOR_BLOCK = """
/**
 * `sc2reader/constants.py::GAME_SPEED_FACTOR`（原文逐字照搬）。
 *
 * `start_time` 用的系数，**不是** `1.4` 那种体感倍率，是 sc2reader 自己的一套表：
 *
 * ```python
 * # resources.py:274-282（load_level 0）
 * fps = self.game_fps                      # 恒为 16.0
 * if 34784 <= self.build:  fps *= 1.4      # LotV 录像 → 22.4
 * self.length = Length(seconds=int(self.frames / fps))
 *
 * # resources.py:431-436（load_details，覆盖上面的 real_length）
 * self.real_length = Length(seconds=self.length.seconds // GAME_SPEED_FACTOR[exp].get(speed, 1.0))
 * self.start_time = fromtimestamp(self.unix_timestamp - self.real_length.seconds)
 * ```
 *
 * 注意 `WoL` / `HotS` 的 `Faster` 是 `1.4`，`LotV` 的是 `1.0` —— 对 LotV 就等于不除。
 */
export const GAME_SPEED_FACTOR: Readonly<
  Record<string, Readonly<Record<string, number>>>
> = {
$entries
};
"""


def _version() -> str:
    import sc2reader

    return getattr(sc2reader, "__version__", "?")


def load_attributes() -> tuple[dict[int, tuple[str, dict]], str]:
    raw = pkgutil.get_data("sc2reader.data", "attributes.json")
    if raw is None:
        raise SystemExit("读不到 sc2reader/data/attributes.json —— 包结构变了？")
    sha = hashlib.sha256(raw).hexdigest()
    data = json.loads(raw.decode("utf8"))
    attrs = data.get("attributes", {})

    out: dict[int, tuple[str, dict]] = {}
    for attrid, want_name, _ in WANTED:
        key = str(attrid)
        if key not in attrs:
            raise SystemExit(f"attributes.json 里没有属性 {key} —— sc2reader 换了 id？")
        name, lookup = attrs[key]
        if name != want_name:
            raise SystemExit(f"属性 {key} 的名字是 {name!r}，期望 {want_name!r} —— 语义变了，别硬来")
        if not isinstance(lookup, dict) or not lookup:
            raise SystemExit(f"属性 {key} 的取值表不是非空 dict：{lookup!r}")
        bad = [k for k in lookup if len(k) != 4]
        if bad:
            raise SystemExit(f"属性 {key} 出现非 4 字符键：{bad!r} —— 「定长 4 字节」的假设不成立")
        out[attrid] = (name, lookup)
    return out, sha


def load_game_speed_factor() -> dict[str, dict[str, float]]:
    from sc2reader.constants import GAME_SPEED_FACTOR

    if not isinstance(GAME_SPEED_FACTOR, dict) or not GAME_SPEED_FACTOR:
        raise SystemExit(f"GAME_SPEED_FACTOR 形状不对：{GAME_SPEED_FACTOR!r}")
    for expansion, table in GAME_SPEED_FACTOR.items():
        if not isinstance(table, dict) or not table:
            raise SystemExit(f"GAME_SPEED_FACTOR[{expansion!r}] 不是非空 dict：{table!r}")
        for speed, factor in table.items():
            if not isinstance(factor, (int, float)) or isinstance(factor, bool):
                raise SystemExit(f"GAME_SPEED_FACTOR[{expansion!r}][{speed!r}] 不是数字：{factor!r}")
    return GAME_SPEED_FACTOR


def _entry_lines(pairs) -> str:
    return "".join(
        f"  {json.dumps(k, ensure_ascii=False)}: {json.dumps(v, ensure_ascii=False)},\n" for k, v in pairs
    ).rstrip("\n")


def emit_blocks(attrs: dict[int, tuple[str, dict]], factors: dict[str, dict[str, float]]) -> str:
    parts = []
    for attrid, name, const_prefix in WANTED:
        _, lookup = attrs[attrid]
        parts.append(
            Template(ATTR_BLOCK).substitute(
                attrid=attrid,
                name=name,
                const_id=f"{const_prefix}_ATTRIBUTE_ID",
                const_lookup=f"{const_prefix}_LOOKUP",
                entries=_entry_lines(sorted(lookup.items())),
            )
        )
    parts.append(
        Template(FACTOR_BLOCK).substitute(
            entries="\n".join(
                f"  {json.dumps(expansion, ensure_ascii=False)}: {{\n"
                + "".join(
                    f"    {json.dumps(speed, ensure_ascii=False)}: {json.dumps(factor, ensure_ascii=False)},\n"
                    for speed, factor in sorted(table.items())
                )
                + "  },"
                for expansion, table in sorted(factors.items())
            )
        )
    )
    return "".join(parts).rstrip("\n") + "\n"


def main() -> int:
    check_only = "--check" in sys.argv
    attrs, sha = load_attributes()
    factors = load_game_speed_factor()
    text = Template(HEADER).substitute(
        version=_version(), sha=sha, blocks=emit_blocks(attrs, factors)
    )

    if check_only:
        if not OUT_TS.exists():
            print(f"❌ 缺少生成物：{OUT_TS}")
            return 1
        if OUT_TS.read_text(encoding="utf8") != text:
            print(f"❌ {OUT_TS.relative_to(REPO)} 与 sc2reader 常量不一致 —— 请重新生成")
            return 1
        print(
            f"✅ {OUT_TS.relative_to(REPO)} 与 sc2reader 常量一致"
            f"（{len(WANTED)} 张属性表 + GAME_SPEED_FACTOR）"
        )
        return 0

    OUT_TS.parent.mkdir(parents=True, exist_ok=True)
    OUT_TS.write_text(text, encoding="utf8")
    print(f"✅ {OUT_TS.relative_to(REPO)}")
    print(f"   来源 sc2reader {_version()}，attributes.json sha256 {sha[:12]}")
    for attrid, name, _ in WANTED:
        _, lookup = attrs[attrid]
        print(f"   {attrid} {name:11} {len(lookup)} 项：{', '.join(sorted(lookup))}")
    for expansion, table in sorted(factors.items()):
        print(f"   GAME_SPEED_FACTOR[{expansion}] {len(table)} 项：{', '.join(sorted(table))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
