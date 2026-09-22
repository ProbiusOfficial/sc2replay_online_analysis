"""生成 MPQ 读取基准 fixtures —— 固化进仓库，让 CI 不依赖 Python/mpyq 就能校验 TS 实现。

输出：tests/fixtures/mpq-baseline.json
     只存「期望值」（尺寸 / md5 / 结构参数），不存录像内容本身。

生成方式（一次性）：
    python3 scripts/make-mpq-fixtures.py
依赖 mpyq（参考实现），仅用于生成基准，不参与 CI。
"""
import hashlib
import json
import os
import sys

sys.path.insert(0, "/tmp/s2p")
import mpyq  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLE_DIR = os.path.join(REPO, "sampleTest")
OUT = os.path.join(REPO, "tests", "fixtures", "mpq-baseline.json")

COMPRESSION_NAMES = {
    0: "none",
    2: "zlib",
    8: "implode",
    16: "bzip2",
    18: "zlib+bzip2",
    24: "zlib+implode",
}


def md5(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


out = {}
for fname in sorted(os.listdir(SAMPLE_DIR)):
    if not fname.endswith(".SC2Replay"):
        continue
    path = os.path.join(SAMPLE_DIR, fname)
    with open(path, "rb") as fh:
        raw = fh.read()

    archive = mpyq.MPQArchive(path)
    h = archive.header
    udh = h.get("user_data_header")

    files = {}
    for raw_name in archive.files:
        name = raw_name.decode("utf-8", "replace")
        he = archive.get_hash_table_entry(raw_name)
        if he is None:
            continue
        be = archive.block_table[he.block_table_index]
        data = archive.read_file(raw_name)
        is_compressed = bool(be.flags & mpyq.MPQ_FILE_COMPRESS) and be.size > be.archived_size
        # 压缩类型标记是压缩块的首字节；未压缩时该位置是数据本身，不算类型
        ctype = "none"
        if is_compressed:
            archive.file.seek(be.offset + h["offset"])
            ctype = COMPRESSION_NAMES.get(archive.file.read(1)[0], "unknown")
        files[name] = {
            "blockIndex": he.block_table_index,
            "offset": be.offset,
            "archivedSize": be.archived_size,
            "size": be.size,
            "flags": be.flags,
            "compression": ctype,
            "md5Unpacked": md5(data) if data is not None else None,
        }

    out[fname] = {
        "rawSize": len(raw),
        "rawMd5": md5(raw),
        "header": {
            "magic": h["magic"].hex(),
            "headerSize": h["header_size"],
            "archiveSize": h["archive_size"],
            "formatVersion": h["format_version"],
            "sectorSizeShift": h["sector_size_shift"],
            "hashTableOffset": h["hash_table_offset"],
            "blockTableOffset": h["block_table_offset"],
            "hashTableEntries": h["hash_table_entries"],
            "blockTableEntries": h["block_table_entries"],
            "offset": h["offset"],
        },
        "userDataHeader": None
        if not udh
        else {
            "magic": udh["magic"].hex(),
            "userDataSize": udh["user_data_size"],
            "mpqHeaderOffset": udh["mpq_header_offset"],
            "userDataHeaderSize": udh["user_data_header_size"],
            "contentMd5": md5(udh["content"]),
            "contentLength": len(udh["content"]),
        },
        "hashTableEntryCount": len(archive.hash_table),
        "blockTableEntryCount": len(archive.block_table),
        "listfile": [f.decode("utf-8", "replace") for f in archive.files],
        "files": files,
    }

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as fh:
    json.dump(out, fh, indent=1, ensure_ascii=False)
    fh.write("\n")

total_files = sum(len(v["files"]) for v in out.values())
print(f"已写入 {OUT}")
print(f"  {len(out)} 个录像，共 {total_files} 个文件条目")
print(f"  体积 {os.path.getsize(OUT)} 字节")
