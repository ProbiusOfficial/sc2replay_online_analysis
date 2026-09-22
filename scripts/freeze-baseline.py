#!/usr/bin/env python3
"""
冻结旧链路等价基线（P1c 的前置，不可跳过）。

为什么需要它：P1c `ReplayData` 组装的对齐对象**不是官方 s2protocol，而是旧 Pyodide 链路**
（sc2reader + spawningtool）。官方给了可复现金标准，所以 P1b 协议解码能提前做；但 P1c 的
参照物是即将被删的旧链路，必须先把它的输出固化成 JSON 快照，之后做字段级 diff 就不再依赖
Python 运行时。

关键点：**不重写逻辑，直接跑 `tools/baseline/parse_script.py`**。该文件是原
`js/parse_script.js` 里 `PARSE_SCRIPT` 模板串逐字节剥壳后的纯 Python（见其头部说明），
也就是站点当年在浏览器里实际执行的代码。本脚本只做「追加 runner → 执行」，
保证基线与被替代的实现同源。

> Pyodide 已于 P1c 下线，本脚本是**离线**工具：只用来重建基准，不进站点、不进 CI。

用法（必须在托管 venv 里跑，且已装 sc2reader / spawningtool / mpyq）：
    TMPDIR=<venv>/tmp <venv>/bin/python scripts/freeze-baseline.py

⚠️ 重跑会**覆盖** `tests/baseline/*.json`。除非确认要换基准，先备份再跑，
并与旧快照逐字节 diff —— 新旧一致才说明这次重跑是无害的。
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PARSE_SCRIPT_PY = REPO / "tools" / "baseline" / "parse_script.py"
SAMPLE_DIR = REPO / "sampleTest"
OUT_DIR = REPO / "tests" / "baseline"
CACHE_DIR = REPO / ".baseline-cache"

# 站点通过 micropip 装的是 PyPI 最新版；这里固定住实际使用的版本，便于复现。
EXPECTED = {"sc2reader": "1.9.0", "spawningtool": "3.0.0"}

RUNNER = '''

# ---- 以下是 freeze-baseline.py 追加的 runner，不属于 tools/baseline/parse_script.py ----
if __name__ == "__main__":
    import sys, json, os
    for path in sys.argv[1:]:
        data = extract_replay_data(path)
        with open(os.environ["OUT_JSON"], "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2, sort_keys=True)
        print("OK", path, "->", os.environ["OUT_JSON"])
'''


def read_source() -> str:
    """
    读入旧链路的 Python 源码。

    这个文件是**冻结参考**：它已经不含 JS 外壳，所以不再需要剥模板串。
    这里只做一致性护栏 —— 若有人把 `export const PARSE_SCRIPT` 又搬回来，
    或文件被替换成别的东西，立刻失败而不是悄悄产出一份「看起来没问题」的新基准。
    """
    text = PARSE_SCRIPT_PY.read_text(encoding="utf-8")
    # 检测的是 JS 赋值语句本体（含起始反引号），不是注释里提到它 —— 本文件头部的说明
    # 就会写出 `export const PARSE_SCRIPT` 这个词。
    shell = "export const PARSE_SCRIPT = " + chr(96)
    if shell in text:
        raise SystemExit(
            f"{PARSE_SCRIPT_PY} 里出现了 JS 模板串外壳 —— 它应该只是纯 Python，请人工检查"
        )
    if "def extract_replay_data(" not in text:
        raise SystemExit(
            f"{PARSE_SCRIPT_PY} 里找不到 extract_replay_data —— 文件被换掉了？"
        )
    return text


def safe_name(path: Path) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", path.name).strip("_")


def ensure_dir(path: Path) -> None:
    # 不要用 mkdir(exist_ok=True)：受管沙箱里 mkdir 走 broker，
    # 目录已存在时即使 exist_ok=True 也会抛 PermissionError(EEXIST)。
    if not path.exists():
        path.mkdir(parents=True)


def main() -> int:
    source = read_source()

    ensure_dir(CACHE_DIR)
    # 文件名不能带点，否则 Python 会当成包路径（parse_script.extracted）而 import 失败。
    extracted = CACHE_DIR / "parse_script.py"
    extracted.write_text(source + RUNNER, encoding="utf-8")

    # 让 runner 能 import 到剥出来的模块
    sys.path.insert(0, str(CACHE_DIR))
    import parse_script as ps  # noqa: E402

    for name, want in EXPECTED.items():
        mod = __import__(name)
        got = getattr(mod, "__version__", None) or getattr(mod, "version", None) or "?"
        got = str(got)
        flag = "✅" if got.startswith(want) else "⚠️"
        print(f"{flag} {name}: 期望 {want} / 实际 {got}")

    ensure_dir(OUT_DIR)
    replays = sorted(p for p in SAMPLE_DIR.glob("*.SC2Replay"))
    if not replays:
        raise SystemExit(f"没有找到样本录像：{SAMPLE_DIR}")

    manifest: dict[str, object] = {
        "generated_by": "scripts/freeze-baseline.py",
        "source_of_truth": "tools/baseline/parse_script.py（原 js/parse_script.js 的 PARSE_SCRIPT，已随 Pyodide 下线迁出）",
        "purpose": "P1c ReplayData 字段级 diff 的参照物；替代已下线的 Pyodide 路径",
        "parse_script_sha256": hashlib.sha256(source.encode("utf-8")).hexdigest(),
        "packages": {},
        "replays": {},
    }

    import sc2reader  # noqa: E402
    import spawningtool  # noqa: E402

    manifest["packages"]["sc2reader"] = getattr(sc2reader, "__version__", "?")
    manifest["packages"]["spawningtool"] = (
        getattr(spawningtool, "__version__", None) or "3.0.0 (无 __version__)"
    )

    for replay in replays:
        out = OUT_DIR / f"{safe_name(replay)}.json"
        data = ps.extract_replay_data(str(replay))
        text = json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True)
        out.write_text(text + "\n", encoding="utf-8")

        teams = data.get("teams", [])
        players = [p for t in teams for p in t.get("players", [])]
        manifest["replays"][safe_name(replay)] = {
            "bytes": replay.stat().st_size,
            "sha256": hashlib.sha256(replay.read_bytes()).hexdigest(),
            "baseline_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "map_name": data.get("map_name"),
            "game_length": data.get("game_length"),
            "players": len(players),
            "build_order_entries": sum(len(p.get("build_order", [])) for p in players),
        }
        print(
            f"  ✅ {replay.name}: 玩家 {len(players)} / build_order "
            f"{manifest['replays'][safe_name(replay)]['build_order_entries']} 条 → {out.name}"
        )

    (OUT_DIR / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"\n基线已冻结：{OUT_DIR}（manifest.json 已记录 parse_script 与录像的 sha256）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
