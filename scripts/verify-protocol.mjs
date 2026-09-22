#!/usr/bin/env node
/**
 * 协议解码的验收脚本：TS 实现 vs Blizzard 官方 Python 实现。
 *
 * 比对对象：`tests/fixtures/protocol-baseline.json`（由 `scripts/make-protocol-fixtures.py`
 * 用**官方 s2protocol** 解码并固化）。基准是纯数据，CI 里不需要 Python。
 *
 * ## 比对策略
 *
 * | 流                            | 比对方式                                    |
 * | ----------------------------- | ------------------------------------------- |
 * | header / details / initData   | 完整深度比较（单条大对象，全量存得下）      |
 * | tracker / game / message      | 条数 + **全量 sha256 摘要** + 首尾采样       |
 * | attributes                    | 完整深度比较                                |
 *
 * 为什么事件流不逐条存：game events 单场可达 3 万条，全量基准会有几十 MB。
 * 摘要能证明「逐字节一致」，首尾采样则在摘要不符时给出可看的线索。
 * 需要逐条定位时用 `--dump` 把 TS 侧结果导出来手工 diff。
 *
 * 规范化规则必须与 Python 侧一致（见 `make-protocol-fixtures.py`）：
 * `Uint8Array → "hex:..."`、超 2^53 的整数 → 十进制字符串。
 *
 * 用法：
 *   node scripts/verify-protocol.mjs           # 跑验收
 *   node scripts/verify-protocol.mjs --dump    # 额外把 TS 解码结果写到 /tmp
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SAMPLE_DIR = join(REPO, "sampleTest");
const FIXTURE = join(REPO, "tests", "fixtures", "protocol-baseline.json");
const WASM = join(REPO, "wasm", "pkg", "compute_bg.wasm");
const DUMP = process.argv.includes("--dump");

for (const [label, path] of [
  ["协议基准", FIXTURE],
  ["wasm 产物", WASM],
]) {
  if (!existsSync(path)) {
    console.error(`✗ 找不到${label}：${path}`);
    if (label === "协议基准") {
      console.error("  先跑：python3 scripts/make-protocol-fixtures.py");
    } else {
      console.error("  先跑：cd wasm && wasm-pack build --target web --release && rm -f pkg/.gitignore");
    }
    process.exit(1);
  }
}

// Node 的 fetch 不支持 file://，所以先 initSync 注入字节，再告诉适配层跳过 fetch。
const { initSync } = await import(join(REPO, "wasm/pkg/compute.js"));
initSync({ module: readFileSync(WASM) });

const { markComputeWasmReady, createWasmDecompressor } = await import(
  join(REPO, "js/worker/decoder/decompressors.js")
);
markComputeWasmReady();

const { openMpqArchive } = await import(join(REPO, "js/worker/decoder/mpq.js"));
const { selectProtocolTables, probeBaseBuild } = await import(
  join(REPO, "js/worker/decoder/protocols/index.js")
);
const {
  decodeReplayHeader,
  decodeReplayDetails,
  decodeReplayInitData,
  decodeReplayTrackerEvents,
  decodeReplayGameEvents,
  decodeReplayMessageEvents,
  decodeReplayAttributesEvents,
} = await import(join(REPO, "js/worker/decoder/events.js"));

// --- 规范化：规则必须与 make-protocol-fixtures.py 的 normalize() 一致 --------

const SAFE_INT = 2n ** 53n;

function normalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") {
    const abs = value < 0n ? -value : value;
    return abs > SAFE_INT ? value.toString() : Number(value);
  }
  if (value instanceof Uint8Array) return `hex:${Buffer.from(value).toString("hex")}`;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) out[key] = normalize(value[key]);
    return out;
  }
  throw new Error(`无法规范化的类型 ${typeof value}: ${String(value)}`);
}

/** 递归排序对象的键，便于跨语言比较（Python 的 sort_keys）。 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

const stable = (value) => JSON.stringify(canonical(value));

function digest(items) {
  const hasher = createHash("sha256");
  for (const item of items) {
    hasher.update(stable(item));
    hasher.update("\n");
  }
  return hasher.digest("hex");
}

// --- 比较框架 ---------------------------------------------------------------

let checks = 0;
const failures = [];

function eq(label, actual, expected) {
  checks += 1;
  const a = stable(actual);
  const b = stable(expected);
  if (a !== b) {
    failures.push(`${label}\n      TS   = ${truncate(a)}\n      期望 = ${truncate(b)}`);
  }
}

function truncate(text, limit = 400) {
  return text.length > limit ? `${text.slice(0, limit)}…（共 ${text.length} 字符）` : text;
}

const SAMPLE_HEAD = 8;
const SAMPLE_TAIL = 2;

function compareStream(label, items, expected) {
  eq(`${label} 事件条数`, items.length, expected.count);
  eq(`${label} 全量摘要`, digest(items), expected.digest);
  eq(
    `${label} _gameloop 序列摘要`,
    digest(items.map((item) => item._gameloop)),
    expected.gameloopDigest,
  );
  eq(`${label} 首 ${SAMPLE_HEAD} 条`, items.slice(0, SAMPLE_HEAD), expected.head);
  if (items.length > SAMPLE_HEAD) {
    eq(`${label} 末 ${SAMPLE_TAIL} 条`, items.slice(-SAMPLE_TAIL), expected.tail);
  }
}

// --- 主流程 -----------------------------------------------------------------

const baseline = JSON.parse(readFileSync(FIXTURE, "utf8"));
const samples = readdirSync(SAMPLE_DIR)
  .filter((f) => f.endsWith(".SC2Replay"))
  .sort();
eq("样本集合", samples, Object.keys(baseline).sort());

const decompressor = createWasmDecompressor();

for (const name of Object.keys(baseline)) {
  const expected = baseline[name];
  const label = name.length > 38 ? `${name.slice(0, 35)}…` : name;
  const archive = await openMpqArchive(
    new Uint8Array(readFileSync(join(SAMPLE_DIR, name))),
    { decompressor },
  );

  // 完整走一遍真实流程：不知道 baseBuild → 探测 → 选协议 → 解码。
  const headerBytes = archive.readHeaderContent();
  const probed = probeBaseBuild(headerBytes);
  eq(`[${label}] 探测出的 baseBuild`, probed.baseBuild, expected.baseBuild);

  const selection = selectProtocolTables(probed.baseBuild);
  eq(`[${label}] 选中的协议版本`, selection.protocolBuild, expected.protocolBuild);
  eq(`[${label}] 是否降级`, selection.degraded, false);

  const header = normalize(decodeReplayHeader(selection, headerBytes));
  eq(`[${label}] header`, header, expected.header);

  eq(
    `[${label}] details`,
    normalize(decodeReplayDetails(selection, await archive.readFile("replay.details"))),
    expected.details,
  );
  eq(
    `[${label}] initData`,
    normalize(decodeReplayInitData(selection, await archive.readFile("replay.initData"))),
    expected.initdata,
  );

  const streams = [
    ["tracker", "replay.tracker.events", decodeReplayTrackerEvents],
    ["game", "replay.game.events", decodeReplayGameEvents],
    ["message", "replay.message.events", decodeReplayMessageEvents],
  ];
  const dumped = { baseBuild: expected.baseBuild, protocolBuild: selection.protocolBuild };
  for (const [key, file, decode] of streams) {
    const raw = await archive.readFile(file);
    const items = raw ? normalize(decode(selection, raw)) : [];
    compareStream(`[${label}] ${key}`, items, expected[key]);
    dumped[key] = items;
  }

  const attrRaw = await archive.readFile("replay.attributes.events");
  const attributes = attrRaw ? normalize(decodeReplayAttributesEvents(attrRaw)) : null;
  eq(`[${label}] attributes`, attributes, expected.attributes);

  if (DUMP) {
    dumped.header = header;
    const path = join("/tmp", `ts-protocol-${name.replace(/[^\w.-]/g, "_")}.json`);
    writeFileSync(path, JSON.stringify(dumped, null, 1));
    console.log(`  已导出 ${path}`);
  }

  console.log(
    `  ${label.padEnd(40)} baseBuild=${String(expected.baseBuild).padEnd(6)} ` +
      `protocol=${selection.protocolBuild}  tracker=${expected.tracker.count} ` +
      `game=${expected.game.count} message=${expected.message.count}`,
  );
}

if (failures.length === 0) {
  console.log(`\n✓ 协议解码验收通过：${checks} 项断言全部一致`);
  process.exit(0);
}

console.error(`\n✗ ${failures.length}/${checks} 项断言失败：\n`);
for (const failure of failures.slice(0, 12)) console.error(`  ✗ ${failure}\n`);
if (failures.length > 12) console.error(`  …另有 ${failures.length - 12} 项\n`);
process.exit(1);
