// 解析 Worker 端到端验收：在 Node 里**直接驱动真正的 `js/worker/parse.worker.js`**，
// 走完整链路「消息进 → MPQ → 六流解码 → ReplayData → 消息出」。
//
// 为什么需要它（它补的是 `verify-replay-data.mjs` 的空缺）：
// 那个脚本 import 的是 `decoder/replay_data.js`，证明的是**解码器**对；
// 但没有证明**接线**对 —— 主线程发来的消息能不能被 Worker 认下、错误码是否为契约里那几个、
// `parse.worker.js` 的 `../../wasm/pkg/compute.js` 相对路径在浏览器里能不能解析。
// 这些是「P1c 组装完成」和「页面真的不再用 Pyodide」之间最后一段没人验的路。
//
// ## 怎么在 Node 里跑 Web Worker
//
// `parse.worker.js` 只依赖 `globalThis.postMessage` / `globalThis.addEventListener`
// 两件事。Node 没有 Web Worker，但可以在 **import 之前**把这两个挂到 `globalThis` 上，
// 然后手动把消息喂给注册进来的 handler —— 被测的还是同一份产物文件，没有另写替身。
//
// wasm 侧走 Node 路径：先 `initSync({module})`，再 `markComputeWasmReady()` 让它跳过 fetch。
//
// 用法：
//   node scripts/verify-worker.mjs              # 全部样本
//   node scripts/verify-worker.mjs CN_ZVP       # 按子串过滤样本名
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SAMPLE_DIR = join(REPO, "sampleTest");
const WORKER_DIR = join(REPO, "js", "worker");

const filters = process.argv.slice(2).filter((a) => !a.startsWith("--"));

const problems = [];
const notes = [];
function check(ok, message) {
  if (!ok) problems.push(message);
  return ok;
}

// ---- 装 Worker 全局作用域 -------------------------------------------------

const listeners = [];
const inbox = [];
let waiter = null;

globalThis.addEventListener = (type, listener) => {
  if (type === "message") listeners.push(listener);
};
globalThis.postMessage = (message) => {
  if (waiter) {
    const resolve = waiter;
    waiter = null;
    resolve(message);
    return;
  }
  inbox.push(message);
};

function nextMessage() {
  if (inbox.length > 0) return Promise.resolve(inbox.shift());
  return new Promise((resolve) => {
    waiter = resolve;
  });
}

/** 把一条请求喂给 Worker 的 message 监听器，等它回消息。 */
async function send(request) {
  const handler = listeners[0];
  const handled = handler({ data: request });
  const response = await nextMessage();
  await handled;
  return response;
}

// ---- 装配被测实现（顺序要紧：wasm 必须先就绪） -----------------------------

const { initSync } = await import(join(REPO, "wasm/pkg/compute.js"));
initSync({ module: readFileSync(join(REPO, "wasm/pkg/compute_bg.wasm")) });
const { markComputeWasmReady } = await import(join(WORKER_DIR, "decoder/decompressors.js"));
markComputeWasmReady();

// 这一步就是「Worker 启动」。产物被删/路径写错都会在这里炸。
await import(join(WORKER_DIR, "parse.worker.js"));
check(listeners.length === 1, `parse.worker.js 应注册恰好 1 个 message 监听器，实得 ${listeners.length}`);

// ---- 静态检查：主线程侧 Worker URL 能否落到真实文件 -------------------------

/**
 * `js/worker/index.ts` 用 `new URL("./parse.worker.js", import.meta.url)` 拉起 Worker。
 * Node 里跑不了真的 Worker 构造，但**这个相对路径能不能落到文件**是可以验的 ——
 * 而它恰好是「wasm 产物缺失 / MIME 不对」之外最容易漏的一类问题。
 */
function checkWorkerUrlResolves() {
  const source = readFileSync(join(WORKER_DIR, "index.ts"), "utf8");
  const match = source.match(/new URL\(\s*"([^"]+)"\s*,\s*import\.meta\.url\s*\)/);
  if (!check(match, "index.ts 里找不到 new URL(..., import.meta.url) 形式的 Worker URL")) return;
  const relative = match[1];
  // 编译后 index.ts 与 index.js 同目录，所以相对 `import.meta.url` 的结果一致。
  const resolved = join(WORKER_DIR, relative);
  check(existsSync(resolved), `Worker URL "${relative}" 解析到 ${resolved}，该文件不存在`);
  notes.push(`Worker URL ${relative} → js/worker/${relative} ✓`);
}

/**
 * `parse.worker.js` 里 wasm 的相对路径也必须落对 —— 它多退两级到仓库根，
 * 少退一级就会去 `js/wasm/pkg/` 找一个不存在的产物。
 */
function checkWasmUrlResolves() {
  const source = readFileSync(join(WORKER_DIR, "parse.worker.js"), "utf8");
  const imports = [...source.matchAll(/from\s+"([^"]*wasm\/pkg\/compute\.js)"/g)];
  if (!check(imports.length > 0, "parse.worker.js 里找不到对 wasm/pkg/compute.js 的 import")) return;
  for (const [, spec] of imports) {
    const resolved = join(WORKER_DIR, spec);
    check(existsSync(resolved), `parse.worker.js import "${spec}" 解析到 ${resolved}，该文件不存在`);
  }
  notes.push(`wasm import ${imports[0][1]} ✓`);
}

checkWorkerUrlResolves();
checkWasmUrlResolves();

// ---- 冒烟：ping -----------------------------------------------------------

{
  const pong = await send({ type: "ping", id: "smoke-1" });
  check(pong?.type === "pong", `ping 应回 pong，实得 ${JSON.stringify(pong)}`);
  check(pong?.id === "smoke-1", `pong 应回带同一个 id，实得 ${JSON.stringify(pong?.id)}`);
  check(typeof pong?.message === "string" && pong.message.length > 0, "pong.message 应为非空字符串");
  notes.push(`ping → pong(${JSON.stringify(pong?.message)})`);
}

// ---- 契约诚实性：坏请求 / 未实现能力必须明确失败，不许假装成功 ---------------

{
  const bad = await send({ type: "parse", id: "bad-1", md5: "x", buffer: "not-an-arraybuffer" });
  check(bad?.type === "error", `buffer 类型不对应回 error，实得 ${JSON.stringify(bad?.type)}`);
  check(bad?.code === "BAD_REQUEST", `应回 BAD_REQUEST，实得 ${JSON.stringify(bad?.code)}`);
  notes.push(`坏 buffer → error(${bad?.code})`);
}
{
  const skip = await send({ type: "skipCache", id: "skip-1", md5: "x" });
  check(skip?.type === "error", `skipCache 应回 error，实得 ${JSON.stringify(skip?.type)}`);
  check(
    skip?.code === "NOT_IMPLEMENTED",
    `skipCache 应回 NOT_IMPLEMENTED（缓存未落地），实得 ${JSON.stringify(skip?.code)}`,
  );
  notes.push(`skipCache → error(${skip?.code})`);
}

// ---- 真解析：5 个样本逐个过 Worker 通道 ------------------------------------

const replays = readdirSync(SAMPLE_DIR)
  .filter((f) => f.toLowerCase().endsWith(".sc2replay"))
  .filter((f) => filters.length === 0 || filters.some((k) => f.includes(k)))
  .sort();

check(replays.length > 0, `sampleTest 下没有匹配的录像（filters=${JSON.stringify(filters)}）`);

const rows = [];
for (const name of replays) {
  const raw = readFileSync(join(SAMPLE_DIR, name));
  // Buffer 可能落在共享的底层 ArrayBuffer 上，必须按 byteOffset 精确切片 ——
  // 否则 `instanceof ArrayBuffer` 过了，但里面掺了别人的字节。
  const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);

  const started = Date.now();
  const response = await send({ type: "parse", id: `p-${name}`, md5: `md5:${name}`, buffer });
  const ms = Date.now() - started;

  const local = [];
  if (!check(response?.type === "ok", `${name}: parse 应回 ok，实得 ${JSON.stringify(response?.type)} ${response?.message ?? ""}`)) {
    local.push(`${name}: ${response?.message ?? "未知错误"}`);
    rows.push({ name, status: "FAIL", detail: `error(${response?.code ?? "?"})` });
    for (const l of local) problems.push(l);
    continue;
  }

  check(response.id === `p-${name}`, `${name}: 响应 id 应为 p-${name}，实得 ${response.id}`);
  check(response.md5 === `md5:${name}`, `${name}: 响应 md5 应原样回带，实得 ${response.md5}`);
  check(response.cached === false, `${name}: cached 应为 false（缓存未落地，不能假报命中）`);

  const data = response.data;
  check(typeof data?.map_name === "string" && data.map_name.length > 0, `${name}: map_name 为空`);
  check(Number.isFinite(data?.game_length), `${name}: game_length 不是数字（${data?.game_length}）`);
  check(Array.isArray(data?.teams) && data.teams.length > 0, `${name}: teams 为空`);
  check(typeof data?.start_time === "number", `${name}: start_time 不是数字（${data?.start_time}）`);

  const players = (data?.teams ?? []).flatMap((t) => t.players ?? []);
  check(players.length > 0, `${name}: 一个玩家都没有`);
  for (const p of players) {
    check(typeof p.name === "string" && p.name.length > 0, `${name}: 玩家 name 为空`);
    check(Array.isArray(p.build_order), `${name}/${p.name}: build_order 不是数组`);
    check(Array.isArray(p.stats), `${name}/${p.name}: stats 不是数组`);
    check(Array.isArray(p.worker_deaths), `${name}/${p.name}: worker_deaths 不是数组`);
    check(Array.isArray(p.workers_curve), `${name}/${p.name}: workers_curve 不是数组`);
  }
  check(Array.isArray(data?.chat), `${name}: chat 不是数组`);

  const entries = players.reduce((n, p) => n + p.build_order.length, 0);
  rows.push({
    name,
    status: "PASS",
    detail: `玩家 ${players.length} / build_order ${entries} 条 / chat ${data.chat.length} 条 / ${ms}ms`,
  });
}

// ---- 汇总 -----------------------------------------------------------------

console.log("─".repeat(84));
console.log("解析 Worker 端到端验收（真跑 js/worker/parse.worker.js）");
console.log("─".repeat(84));
for (const note of notes) console.log(`  ℹ ${note}`);
console.log("");
for (const row of rows) {
  console.log(`  ${row.status === "PASS" ? "✅" : "❌"} ${row.name}`);
  console.log(`      ${row.detail}`);
}
console.log("─".repeat(84));
if (problems.length === 0) {
  console.log(`✅ 全部通过：${rows.length} 个录像走完 Worker 通道，契约与形状断言零失败`);
  process.exit(0);
}
console.log(`❌ ${problems.length} 处问题：`);
for (const p of problems.slice(0, 30)) console.log(`   · ${p}`);
if (problems.length > 30) console.log(`   … 另有 ${problems.length - 30} 处`);
process.exit(1);
