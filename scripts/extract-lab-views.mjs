// 把原型模板里的 <script> 主体**逐字节提取**成生产模块 js/lab/views.js。
//
// 为什么提取而不是手抄：那段代码已经过 3 轮真实 Chromium 渲染验收（含游标联动、
// 建造顺序滚动、语音状态机、悬浮探测降级）。手抄 900 行必然引入察觉不到的偏差，
// 而提取是逐字节等价的 —— 只做 5 处**有断言保护**的定点替换：
//
//   1. `const DATA = /*__DATA__*/null;`  → `let DATA = { replays: [] };`（改为运行期喂数据）
//   2. `renderAll()` 开头加空数据守卫（原型永不为空，生产页面会先空后满）
//   3. 去掉底部的自动启动 `renderAll(); ovProbe();`
//   4. 追加对外接口 `mountLab() / focusReplay() / labState / voiceState / redraw()`
//   5. 追加 `sandboxSeek()` —— 沙盘视图（js/lab/sandbox.js，非提取产物）推进全局游标的唯一入口
//
//   node scripts/extract-lab-views.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const SRC = join(REPO, "prototype/data-lab.template.html");
const DEST = join(REPO, "js/lab/views.js");

const html = readFileSync(SRC, "utf8");

// 取最后一个 <script> 块（页面里只有一个内联脚本，但这写法更稳）
const open = html.lastIndexOf("<script>");
const close = html.lastIndexOf("</script>");
if (open < 0 || close < 0 || close < open) throw new Error("在模板里找不到内联 <script> 块");
let body = html.slice(open + "<script>".length, close).trim();

/** 断言式替换：找不到就报错，而不是静默改坏了。 */
function patch(label, from, to) {
  const n = body.split(from).length - 1;
  if (n !== 1) throw new Error(`替换「${label}」命中 ${n} 次，期望恰好 1 次 —— 模板结构变了，请更新本脚本`);
  body = body.replace(from, to);
  console.log(`  ✓ ${label}`);
}

console.log("定点替换：");

patch(
  "DATA 改为运行期注入",
  "const DATA = /*__DATA__*/null;",
  "let DATA = { generated: '', replays: [] };",
);

patch(
  "renderAll 加空数据守卫",
  "function renderAll(){\n  renderSamples();",
  "function renderAll(){\n  if (!DATA.replays.length) return; // 生产页面会先空后满，原型不会\n  renderSamples();",
);

patch(
  "去掉自动启动",
  "renderAll();\novProbe();",
  "",
);

patch(
  "启动小节的注释名与现状对齐",
  "/* ---------- 启动 ---------- */",
  "/* ---------- 渲染总入口 ---------- */",
);

patch(
  "追加对外接口",
  // ⚠️ 锚点必须唯一：`  syncCursor();\n  renderVoiceUi();\n}` 在 renderAll 与 vTick 里各出现一次，
  // 所以把 renderAll 的上一行（S.t 收口）一起纳入锚点。第一版就是在这里被断言挡下的。
  "  S.t = clamp(S.t, 0, rep().duration);\n  syncCursor();\n  renderVoiceUi();\n}",
  `  S.t = clamp(S.t, 0, rep().duration);
  syncCursor();
  renderVoiceUi();
}

/* ==========================================================================
   对外接口 —— 生产页面通过这里驱动（取代原型的构建期 JSON 注入）
   ========================================================================== */

/**
 * 喂入解析结果并重绘全部视图。
 * @param {object[]} replays 每项形如原型里的 \`DATA.replays[i]\`：
 *   \`{ file, map, duration, build, region, playedAt, winner, players[], chat[] }\`，
 *   每个 player 需要 \`{ name, clan, race, raceFull, t[], series{}, buildOrder[], workerDeaths[] }\`；
 *   \`chat[]\` 每项 \`{ t, player, ally, text }\`（对局聊天视图用，可为空数组）。
 *   形状由 \`js/lab/data.js\` 的 \`toLabReplays()\` 保证，两边是一份契约。
 */
export function mountLab(replays){
  DATA = { generated: new Date().toISOString().slice(0, 10), replays };
  S.ri = Math.max(0, Math.min(S.ri, replays.length - 1));
  S.t = 0;
  V.who = 0;
  renderAll();
  ovProbe();          // 探测本地悬浮组件（真实网络请求，失败会降级，不抛）
  return { count: replays.length };
}

/** 切到第 i 份录像（0 起）。越界忽略。 */
export function focusReplay(i){
  if (!Number.isInteger(i) || i < 0 || i >= DATA.replays.length) return false;
  S.ri = i; S.t = 0; V.who = 0;
  renderAll();
  return true;
}

/** 只读的页面状态，用于外部断言与调试（不要直接写它）。 */
export const labState = S;
/** 只读的播报状态。 */
export const voiceState = V;
/** 强制重绘（改过 labState 后调用）。 */
export function redraw(){ renderAll(); }

/**
 * 沙盘视图驱动的全局游标入口（唯一被 \`js/lab/sandbox.js\` 调用的写入口）。
 * \`scheduleSync()\` 自带 rAF 节流，沙盘按 60fps 推进也不会造成重绘风暴。
 */
export function sandboxSeek(t){
  S.t = clamp(t, 0, rep().duration);
  scheduleSync();
}`,
);

const header = `/* ============================================================================
   录像数据分析台 · 视图层
   ⚠️ 本文件由 scripts/extract-lab-views.mjs 从 prototype/data-lab.template.html
      的内联 <script> **逐字节提取**，只做了 5 处有断言保护的定点替换（见该脚本头部）。
      它是一份自洽的模块：不 import 任何东西，所有渲染/交互/语音/悬浮探测都在这一层。

   为什么是一个文件：这段代码已经过 3 轮真实 Chromium 渲染验收，提取能保证零偏差。
   **后续重构方向**（尚未做）：按 section 注释拆成 core / metrics / charts / timeline /
   readouts / table / buildorder / voice / overlay 若干模块。拆分时请保留本文件的验收脚本，
   拆完必须重跑一遍 \`node prototype/shot-datalab.mjs\` 与生产页验收。

   状态与数据：
     \`DATA.replays\` 由 \`mountLab()\` 在运行期注入（原型里是构建期 JSON 注入）；
     \`S\` 是视图状态（游标 S.t、模式、视图、筛选），\`V\` 是语音播报状态。
   ============================================================================ */

`;

writeFileSync(DEST, header + body + "\n");
const out = header + body;

/* ---------- 自检：提取完必须过这几条，否则生产页面会在运行期以奇怪的方式坏掉 ---------- */
const checks = [
  ["自洽模块（无 import）", !/^\s*import\s/m.test(out)],
  ["DATA 改为运行期注入", out.includes("let DATA = { generated:")],
  ["空数据守卫存在", out.includes("if (!DATA.replays.length) return;")],
  // 注意：`^\s*renderAll\(\);` 会误命中 mountLab / focusReplay 里的缩进调用，
  // 这里要的是**顶格**的自动启动，所以不加 `\s*`。
  ["顶层自动启动已移除", !/^renderAll\(\);\s*$/m.test(out)],
  ["顶层 ovProbe 自动调用已移除", !/^ovProbe\(\);\s*$/m.test(out)],
  ["mountLab 已导出", out.includes("export function mountLab(")],
  ["focusReplay 已导出", out.includes("export function focusReplay(")],
  ["无残留构建期占位符", !out.includes("__DATA__")],
];
let bad = 0;
for (const [name, ok] of checks) {
  if (!ok) bad++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
}

const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
console.log(`\n提取脚本主体 ${kb(body.length)} → ${DEST}（总计 ${kb(out.length)}）`);
console.log(`export 数 ${(out.match(/^export /gm) ?? []).length} · 行数 ${out.split("\n").length}`);
if (bad) throw new Error(`${bad} 条自检未通过，产物不可用`);
console.log("✅ 自检全过");
