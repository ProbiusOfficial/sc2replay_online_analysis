// 沙盘模拟视图端到端验收：真实 HTTP + 真实 Chromium + 真实录像。
//
//   python3 -m http.server 8123        # 先起服务（本脚本不负责起服务）
//   node scripts/verify-sandbox-view.mjs
//
// 覆盖：视图切换（body.sandboxview + 布局让位：录像列表/对局头隐藏）、DOM 契约、
// 沙盘数据流（window.__sandbox：含图标加载数）、全局时间轴联动、播放推进全局游标、
// 工具条内切换录像、大画布几何契约、截图产物。
import { chromium } from "/Users/macmini/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs";
import { mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const SHOTS = join(REPO, "tests", "screenshots-lab");
mkdirSync(SHOTS, { recursive: true });

const BASE = process.env.LAB_URL || "http://127.0.0.1:8123/index.html";
const SAMPLES = readdirSync(join(REPO, "sampleTest"))
  .filter((n) => n.endsWith(".SC2Replay"))
  .sort()
  .map((n) => join(REPO, "sampleTest", n));

const errors = [];
const expected = [];
const EXPECTED_NOISE = /18760|ERR_CONNECTION_REFUSED|Failed to fetch|net::ERR|Access-Control|NotAllowedError|favicon/i;
const note = (m) => (EXPECTED_NOISE.test(m) ? expected : errors).push(m);

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1.5 });
page.on("console", (m) => { if (m.type() === "error") note("console: " + m.text()); });
page.on("pageerror", (e) => note("pageerror: " + e.message));
page.on("requestfailed", (r) => {
  // 缺图标是数据问题不是脚本问题；但 404 也要如实报出来
  note("requestfailed: " + r.url() + " " + (r.failure()?.errorText || ""));
});

const step = (n, msg) => console.log(`\n【${n}】${msg}`);
const ok = (cond, msg) => {
  console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) errors.push(msg);
};

step(1, "打开页面并等待解析内核就绪");
await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector("#dropZone", { state: "visible", timeout: 30000 });
console.log("  ✓ 解析内核就绪");

step(2, `解析 ${SAMPLES.length} 份真实录像`);
await page.setInputFiles("#fileInput", SAMPLES);
await page.waitForSelector("#result.on", { timeout: 120000 });
await page.waitForFunction(
  (n) => document.querySelectorAll("#samples .smp").length >= n,
  SAMPLES.length,
  { timeout: 30000 },
);
console.log(`  ✓ 已挂载 ${await page.locator("#samples .smp").count()} 份录像`);

step(3, "切换到沙盘模拟视图：整页让位");
await page.click('#viewSeg button[data-view="sandbox"]');
await page.waitForTimeout(300);
ok(await page.evaluate(() => document.body.classList.contains("sandboxview")), "body.sandboxview 已置位");
ok(await page.evaluate(() => getComputedStyle(document.querySelector("#sandboxView")).display !== "none"), "#sandboxView 可见");
ok(await page.evaluate(() => getComputedStyle(document.querySelector(".rail")).display === "none"), "录像列表侧栏已隐藏");
ok(await page.evaluate(() => getComputedStyle(document.querySelector(".head")).display === "none"), "对局头已隐藏");
ok(await page.evaluate(() => getComputedStyle(document.querySelector(".vb")).display === "none"), "语音播报条已隐藏");
ok(await page.evaluate(() => getComputedStyle(document.querySelector("#readouts")).display === "none" && getComputedStyle(document.querySelector(".body.v-data")).display === "none"), "数据分析视图已隐藏");
const wrapW = await page.evaluate(() => document.querySelector(".wrap").getBoundingClientRect().width);
ok(wrapW > 1500, `主体已解除 1600px 上限且占满视口（宽 ${Math.round(wrapW)}）`);

step(4, "大画布几何契约");
const stageBox = await page.locator("#sbStage").boundingBox();
ok(stageBox && stageBox.width > 1400, `画布宽度 ${Math.round(stageBox?.width ?? 0)} > 1400（全宽）`);
ok(stageBox && stageBox.height > 700, `画布高度 ${Math.round(stageBox?.height ?? 0)} > 700（100vh 让位后）`);

step(5, "工具条：地图信息 + 切录像下拉");
const mapInfo = await page.locator("#sbMapInfo").textContent();
ok(/· build \d+ ·/.test(mapInfo), `地图信息已渲染：${mapInfo}`);
ok(await page.locator("#sbReplay option").count() === SAMPLES.length, `切录像下拉有 ${SAMPLES.length} 项`);

step(6, "沙盘数据流（window.__sandbox，含图标）");
await page.waitForFunction(() => window.__sandbox?.stats, { timeout: 10000 });
// 图标是懒加载的：t=0 只有开局建筑/农民，先定位到中盘让更多单位类型入场
await page.evaluate(() => {
  const tl = document.getElementById("tl");
  const rect = tl.getBoundingClientRect();
  tl.dispatchEvent(new PointerEvent("pointerdown", { clientX: rect.left + 14 + (rect.width - 28) * 0.5, bubbles: true }));
  tl.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
});
await page.waitForFunction(() => (window.__sandbox?.stats?.icons ?? 0) > 10, { timeout: 20000 });
const st = await page.evaluate(() => window.__sandbox.stats);
console.log("  " + JSON.stringify(st));
ok(st && st.units > 100, `动态单位 ${st?.units} > 100`);
ok(st && st.statics > 50, `中立地图锚点（矿/气泉等）${st?.statics} > 50`);
ok(st && st.deaths > 10, `死亡事件 ${st?.deaths} > 10`);
ok(st && st.startLocs >= 2, `出生点标记 ${st?.startLocs} ≥ 2`);
ok(st && st.icons > 10, `单位图标已加载 ${st?.icons} 张 > 10`);

step(7, "画布确实画了内容（像素采样）");
const pixels = await page.evaluate(() => {
  const cv = document.getElementById("sbCanvas");
  const c = cv.getContext("2d");
  const img = c.getImageData(0, 0, cv.width, cv.height).data;
  let nonBg = 0;
  for (let i = 0; i < img.length; i += 4) {
    if (Math.abs(img[i] - 14) + Math.abs(img[i + 1] - 20) + Math.abs(img[i + 2] - 29) > 30) nonBg++;
  }
  return { nonBg, total: img.length / 4 };
});
const ratio = pixels.nonBg / pixels.total;
console.log(`  非底图像素占比 ${(ratio * 100).toFixed(1)}%`);
ok(ratio > 0.001, "画布上画出了单位/网格（非底图像素 > 0.1%）");

step(8, "拖动全局时间轴 → 沙盘跟随重绘");
const tlBox = await page.locator("#tl").boundingBox();
await page.mouse.click(tlBox.x + tlBox.width * 0.6, tlBox.y + tlBox.height / 2);
await page.waitForTimeout(400);
const tAfterScrub = await page.evaluate(() => window.__lab.state.t);
ok(tAfterScrub > 100, `全局游标已定位到 ${Math.round(tAfterScrub)}s`);
const hudText = await page.locator("#sbPanelA").textContent();
ok(/单位 \d+ · 农民 \d+ · 建筑 \d+/.test(hudText), `左上面板已刷新：${hudText.trim().slice(0, 70)}`);
const resText = await page.locator("#sbRes").textContent();
ok(/\d+\/\d+/.test(resText), `底部资源条已刷新：${resText.trim().slice(0, 80)}`);
ok((await page.evaluate(() => window.__sandbox.stats.iso)) === true, "斜视角默认开启");

step(9, "播放：沙盘推进全局游标");
const tBeforePlay = await page.evaluate(() => window.__lab.state.t);
await page.click("#sbPlay");
await page.waitForTimeout(2000);
const tAfterPlay = await page.evaluate(() => window.__lab.state.t);
ok(tAfterPlay > tBeforePlay + 8, `2 秒内游标推进 ${Math.round(tAfterPlay - tBeforePlay)}s（8× 期望 ≥ 8s）`);
await page.click("#sbPlay"); // 暂停
const paused = await page.evaluate(() => window.__sandbox.stats.playing);
ok(!paused, "再次点击后暂停");

step(10, "工具条内切换录像");
await page.selectOption("#sbReplay", "1");
await page.waitForTimeout(400);
const st2 = await page.evaluate(() => window.__sandbox.stats);
ok(st2 && st2.ri === 1, `下拉切录像生效（ri=${st2?.ri}）`);
ok(st2 && st2.units > 50, `新样本动态单位 ${st2?.units} > 50`);
const selVal = await page.evaluate(() => document.getElementById("sbReplay").value);
ok(selVal === "1", "下拉值与当前样本同步");

step(11, "截图产物");
await page.selectOption("#sbReplay", "3"); // Eastwatch LE 2018（starcraft2.ai 同一场）
await page.waitForTimeout(300);
await page.evaluate(() => {
  const tl = document.getElementById("tl");
  const rect = tl.getBoundingClientRect();
  tl.dispatchEvent(new PointerEvent("pointerdown", { clientX: rect.left + 14 + (rect.width - 28) * 0.69, bubbles: true }));
  tl.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
});
await page.waitForTimeout(600);
// 科技行：Eastwatch TvT 20:00 时双方都有一串攻防/家防科技
const techStats = await page.evaluate(() => window.__sandbox.stats.tech);
console.log("  科技完成数：", JSON.stringify(techStats));
ok(techStats["1"] + techStats["2"] >= 8, `双方科技 chips 共 ${techStats["1"] + techStats["2"]} ≥ 8`);
const panelTech = await page.locator("#sbPanelA").textContent();
ok(/科技 \d+/.test(panelTech), `面板含科技行：${(panelTech.match(/科技 \d+/) ?? [""])[0]}`);
const trackStats = await page.evaluate(() => window.__sandbox.stats);
console.log("  APM/战损：", JSON.stringify({ apm: trackStats.apm, losses: trackStats.losses }));
ok((trackStats.apm["1"] ?? 0) + (trackStats.apm["2"] ?? 0) > 20, `20:00 双方 APM 合计 ${trackStats.apm["1"] + trackStats.apm["2"]} > 20`);
ok(trackStats.losses["1"] + trackStats.losses["2"] > 50, `双方累计战损 ${trackStats.losses["1"] + trackStats.losses["2"]} > 50`);
ok(/APM \d+/.test(panelTech), "面板含 APM/EPM 读数");
const hudOptCount = await page.locator("#sbHudOpts input").count();
ok(hudOptCount === 7, `HUD 显示开关 7 项（实际 ${hudOptCount}）`);
// 关掉「科技」→ 面板科技行消失
await page.locator('#sbHudOpts input[data-k="tech"]').uncheck();
await page.waitForTimeout(300);
const panelNoTech = await page.locator("#sbPanelA").textContent();
ok(!/科技 \d+/.test(panelNoTech), "取消勾选后科技行隐藏");
await page.locator('#sbHudOpts input[data-k="tech"]').check();
await page.screenshot({ path: join(SHOTS, "sandbox-midgame.png"), clip: { x: 0, y: 0, width: 1600, height: 1100 } });
console.log("  → tests/screenshots-lab/sandbox-midgame.png");

await browser.close();

console.log("\n────────────────────────────────────────────");
const icon404 = expected.filter((m) => /assets\/units/.test(m));
if (icon404.length) console.log(`⚠️ 缺失图标（已回退点阵）${icon404.length} 张：`, icon404.map((m) => m.match(/[A-Za-z0-9_]+\.webp/)?.[0]).join(", "));
if (errors.length) {
  console.log(`❌ 沙盘验收失败 ${errors.length} 项：`);
  for (const e of errors) console.log("  - " + e);
  process.exit(1);
}
console.log(`✅ 沙盘视图验收全过${expected.length ? `（已知噪声 ${expected.length} 条）` : ""}`);
