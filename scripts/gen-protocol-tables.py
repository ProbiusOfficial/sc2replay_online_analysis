#!/usr/bin/env python3
"""把 Blizzard 官方 s2protocol 的协议表转成 TS 数据模块。

## 为什么用官方 `protocolNNNNN.py` 而不是 `json/protocolNNNNN.json`

官方仓库里 `json/` 放的是 **SDL 原始 AST**（`TypeDecl` / `ConstDecl` / `Module`），
要让解码器能用，还得先跑一遍官方那个 SDL 编译器。而 `s2protocol/versions/protocolNNNNN.py`
是官方**已经编译好的**解码指令表（`typeinfos` + 三张事件表），直接拿它更省事，
也避免了"自己实现 SDL 编译器"这种偏离目标的工作。

这两份数据在官方仓库里是同源同步的，用哪个都不会引入版本偏差。

## 它做什么

用 `ast` 静态解析（**不执行**官方文件里的任何代码）：

    typeinfos                 解码指令表
    game_event_types          事件 id -> (typeid, 全名)
    message_event_types
    tracker_event_types
    *_typeid                  几个关键 typeid 常量

然后写成 `js/worker/decoder/protocols/protocol<build>.ts`。

## 用法

    python3 scripts/gen-protocol-tables.py                 # 用内置清单，联网下载
    python3 scripts/gen-protocol-tables.py 95299 97563     # 只生成指定版本
    python3 scripts/gen-protocol-tables.py --cache py/     # 优先读本地缓存

新增 SC2 补丁支持时，重跑一次这个脚本并把产物提交入仓即可 ——
运行时（浏览器/Worker）不需要 Python，也不需要联网。
"""

from __future__ import annotations

import argparse
import ast
import json
import sys
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = REPO_ROOT / "js" / "worker" / "decoder" / "protocols"
CACHE_DIR = REPO_ROOT / ".protocol-cache"

UPSTREAM = (
    "https://raw.githubusercontent.com/Blizzard/s2protocol/master/"
    "s2protocol/versions/protocol{build}.py"
)

# 默认收录的协议版本。选取依据见 plans/ROUTE-C-WASM-REFACTOR-PLAN.md §6-P1：
#   62848  2018 年 WoL/HotS 时代老录像样本（US_TVR(T)_2018_old）
#   95299  5.0.15 补丁，覆盖样本里 95841 / 96163 / 96314 / 96516 四个 baseBuild
#   97563  截至 2026-09-21 官方最新（5.0.16）
# 运行时会做「向下取整」匹配，所以不必把官方 92 个版本全收进来 ——
# 只有落在已收录版本之后的 build 才会走降级路径。
DEFAULT_BUILDS = [62848, 95299, 97563]

# 要提取的顶层赋值。值都是字面量，ast.literal_eval 可以安全地还原。
SCALAR_KEYS = [
    "game_eventid_typeid",
    "message_eventid_typeid",
    "tracker_eventid_typeid",
    "svaruint32_typeid",
    "replay_userid_typeid",
    "replay_header_typeid",
    "game_details_typeid",
    "replay_initdata_typeid",
]
TABLE_KEYS = [
    "typeinfos",
    "game_event_types",
    "message_event_types",
    "tracker_event_types",
]

TS_HEADER = """/* eslint-disable */
/**
 * 自动生成，请勿手工编辑。
 *
 * 源：Blizzard/s2protocol -> s2protocol/versions/protocol{build}.py
 * 生成器：scripts/gen-protocol-tables.py
 * 许可：MIT（Blizzard Entertainment）
 *
 * 修改协议内容请重跑生成器，不要直接改这个文件。
 */

import type {{ EventTypeTable, TypeInfo }} from "../decoder.js";

export const PROTOCOL_BUILD = {build};
"""


def fetch(build: int, cache_dir: Path, allow_network: bool) -> str:
    """取官方协议文件内容；优先用缓存。"""
    cached = cache_dir / f"protocol{build}.py"
    if cached.exists():
        return cached.read_text(encoding="utf-8")
    if not allow_network:
        raise SystemExit(
            f"protocol{build}.py 不在缓存 {cache_dir} 里，且已禁用联网（--offline）"
        )
    url = UPSTREAM.format(build=build)
    print(f"  下载 {url}")
    with urllib.request.urlopen(url, timeout=60) as resp:
        text = resp.read().decode("utf-8")
    cache_dir.mkdir(parents=True, exist_ok=True)
    cached.write_text(text, encoding="utf-8")
    return text


def extract(source: str, build: int) -> dict:
    """从官方协议文件里取出需要的表。只做语法解析，不执行。"""
    tree = ast.parse(source, filename=f"protocol{build}.py")
    found: dict[str, object] = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        target = node.targets[0]
        if not isinstance(target, ast.Name):
            continue
        if target.id not in (*SCALAR_KEYS, *TABLE_KEYS):
            continue
        try:
            found[target.id] = ast.literal_eval(node.value)
        except ValueError as exc:  # pragma: no cover - 官方文件均为字面量
            raise SystemExit(f"protocol{build}.py 的 {target.id} 不是字面量：{exc}")

    missing = [k for k in (*SCALAR_KEYS, *TABLE_KEYS) if k not in found]
    if missing:
        raise SystemExit(f"protocol{build}.py 缺少这些定义：{missing}")

    # 健全性自检：几个关键 typeid 必须落在 typeinfos 范围内，且事件表不能为空。
    typeinfos = found["typeinfos"]
    assert isinstance(typeinfos, list)
    for key in SCALAR_KEYS:
        tid = found[key]
        if key.endswith("_typeid") and key not in (
            "game_eventid_typeid",
            "message_eventid_typeid",
            "tracker_eventid_typeid",
        ):
            if not (0 <= tid < len(typeinfos)):
                raise SystemExit(f"protocol{build}.py 的 {key}={tid} 越界")
    for key in ("game_event_types", "message_event_types", "tracker_event_types"):
        if not found[key]:
            raise SystemExit(f"protocol{build}.py 的 {key} 为空")
    return found


def to_json_literal(value: object) -> str:
    """序列化成紧凑 JSON。

    超出 JS 安全整数范围的值（协议里是 `-2**63`）会被写成字符串，
    TS 侧再用 BigInt 还原 —— 否则字面量在 JS 里会静默丢精度。
    """
    limit = 2**53

    def coerce(node: object) -> object:
        if node is None or isinstance(node, (bool, str, float)):
            return node
        if isinstance(node, int):
            if node > limit or node < -limit:
                return str(node)
            return node
        if isinstance(node, (list, tuple)):
            return [coerce(x) for x in node]
        if isinstance(node, dict):
            # JSON 的键必须是字符串；事件表的键是整数 id。
            return {str(k): coerce(v) for k, v in node.items()}
        raise SystemExit(f"无法序列化的值：{node!r}")

    return json.dumps(coerce(value), separators=(",", ":"), sort_keys=False)


def render(build: int, data: dict) -> str:
    parts = [TS_HEADER.format(build=build)]
    parts.append(
        f"\n/** 解码指令表（{len(data['typeinfos'])} 项）。索引即 typeid。 */\n"
        f"export const TYPE_INFOS: readonly TypeInfo[] = "
        f"{to_json_literal(data['typeinfos'])};\n"
    )
    for py_name, ts_name in (
        ("game_event_types", "GAME_EVENT_TYPES"),
        ("message_event_types", "MESSAGE_EVENT_TYPES"),
        ("tracker_event_types", "TRACKER_EVENT_TYPES"),
    ):
        table = data[py_name]
        parts.append(
            f"\n/** {len(table)} 项。 */\nexport const {ts_name}: EventTypeTable = "
            f"{to_json_literal(table)};\n"
        )
    parts.append(
        "\n/** 关键 typeid。命名与官方 Python 侧保持一致，便于对照。 */\n"
        "export const TYPEIDS = {\n"
        f"  gameEventId: {data['game_eventid_typeid']},\n"
        f"  messageEventId: {data['message_eventid_typeid']},\n"
        f"  trackerEventId: {data['tracker_eventid_typeid']},\n"
        f"  svaruint32: {data['svaruint32_typeid']},\n"
        f"  replayUserId: {data['replay_userid_typeid']},\n"
        f"  replayHeader: {data['replay_header_typeid']},\n"
        f"  gameDetails: {data['game_details_typeid']},\n"
        f"  replayInitdata: {data['replay_initdata_typeid']},\n"
        "} as const;\n"
    )
    return "".join(parts)


def fetch_official_builds(cache_dir: Path, allow_network: bool) -> list[int]:
    """取官方 `json/` 目录收录的全部协议版本号（升序）。

    这张表就是**补丁边界**：官方只在补丁级别变更协议，所以某个 build
    只要落在「某个官方版本之后、下一个官方版本之前」，就由前一个版本服务。

    运行时的版本选择靠它判断「当前 build 是否已经跨过补丁边界」——
    跨了就必须降级告警，因为内置的那份定义不再是该 build 的真定义。
    """
    cached = cache_dir / "official-builds.json"
    if cached.exists():
        return json.loads(cached.read_text(encoding="utf-8"))
    if not allow_network:
        raise SystemExit(
            f"official-builds.json 不在缓存 {cache_dir} 里，且已禁用联网（--offline）"
        )
    url = "https://api.github.com/repos/Blizzard/s2protocol/contents/json?per_page=300"
    print(f"  抓取官方版本列表 {url}")
    request = urllib.request.Request(url, headers={"User-Agent": "sc2replay-online-analysis"})
    with urllib.request.urlopen(request, timeout=60) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    builds = sorted(
        int(entry["name"][len("protocol") : -len(".json")])
        for entry in payload
        if entry["name"].startswith("protocol") and entry["name"].endswith(".json")
    )
    cache_dir.mkdir(parents=True, exist_ok=True)
    cached.write_text(json.dumps(builds, indent=1), encoding="utf-8")
    return builds


def render_registry(builds: list[int], official: list[int]) -> str:
    imports = "\n".join(
        f'import * as protocol{b} from "./protocol{b}.js";' for b in builds
    )
    entries = ",\n".join(f"  {b}: protocol{b}" for b in builds)
    return f"""/* eslint-disable */
/**
 * 自动生成，请勿手工编辑。
 * 生成器：scripts/gen-protocol-tables.py
 */

import type {{ ProtocolTables }} from "../decoder.js";
{imports}

/** 已内置的协议表，键是官方发布该定义时的 baseBuild。 */
export const PROTOCOL_TABLES: Readonly<Record<number, ProtocolTables>> = {{
{entries},
}};

/** 已内置版本号，升序。 */
export const AVAILABLE_BUILDS: readonly number[] = {json.dumps(builds)};

/**
 * 官方 `json/` 目录收录的全部协议版本，升序。
 *
 * **这是补丁边界表**。判断依据：某 build 落在 `OFFICIAL_BUILDS[i]` 之后、
 * `OFFICIAL_BUILDS[i+1]` 之前时，它的协议就是 `OFFICIAL_BUILDS[i]`；
 * SC2 只在补丁级别变更协议（实测：95841 / 96163 / 96314 / 96516 四个
 * baseBuild 同属 5.0.15，同用 protocol95299 可完整解码）。
 *
 * 运行时用它区分两种「找不到精确版本」：
 *   - build 仍在某个内置版本的补丁区间内 → 正常，不算降级
 *   - build 已经跨过补丁边界          → 真降级，必须告警
 */
export const OFFICIAL_BUILDS: readonly number[] = {json.dumps(official)};
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("builds", nargs="*", type=int, default=None)
    parser.add_argument("--cache", type=Path, default=CACHE_DIR)
    parser.add_argument("--offline", action="store_true", help="只用缓存，不联网")
    args = parser.parse_args()

    builds = sorted(set(args.builds if args.builds else DEFAULT_BUILDS))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"生成 {len(builds)} 个协议表 -> {OUT_DIR.relative_to(REPO_ROOT)}")

    for build in builds:
        source = fetch(build, args.cache, allow_network=not args.offline)
        data = extract(source, build)
        target = OUT_DIR / f"protocol{build}.ts"
        target.write_text(render(build, data), encoding="utf-8")
        size = target.stat().st_size
        print(
            f"  protocol{build}.ts  {size:>7,} B  "
            f"typeinfos={len(data['typeinfos'])}  "
            f"events={len(data['game_event_types'])}"
            f"/{len(data['message_event_types'])}"
            f"/{len(data['tracker_event_types'])}"
        )

    registry = OUT_DIR / "registry.generated.ts"
    official = fetch_official_builds(args.cache, allow_network=not args.offline)
    registry.write_text(render_registry(builds, official), encoding="utf-8")
    print(
        f"  registry.generated.ts  {registry.stat().st_size:,} B "
        f"(内置 {len(builds)} 个，官方共 {len(official)} 个)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
