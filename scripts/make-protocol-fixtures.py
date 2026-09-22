#!/usr/bin/env python3
"""用 Blizzard 官方 s2protocol 生成协议解码基准（金标准）。

## 定位

`scripts/gen-protocol-tables.py` 把官方协议表转成 TS；这个脚本则用官方
**Python 解码器**把样本录像的六个流解出来，存成基准。
两个脚本合起来构成 P1 的验收闭环：

    TS 解码结果  ⇄  官方 Python 解码结果

## 为什么要规范化

Python 与 JS 的类型对不上，直接比 JSON 会全是假差异：

| Python            | JS                     | 规范化后            |
| ----------------- | ---------------------- | ------------------- |
| `bytes`           | `Uint8Array`           | `"hex:0a1b..."`     |
| `int`（可能超 2^53）| `number` / `BigInt`  | 超范围转十进制字符串 |
| `str`             | `string`               | 原样                |

**规范化的规则必须与 `scripts/verify-protocol.mjs` 完全一致**，否则基准没法用。

## 用法

    pip install mpyq            # 只需要 mpyq，协议表由脚本自己准备
    python3 scripts/make-protocol-fixtures.py
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SAMPLE_DIR = REPO_ROOT / "sampleTest"
CACHE_DIR = REPO_ROOT / ".protocol-cache"
OUT_FILE = REPO_ROOT / "tests" / "fixtures" / "protocol-baseline.json"

UPSTREAM_S2P = (
    "https://raw.githubusercontent.com/Blizzard/s2protocol/master/s2protocol/{name}"
)
# mpyq 是「读取 MPQ 归档」的单文件实现。官方 s2protocol 只负责协议解码，
# 拆包要靠它；这里直接从上游取单文件，省掉一次 pip 安装。
UPSTREAM_MPYQ = "https://cdn.jsdelivr.net/gh/eagleflo/mpyq@master/mpyq.py"

# 规范化的整数上界：超过它就必须转字符串，否则 JS 侧会静默丢精度。
SAFE_INT = 2**53

# 每个流保留多少条完整事件。全量太大（game events 可达 3 万条），
# 但对拍又需要能看差异，所以「摘要 + 采样」双管齐下。
SAMPLE_HEAD = 8
SAMPLE_TAIL = 2


def download(url: str, target: Path) -> None:
    if target.exists():
        return
    print(f"  下载 {url}")
    target.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=60) as resp:
        target.write_text(resp.read().decode("utf-8"), encoding="utf-8")


def ensure_deps(cache_dir: Path) -> None:
    """备好跑官方解码所需的两样东西。

    - `s2protocol` 包：协议文件开头是 `from s2protocol.decoders import *`
    - `mpyq.py`：MPQ 归档读取
    """
    pkg = cache_dir / "s2protocol"
    pkg.mkdir(parents=True, exist_ok=True)
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    for name in ("compat.py", "decoders.py"):
        download(UPSTREAM_S2P.format(name=name), pkg / name)
    download(UPSTREAM_MPYQ, cache_dir / "mpyq.py")


def load_protocol(build: int, cache_dir: Path):
    """加载官方 `protocolNNNNN.py` 模块。"""
    path = cache_dir / f"protocol{build}.py"
    if not path.exists():
        return None
    spec = importlib.util.spec_from_file_location(f"_s2p_protocol{build}", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def normalize(value: object) -> object:
    """把 Python 的解码结果转成与 JS 侧可比的形状。规则与 verify 脚本一致。"""
    if value is None or isinstance(value, (bool, str, float)):
        return value
    if isinstance(value, (bytes, bytearray, memoryview)):
        return "hex:" + bytes(value).hex()
    if isinstance(value, int):
        return str(value) if abs(value) > SAFE_INT else value
    if isinstance(value, (list, tuple)):
        # 官方 `_real32` / `_real64` 返回单元素 tuple，这里展开成标量，
        # 与 TS 侧直接返回 number 的行为对齐。
        if isinstance(value, tuple) and len(value) == 1 and isinstance(value[0], float):
            return value[0]
        return [normalize(item) for item in value]
    if isinstance(value, dict):
        return {str(key): normalize(item) for key, item in value.items()}
    raise SystemExit(f"无法规范化的类型 {type(value)}: {value!r}")


def digest(items: list) -> str:
    """对事件序列取摘要。

    两个细节必须与 `scripts/verify-protocol.mjs` 完全一致，否则基准无法比对：

    - `sort_keys=True`：消除字段顺序差异（Python 的 dict 保序，JS 的对象也是，
      但两边解码路径不同，不能依赖顺序）。
    - `separators=(",", ":")`：JS 的 `JSON.stringify` 不插空格，Python 默认插，
      不统一就会每个事件都差几个字节，摘要必然对不上。
    """
    hasher = hashlib.sha256()
    for item in items:
        payload = json.dumps(
            item, sort_keys=True, ensure_ascii=False, separators=(",", ":")
        )
        hasher.update(payload.encode("utf-8"))
        hasher.update(b"\n")
    return hasher.hexdigest()


def summarize_stream(items: list) -> dict:
    """事件流基准：条数 + 摘要 + 首尾采样。"""
    return {
        "count": len(items),
        "digest": digest(items),
        "gameloopDigest": digest([item.get("_gameloop") for item in items]),
        "head": items[:SAMPLE_HEAD],
        "tail": items[-SAMPLE_TAIL:] if len(items) > SAMPLE_HEAD else [],
    }


def choose_protocol_file(base_build: int, cache_dir: Path) -> int | None:
    """按「≤ baseBuild 的最大已缓存版本」选协议文件（与官方补丁边界一致）。"""
    available = sorted(
        int(path.stem[len("protocol") :])
        for path in cache_dir.glob("protocol*.py")
    )
    candidates = [v for v in available if v <= base_build]
    if candidates:
        return max(candidates)
    return min(available) if available else None


def read_base_build(header_bytes: bytes, cache_dir: Path) -> int:
    """读 header 拿到 baseBuild。

    这里有个先有鸡还是先有蛋的问题：选协议要 baseBuild，但读 header 本身
    就要协议。官方 `versions.build()` 的处理是「用录像自报的 build 去 import
    对应模块」，对我们这些没内置定义的 build 就直接失败。
    实测 header 的 `m_version` 结构跨补丁很稳定（用 95299 能正确读出 4.2.1
    录像的 baseBuild），所以这里从最新往旧逐个试，第一个读出合法
    `m_baseBuild` 的就采用。
    """
    candidates = sorted(
        (int(path.stem[len("protocol") :]) for path in cache_dir.glob("protocol*.py")),
        reverse=True,
    )
    last_error: Exception | None = None
    for build in candidates:
        protocol = load_protocol(build, cache_dir)
        if protocol is None:
            continue
        try:
            header = normalize(protocol.decode_replay_header(header_bytes))
            base_build = header["m_version"]["m_baseBuild"]
            if isinstance(base_build, int) and base_build > 0:
                return base_build
        except Exception as exc:  # noqa: BLE001 - 试错探测，失败就换下一个
            last_error = exc
    raise SystemExit(f"所有已缓存的协议都读不出 baseBuild（最后一个错误：{last_error}）")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=Path, default=SAMPLE_DIR)
    parser.add_argument("--out", type=Path, default=OUT_FILE)
    parser.add_argument("--cache", type=Path, default=CACHE_DIR)
    args = parser.parse_args()

    sys.path.insert(0, str(args.cache))
    ensure_deps(args.cache)
    import mpyq  # 延迟导入：确保 sys.path 已就绪

    replays = sorted(args.samples.glob("*.SC2Replay"))
    if not replays:
        raise SystemExit(f"{args.samples} 下没有 .SC2Replay 文件")

    baseline: dict[str, object] = {}
    for replay_path in replays:
        archive = mpyq.MPQArchive(str(replay_path))
        header_bytes = archive.header["user_data_header"]["content"]

        # 先要拿到 baseBuild 才知道用哪份协议 —— 而 header 本身也要协议才能解。
        header_bytes = archive.header["user_data_header"]["content"]
        base_build = read_base_build(header_bytes, args.cache)

        chosen = choose_protocol_file(base_build, args.cache)
        if chosen is None:
            print(f"  跳过 {replay_path.name}：缓存里没有可用协议")
            continue
        protocol = load_protocol(chosen, args.cache)
        print(f"  {replay_path.name}  baseBuild={base_build}  protocol={chosen}")

        entry: dict[str, object] = {
            "file": replay_path.name,
            "baseBuild": base_build,
            "protocolBuild": chosen,
            "header": normalize(protocol.decode_replay_header(header_bytes)),
        }
        entry["details"] = normalize(protocol.decode_replay_details(archive.read_file("replay.details")))
        entry["initdata"] = normalize(protocol.decode_replay_initdata(archive.read_file("replay.initData")))
        for key, stream_name, decoder in (
            ("tracker", "replay.tracker.events", protocol.decode_replay_tracker_events),
            ("game", "replay.game.events", protocol.decode_replay_game_events),
            ("message", "replay.message.events", protocol.decode_replay_message_events),
        ):
            raw = archive.read_file(stream_name)
            items = [normalize(event) for event in decoder(raw)] if raw else []
            entry[key] = summarize_stream(items)
        attributes = archive.read_file("replay.attributes.events")
        entry["attributes"] = normalize(protocol.decode_replay_attributes_events(attributes)) if attributes else None

        baseline[replay_path.name] = entry

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(baseline, ensure_ascii=False, sort_keys=True, indent=1),
        encoding="utf-8",
    )
    size = args.out.stat().st_size
    print(f"\n写入 {args.out.relative_to(REPO_ROOT)}  {size:,} B")
    for name, entry in baseline.items():
        assert isinstance(entry, dict)
        print(
            f"  {name[:40]:42} tracker={entry['tracker']['count']:5} "
            f"game={entry['game']['count']:6} message={entry['message']['count']:3}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
