// 沙盘平移/缩放可达性探针（只读诊断，不改动页面）：
//   python3 -m http.server 8123
//   node scripts/research/probe-sandbox-pan.mjs
//
// 复现探宝报的「放大后有些区域拖不过去」：
//   A) 画布网格扫描：哪些起点根本起不了拖（HUD 面板/资源条死区）
//   B) 逐倍率 × 逐方向：连拖到墙，记录墙的位置、墙上的画面内容（地面占比）
//   C) 连续快拖：会不会误触 dblclick 复位（zoom 意外回到 1）
import { chromium } from "/Users/macmini/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const BASE = process.env.LAB_URL || "http://127.0.0.1:8123/index.html";
const SAMPLE = readdirSync(join(REPO, "sampleTest")).filter((n) => /Eastwatch/i.test(n))[0]
  ?? readdirSync(join(REPO, "sampleTest")).filter((n) => n.endsWith(".SC2Replay")).sort()[3];

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.log("pageerror:", e.message));

await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("#dropZone", { state: "visible", timeout: 30000 });
await page.setInputFiles("#fileInput", [join(REPO, "sampleTest", SAMPLE)]);
await page.waitForSelector("#result.on", { timeout: 120000 });
await page.click('#viewSeg button[data-view="sandbox"]');
await page.waitForFunction(() => window.__sandbox?.stats, { timeout: 10000 });

const stats = () => page.evaluate(() => window.__sandbox.stats);
const cvBox = await page.locator("#sbCanvas").boundingBox();
const cx = cvBox.x + cvBox.width / 2, cy = cvBox.y + cvBox.height / 2;

// 定位到中盘，让画面有内容
{
  const t0 = await page.evaluate(() => { const tl = document.getElementById("tl"); const r = tl.getBoundingClientRect(); return { tl, r }; });
  await page.evaluate(() => {
    const tl = document.getElementById("tl");
    const rect = tl.getBoundingClientRect();
    tl.dispatchEvent(new PointerEvent("pointerdown", { clientX: rect.left + 14 + (rect.width - 28) * 0.5, bubbles: true }));
    tl.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  });
}
await page.waitForTimeout(500);

const drag = async (x0, y0, x1, y1, steps = 6) => {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps });
  await page.mouse.up();
};

console.log(`\n=== A) 拖拽起点死区扫描（zoom=1，向右拖 240px，Δpan.x≈240 为正常；每格前复位视图）===`);
const deadCells = [];
for (let gy = 0; gy < 5; gy++) {
  const row = [];
  for (let gx = 0; gx < 10; gx++) {
    await page.evaluate(() => document.getElementById("sbFit").click()); // 复位：pan 不跨格累积
    await page.waitForTimeout(120);
    const px = cvBox.x + (cvBox.width / 10) * (gx + 0.5);
    const py = cvBox.y + (cvBox.height / 5) * (gy + 0.5);
    const before = (await stats()).pan;
    await drag(px, py, px + 240, py);
    await page.waitForTimeout(80);
    const after = (await stats()).pan;
    const d = Math.round(after.x - before.x);
    row.push(d);
    if (Math.abs(d) < 40) deadCells.push({ px: Math.round(px - cvBox.x), py: Math.round(py - cvBox.y), d });
  }
  console.log("  ", row.map((d) => String(d).padStart(4)).join(" "));
}
console.log(deadCells.length
  ? `  ✗ 死区起点 ${deadCells.length} 个：` + JSON.stringify(deadCells)
  : "  ✓ 无死区（所有起点都能拖）");

// 回到适配 + 中盘
await page.evaluate(() => document.getElementById("sbFit").click());
await page.waitForTimeout(300);

console.log(`\n=== B) 逐倍率 × 逐方向：连拖到墙（每次拖 0.82→0.18 视口宽，最多 12 轮）===`);
for (const zt of [2.9, 6.8, 10]) {
  // 滚轮小步放大逼近目标倍率（Chromium 对 wheel deltaY 有缩水，一次大滚会直接冲到 10×）
  await page.evaluate(() => document.getElementById("sbFit").click());
  await page.waitForTimeout(200);
  let s = await stats();
  while (s.zoom < zt) {
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -500);
    await page.waitForTimeout(100);
    s = await stats();
    if (s.zoom >= 10) break;
  }
  console.log(`\n  --- zoom=${(await stats()).zoom.toFixed(1)} ---`);
  for (const [dir, dx, dy] of [["左", -1, 0], ["右", 1, 0], ["上", 0, -1], ["下", 0, 1]]) {
    let prev = { ...(await stats()).pan };
    let rounds = 0;
    for (let i = 0; i < 12; i++) {
      await drag(cx, cy, cx + dx * cvBox.width * 0.64, cy + dy * cvBox.height * 0.64, 8);
      await page.waitForTimeout(60);
      const cur = (await stats()).pan;
      const moved = Math.abs(cur.x - prev.x) + Math.abs(cur.y - prev.y);
      prev = cur;
      rounds = i + 1;
      if (moved < 8) break; // 撞墙了（钳制吃掉了后续拖动）
    }
    const st = await stats();
    // 墙上画面的地面占比（<40% 说明贴墙看到的大多是地图外的空黑）
    const ground = await page.evaluate(() => {
      const cv = document.getElementById("sbCanvas");
      const w = cv.width, h = cv.height;
      const img = cv.getContext("2d").getImageData(0, 0, w, h).data;
      let g = 0, n = 0;
      for (let i = 0; i < img.length; i += 4) {
        const d1 = Math.abs(img[i] - 13) + Math.abs(img[i + 1] - 18) + Math.abs(img[i + 2] - 25);
        const d2 = Math.abs(img[i] - 14) + Math.abs(img[i + 1] - 20) + Math.abs(img[i + 2] - 29);
        if (d1 <= 3 || d2 <= 3) g++;
        n++;
      }
      return g / n;
    });
    console.log(`    ${dir}: ${rounds} 轮到墙 · pan=(${Math.round(prev.x)},${Math.round(prev.y)}) · 画面中心=(${Math.round(st.centerScreen.x)},${Math.round(st.centerScreen.y)}) · 地面占比 ${(ground * 100).toFixed(0)}%`);
  }
}

console.log(`\n=== C) 连续快拖 8 次：是否误触 dblclick 复位 ===`);
await page.evaluate(() => document.getElementById("sbFit").click());
await page.waitForTimeout(200);
await page.mouse.move(cx, cy);
await page.mouse.wheel(0, -1600);
await page.waitForTimeout(300);
const zBefore = (await stats()).zoom;
for (let i = 0; i < 8; i++) {
  const dir = i % 2 === 0 ? -1 : 1;
  await drag(cx + dir * 200, cy, cx - dir * 300, cy, 4); // 快速连续、起点都在中部
}
await page.waitForTimeout(400);
const zAfter = (await stats()).zoom;
console.log(`  zoom ${zBefore.toFixed(1)} → ${zAfter.toFixed(1)} ${Math.abs(zAfter - zBefore) < 0.01 ? "✓ 未误触复位" : "✗ 被双击复位吃掉了！"}`);

await browser.close();
console.log("\n探针完成。");
