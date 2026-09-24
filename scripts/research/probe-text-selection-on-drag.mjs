// 复现 / 验收：「在图表上拖动会把文字选中」。
//
//   python3 -m http.server 8123        # 先起服务（本脚本不负责起服务）
//   node scripts/research/probe-text-selection-on-drag.mjs
//
// 判据（两种场景各测一次，避免判据自身撒谎）：
//   A 反例：在段落 <p> 上拖 —— 选择必须**非空**（证明测量手法本身能测到选区）
//   B 正例：在图表 .plot / 时间轴 #tl 上拖 —— 选择必须**为空**
import { chromium } from "/Users/macmini/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const BASE = process.env.LAB_URL || "http://127.0.0.1:8123/index.html";
const SAMPLES = readdirSync(join(REPO, "sampleTest"))
  .filter((n) => n.endsWith(".SC2Replay"))
  .sort()
  .map((n) => join(REPO, "sampleTest", n));

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1 });

await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("#dropZone", { state: "visible", timeout: 30000 });
await page.setInputFiles("#fileInput", SAMPLES);
await page.waitForSelector("#result.on", { timeout: 120000 });
await page.waitForTimeout(800);

const clearSel = () => page.evaluate(() => window.getSelection().removeAllRanges());

// 用真实鼠标事件拖：hover → down → 多步 move → up（与人工操作同构）
async function drag(from, to, steps = 12) {
  await clearSel();
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
    );
  }
  const sel = await page.evaluate(() => {
    const s = window.getSelection();
    return { text: s.toString(), nodes: s.rangeCount };
  });
  await page.mouse.up();
  return sel;
}

const boxOf = (sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, sel);

const report = [];
const fail = [];

/** 读当前游标时刻（views 的状态在模块作用域里，只能走 window.__lab 句柄） */
const readT = () => page.evaluate(() => window.__lab?.state?.t ?? null);

/* ---- A 反例对照：段落上拖必须能选中（否则测量手法本身失效） ---- */
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(200);
const pBox = await page.evaluate(() => {
  // 造一个独立可拖的段落，避免依赖页面里某段文字的布局
  const p = document.createElement("p");
  p.id = "__probe_para";
  p.style.cssText =
    "position:fixed;top:8px;left:8px;z-index:99999;font:14px/20px sans-serif;background:#fff;padding:4px";
  p.textContent = "SELECTION PROBE 0123456789 abcdefghij SELECTION PROBE";
  document.body.appendChild(p);
  const r = p.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const ctrl = await drag(
  { x: pBox.x + 6, y: pBox.y + 10 },
  { x: pBox.x + Math.min(pBox.w - 6, 300), y: pBox.y + 10 },
);
report.push(`A 对照（段落拖选）→ 选中 ${ctrl.text.length} 字：${JSON.stringify(ctrl.text.slice(0, 40))}`);
if (!ctrl.text) fail.push("A 对照失效：段落上拖都没选中任何字 —— 测量手法本身不成立，B 组的「空选区」不可信");
await page.evaluate(() => document.getElementById("__probe_para")?.remove());

/* ---- B 正例：图表卡片 ---- */
const chart = await page.evaluate(() => {
  const card = document.querySelector("#charts .card");
  if (!card) return null;
  card.scrollIntoView({ block: "center" });
  return true;
});
await page.waitForTimeout(300);
const plotBox = await boxOf("#charts .card .plot");
if (!chart || !plotBox) {
  fail.push("找不到 #charts .card .plot —— 无法测试图表拖动");
} else {
  const r = await drag(
    { x: plotBox.x + plotBox.w * 0.25, y: plotBox.y + plotBox.h * 0.5 },
    { x: plotBox.x + plotBox.w * 0.75, y: plotBox.y + plotBox.h * 0.5 },
  );
  report.push(`B1 图表 .plot 拖动 → 选中 ${r.text.length} 字：${JSON.stringify(r.text.slice(0, 40))}`);
  if (r.text) fail.push(`图表拖动选中了文字（${r.text.length} 字）：${JSON.stringify(r.text.slice(0, 60))}`);

  // B1b 拖出图表外（越过卡片标题等可选文字）—— 单靠 CSS 挡不住这一段，靠 pointerdown 的 preventDefault
  const cardBox = await page.evaluate(() => {
    const c = document.querySelector("#charts .card");
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const out = await drag(
    { x: plotBox.x + plotBox.w * 0.5, y: plotBox.y + plotBox.h * 0.5 },
    { x: cardBox.x + 10, y: cardBox.y - 12 },
  );
  report.push(`B1b 图表内按下、拖到卡片外 → 选中 ${out.text.length} 字：${JSON.stringify(out.text.slice(0, 40))}`);
  if (out.text) fail.push(`拖出图表选中了文字（${out.text.length} 字）：${JSON.stringify(out.text.slice(0, 60))}`);

  // B1c 非回归：拖动必须照旧推动全局游标（别为了防选中把交互弄坏了）
  const t0 = await readT();
  await drag(
    { x: plotBox.x + plotBox.w * 0.2, y: plotBox.y + plotBox.h * 0.5 },
    { x: plotBox.x + plotBox.w * 0.8, y: plotBox.y + plotBox.h * 0.5 },
  );
  const t1 = await readT();
  report.push(`B1c 非回归：拖动前后 S.t = ${t0} → ${t1}`);
  if (!(t1 > t0)) fail.push(`图表拖动没推动游标（S.t ${t0} → ${t1}）—— 防选中把 scrubbing 弄坏了`);
}

/* ---- B2 正例：时间轴 ---- */
const tlBox = await page.evaluate(() => {
  const tl = document.querySelector("#tl");
  if (!tl) return null;
  tl.scrollIntoView({ block: "center" });
  const r = tl.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
await page.waitForTimeout(300);
if (!tlBox) {
  fail.push("找不到 #tl —— 无法测试时间轴拖动");
} else {
  const r = await drag(
    { x: tlBox.x + tlBox.w * 0.2, y: tlBox.y + tlBox.h * 0.5 },
    { x: tlBox.x + tlBox.w * 0.8, y: tlBox.y + tlBox.h * 0.5 },
  );
  report.push(`B2 时间轴 #tl 拖动 → 选中 ${r.text.length} 字：${JSON.stringify(r.text.slice(0, 40))}`);
  if (r.text) fail.push(`时间轴拖动选中了文字（${r.text.length} 字）：${JSON.stringify(r.text.slice(0, 60))}`);
}

/* ---- B3 正例：建造顺序视图的甘特轴（若存在可拖区域） ---- */
const boPlot = await boxOf("#boView .plot");
if (boPlot) {
  await page.evaluate(() => document.querySelector("#boView .plot")?.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(250);
  const r = await drag(
    { x: boPlot.x + boPlot.w * 0.25, y: boPlot.y + boPlot.h * 0.5 },
    { x: boPlot.x + boPlot.w * 0.75, y: boPlot.y + boPlot.h * 0.5 },
  );
  report.push(`B3 建造顺序 .plot 拖动 → 选中 ${r.text.length} 字`);
  if (r.text) fail.push(`建造顺序拖动选中了文字（${r.text.length} 字）：${JSON.stringify(r.text.slice(0, 60))}`);
}

/* ---- 沙盒视图 ---- */
const sbBox = await boxOf("#sbCanvas");
if (sbBox) {
  await page.evaluate(() => document.querySelector("#sbCanvas")?.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(250);
  const r = await drag(
    { x: sbBox.x + sbBox.w * 0.3, y: sbBox.y + sbBox.h * 0.4 },
    { x: sbBox.x + sbBox.w * 0.6, y: sbBox.y + sbBox.h * 0.6 },
  );
  report.push(`B4 沙盒画布拖动 → 选中 ${r.text.length} 字`);
  if (r.text) fail.push(`沙盒画布拖动选中了文字（${r.text.length} 字）：${JSON.stringify(r.text.slice(0, 60))}`);
}

console.log("\n===== 探针结果 =====");
for (const l of report) console.log("  " + l);
console.log("\n===== 判定 =====");
if (fail.length) {
  for (const l of fail) console.log("  ✗ " + l);
  console.log(`\n结果：${fail.length} 项不通过`);
} else {
  console.log("  ✓ 全部通过：拖动不再选中文字，且对照组证明判据有效");
}
await browser.close();
process.exit(fail.length ? 1 : 0);
