// 悬浮窗视觉规格稿的渲染验收：真实 Chromium，四种版式 + embed 精确尺寸 + 占屏比。
//   node prototype/shot-overlay.mjs
import { chromium } from "/Users/macmini/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, "shots-overlay");
mkdirSync(SHOTS, { recursive: true });
const URL_BASE = "file://" + join(HERE, "overlay-exe.html");
const EXE = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const browser = await chromium.launch({ executablePath: EXE });
const errors = [];
const watch = p => {
  p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
  p.on("pageerror", e => errors.push("pageerror: " + e.message));
};

const clipCard = async (name) => {
  // ⚠️ 不能用 locator.screenshot()：播放时卡片每 90ms 重绘，Playwright 会一直等
  // 「元素稳定」直到超时。改用 bbox 裁剪整页截图，不做稳定性等待。
  const bb = await page.locator("#ovCard").boundingBox();
  await page.screenshot({ path: join(SHOTS, name + ".png"), clip: bb });
};

/* ============ 第一部分：预览页（四种版式 + 控件） ============ */
const page = await browser.newPage({ viewport: { width: 1260, height: 700 }, deviceScaleFactor: 2 });
watch(page);
await page.goto(URL_BASE, { waitUntil: "load" });
await page.waitForTimeout(400);

await page.screenshot({ path: join(SHOTS, "01-preview-axis.png") });
const width = await page.evaluate(() => {
  const o = document.querySelector("#overlay").getBoundingClientRect();
  const c = document.querySelector("#ovCard").getBoundingClientRect();
  return { overlayW: Math.round(o.width), cardH: Math.round(c.height), meter: document.querySelector("#meter").textContent };
});
console.log("① 默认版式 axis:", JSON.stringify(width));

for (const v of ["ticker", "stack", "rail"]) {
  await page.click(`.sb[data-v="${v}"]`);
  await page.waitForTimeout(220);
  await clipCard(`0${["axis", "ticker", "stack", "rail"].indexOf(v) + 3}-${v}`);
  const m = await page.evaluate(() => {
    const c = document.querySelector("#ovCard").getBoundingClientRect();
    return { w: Math.round(c.width), h: Math.round(c.height), meter: document.querySelector("#meter").textContent };
  });
  console.log(`   ${v}: ${JSON.stringify(m)}`);
}
await page.click('.sb[data-v="axis"]');
await page.waitForTimeout(150);

// 演示播放：游标必须真的推进
const t0 = await page.evaluate(() => Math.round(S.t));
await page.click("#btnPlay");
await page.waitForTimeout(1500);
const pl = await page.evaluate(() => ({
  t: Math.round(S.t), playing: S.playing, btn: document.querySelector("#btnPlay").textContent,
  cur: document.querySelector(".now .n")?.textContent,
  accentBar: getComputedStyle(document.querySelector(".now .g")).backgroundColor,
  ticks: document.querySelectorAll(".axis .tick").length,
  nextTickHighlighted: document.querySelectorAll(".axis .tick.next").length,
  nextLabel: document.querySelector(".nxs")?.textContent.replace(/\s+/g, " ").trim(),
  curKind: STEPS[lastIdxAt(STEPS, S.t)]?.k,
}));
console.log("② 演示播放:", JSON.stringify({ before: t0, ...pl }));
if (pl.nextTickHighlighted !== 1) errors.push(`下一项刻度高亮数为 ${pl.nextTickHighlighted}，期望 1`);
if (pl.ticks !== pl.nextTickHighlighted && !pl.nextLabel) errors.push("有下一项但右侧槽位为空");
await clipCard("06-axis-playing");
await page.screenshot({ path: join(SHOTS, "07-preview-playing.png") });
await page.click("#btnPlay");

// 宽度 + 不透明度 + 底衬
await page.fill("#wRange", "620");
await page.dispatchEvent("#wRange", "input");
await page.waitForTimeout(200);
await page.click('.sb[data-bg="check"]');
await page.waitForTimeout(250);
const nar = await page.evaluate(() => ({
  meter: document.querySelector("#meter").textContent,
  ticks: document.querySelectorAll(".axis .tick").length,
  overflow: (() => { const a = document.querySelector(".axis"); return a.scrollWidth > a.clientWidth + 1; })(),
}));
console.log("③ 收窄到 620px + 透明底:", JSON.stringify(nar));
await page.screenshot({ path: join(SHOTS, "08-narrow-transparent.png") });
await clipCard("09-narrow-card");

/* ============ 第二部分：?embed=1 —— exe 里的真实窗口 ============ */
console.log("\n— embed 模式（exe 窗口）逐版式实测 —");
const SIZES = { axis: 36, ticker: 30, stack: 54, rail: null };
for (const v of ["axis", "ticker", "stack", "rail"]) {
  const w = v === "rail" ? 168 : 900;
  const h = SIZES[v] ?? 240;
  const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  watch(p);
  await p.goto(`${URL_BASE}?embed=1&v=${v}`, { waitUntil: "load" });
  await p.waitForTimeout(300);
  const d = await p.evaluate(() => {
    const o = document.querySelector("#overlay").getBoundingClientRect();
    const c = document.querySelector("#ovCard").getBoundingClientRect();
    return {
      shellShown: [...document.querySelectorAll(".shellhead,.shellnote,.bar")].some(e => e.getBoundingClientRect().height > 0),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      overlay: { x: Math.round(o.left), y: Math.round(o.top), w: Math.round(o.width), h: Math.round(c.height) },
      scroll: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
      clip: (() => { const q = document.querySelector("#ovCard"); return q.scrollWidth > q.clientWidth + 1 || q.scrollHeight > q.clientHeight + 1; })(),
    };
  });
  console.log(`   v=${v.padEnd(7)} viewport ${w}×${h} → card ${d.overlay.w}×${d.overlay.h} @ (${d.overlay.x},${d.overlay.y})` +
    `  bg=${d.bodyBg}  scroll=${d.scroll.w}×${d.scroll.h}  内容溢出=${d.clip}`);
  await p.screenshot({ path: join(SHOTS, `1${["axis", "ticker", "stack", "rail"].indexOf(v)}-embed-${v}.png`) });
  if (d.shellShown) errors.push(`embed v=${v}：仍有预览外壳显示`);
  if (d.overlay.x !== 0 || d.overlay.y !== 0) errors.push(`embed v=${v}：未贴 (0,0)，实际 (${d.overlay.x},${d.overlay.y})`);
  if (d.overlay.w !== w) errors.push(`embed v=${v}：卡片宽 ${d.overlay.w} ≠ 窗口宽 ${w}（应填满）`);
  if (d.scroll.w !== w) errors.push(`embed v=${v}：出现横向滚动，scrollWidth ${d.scroll.w} ≠ ${w}`);
  if (d.clip) errors.push(`embed v=${v}：内容被裁切`);
  if (SIZES[v] !== null && d.overlay.h !== SIZES[v]) errors.push(`embed v=${v}：高度 ${d.overlay.h} ≠ 规格 ${SIZES[v]}`);
  if (SIZES[v] === null && d.overlay.h > h) errors.push(`embed v=${v}：自动高度 ${d.overlay.h} 超出窗口 ${h}`);
  await p.close();
}

console.log(errors.length ? "\n!! 错误:\n" + errors.join("\n") : "\n✓ 无错误（控制台干净 + embed 尺寸全部符合规格）");
await browser.close();
