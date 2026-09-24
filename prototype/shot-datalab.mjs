// 用真实 Chromium 打开 data-lab.html，抓控制台报错 + 多张截图。
//   node prototype/shot-datalab.mjs
//
// 覆盖：数据分析视图 / 建造顺序视图 / 语音播报 / 悬浮通道探测。
// 悬浮组件（127.0.0.1:18760）在本原型里**故意不存在**，因此探测必然失败——
// 这类网络错误被单独收集为 `expected`，不计入真错误。
import { chromium } from "/Users/macmini/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, "shots-lab");
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 2 });

const errors = [];
const expected = [];
const OV_NOISE = /18760|ERR_CONNECTION_REFUSED|Failed to fetch|net::ERR|Access-Control|NotAllowedError/;
const note = (m) => (OV_NOISE.test(m) ? expected : errors).push(m);
page.on("console", (m) => { if (m.type() === "error") note("console: " + m.text()); });
page.on("pageerror", (e) => note("pageerror: " + e.message));
page.on("requestfailed", (r) => note("requestfailed: " + r.url() + " " + (r.failure()?.errorText || "")));

await page.goto("file://" + join(HERE, "data-lab.html"), { waitUntil: "load" });
await page.waitForTimeout(600);

const shot = async (name, opts = {}) => { await page.screenshot({ path: join(SHOTS, name + ".png"), ...opts }); };
const clip = async (sel, name) => {
  const el = await page.$(sel);
  if (!el) { errors.push(`missing selector ${sel}`); return; }
  await el.screenshot({ path: join(SHOTS, name + ".png") });
};

/* ======================= 数据分析视图 ======================= */
await shot("01-top", { clip: { x: 0, y: 0, width: 1600, height: 860 } });
await clip("#tl", "02-timeline");
await clip(".readouts", "03-readouts");
await clip("#head", "04-head");

const card1 = page.locator(".charts > .card:nth-child(1)");
await card1.scrollIntoViewIfNeeded();
await page.waitForTimeout(150);
const plotBox = await card1.locator(".plot").boundingBox();
await page.mouse.move(plotBox.x + plotBox.width * 0.42, plotBox.y + plotBox.height * 0.5, { steps: 6 });
await page.waitForTimeout(300);
const moved = await page.evaluate(() => ({ t: S.t, clock: document.querySelector("#clock").textContent.trim() }));
console.log("① 游标移动检验:", JSON.stringify(moved), "(期望 t ≈ 0.42 × 总时长)");
await clip(".charts > .card:nth-child(1)", "06-card-a");
await clip(".charts > .card:nth-child(5)", "07-card-army");
await clip(".readouts", "08-readouts-moved");
await page.screenshot({ path: join(SHOTS, "08b-charts-cursor.png") });

await page.evaluate(() => window.scrollTo(0, 900));
await page.waitForTimeout(200);
await shot("05-charts");

await page.click('#modeSeg button[data-mode="diff"]');
await page.waitForTimeout(300);
await shot("09-diff");
await page.click('#modeSeg button[data-mode="overlay"]');

await page.click('.sidefoot button[data-p="all"]');
await page.waitForTimeout(400);
await shot("10-all-metrics");
await clip(".charts", "10b-charts-all");
await page.click('.sidefoot button[data-p="core"]');
await page.waitForTimeout(300);

await page.evaluate(() => document.querySelector(".tblbox").scrollIntoView());
await page.waitForTimeout(200);
await shot("11-table");

/* ======================= 建造顺序视图 ======================= */
await page.click('#viewSeg button[data-view="bo"]');
await page.waitForTimeout(400);
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(200);
await shot("20-bo-top", { clip: { x: 0, y: 0, width: 1600, height: 980 } });
await clip("#bo .bocol.pa", "21-bo-col-a");
await clip("#bo .bocol.pb", "22-bo-col-b");
await clip("#boFilter", "23-bo-filter");

// 点第 60 行（A 侧）→ 应跳到该行时间，且两列同步高亮
const boRows = await page.locator("#bo .bocol.pa .borow").count();
const before = await page.evaluate(() => S.t);
await page.locator("#bo .bocol.pa .borow").nth(Math.min(60, boRows - 1)).click();
await page.waitForTimeout(300);
const after = await page.evaluate(() => ({
  t: S.t,
  clock: document.querySelector("#clock").textContent.trim(),
  nowA: document.querySelectorAll("#bo .bocol.pa .borow.now").length,
  nowB: document.querySelectorAll("#bo .bocol.pb .borow.now").length,
  nowText: document.querySelector("#bo .bocol.pa .borow.now")?.innerText.replace(/\n/g, " | ") ?? null,
}));
console.log("② 建造顺序点行跳转:", JSON.stringify({ before: Math.round(before), ...after }));
await clip("#bo", "24-bo-jumped");

// 筛选：只留建筑 + 科技
await page.click('#boFilter button:nth-child(1)');   // 关建筑
await page.click('#boFilter button:nth-child(2)');   // 关单位
await page.click('#boFilter button:nth-child(3)');   // 关农民
await page.waitForTimeout(300);
const filt = await page.evaluate(() => ({
  visibleKinds: [...boVisible],
  rowsA: document.querySelectorAll("#bo .bocol.pa .borow").length,
  steps: V.steps.length,
  queue: document.querySelector("#vbQueue").innerText.replace(/\n/g, " · "),
}));
console.log("③ 筛选后:", JSON.stringify(filt));
await clip("#bo .bocol.pa", "25-bo-filtered");
// 复原
await page.click('#boFilter button:nth-child(1)');
await page.click('#boFilter button:nth-child(2)');
await page.click('#boFilter button:nth-child(3)');
await page.waitForTimeout(200);

/* ======================= 语音播报 ======================= */
const vinfo = await page.evaluate(() => ({
  who: [...document.querySelectorAll("#vbWho option")].map((o) => o.textContent),
  steps: V.steps.length,
  firstText: V.steps[0]?.text,
  firstT: V.steps[0]?.t,
  head3: V.steps.slice(0, 3).map((s) => `${s.t}s ${s.text}`),
  synth: typeof speechSynthesis !== "undefined" ? "available" : "missing",
}));
console.log("④ 播报脚本:", JSON.stringify(vinfo));

// 最快的「游戏倍率」跑，让游标真的推进，再验状态机。
// ⚠️ 倍速控件换过：旧的 #vbSpeed（1/2/4/8×）已拆成 #ovSpeed（游戏倍率，最快 1.4）+ #vbRate（TTS 语速）。
// 首条播报在 2.14s，1.4× 下 1.8s 内念不到 —— 要等 V.spoken ≥ 0（-1 = 还没开口）而不是死等。
await page.selectOption("#ovSpeed", "faster");
await page.click("#vbPlay");
await page.waitForFunction(() => V.spoken >= 0, null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(200);
const playing = await page.evaluate(() => ({
  playing: V.playing,
  t: Math.round(S.t * 10) / 10,
  spoken: V.spoken,
  clockOn: document.querySelector("#vbClock").classList.contains("on"),
  btn: document.querySelector("#vbPlay").textContent,
  queueCur: document.querySelector("#vbQueue .qs.cur")?.innerText.replace(/\n/g, " ") ?? null,
  prog: document.querySelector("#vbProg").style.width,
}));
console.log("⑤ 播报运行中:", JSON.stringify(playing));
await clip("#vb", "26-voicebar-playing");
await shot("27-voice-scrolled", { clip: { x: 0, y: 0, width: 1600, height: 1000 } });

// 切播报对象 → 脚本应重建
await page.selectOption("#vbWho", "1");
await page.waitForTimeout(300);
const who2 = await page.evaluate(() => ({
  steps: V.steps.length, first: V.steps[0]?.text, playing: V.playing,
  queue: document.querySelector("#vbQueue").innerText.replace(/\n/g, " · "),
}));
console.log("⑥ 切换播报对象:", JSON.stringify(who2));

await page.click("#vbReset");
await page.waitForTimeout(250);
const reset = await page.evaluate(() => ({ t: S.t, playing: V.playing, spoken: V.spoken, clock: document.querySelector("#vbClock").textContent }));
console.log("⑦ 重置:", JSON.stringify(reset));

// 快捷键 Alt+↑
await page.keyboard.press("Alt+ArrowUp");
await page.waitForTimeout(300);
console.log("⑧ Alt+↑:", JSON.stringify(await page.evaluate(() => ({ playing: V.playing, btn: document.querySelector("#vbPlay").textContent }))));
await page.keyboard.press("Alt+ArrowUp");

/* ======================= 悬浮通道 ======================= */
const ov = await page.evaluate(() => ({
  dot: document.querySelector("#ovDot").className,
  txt: document.querySelector("#ovTxt").textContent,
  hasDocPip: "documentPictureInPicture" in window,
}));
console.log("⑨ 悬浮探测结果:", JSON.stringify(ov));
await clip("#vb .ov", "28-overlay-status");

// 点「悬浮到桌面」→ 无组件时应降级
await page.click("#ovBtn");
await page.waitForTimeout(1500);
const ov2 = await page.evaluate(() => ({
  dot: document.querySelector("#ovDot").className,
  txt: document.querySelector("#ovTxt").textContent,
  pipOpen: !!pipWin,
}));
console.log("⑩ 点按悬浮后:", JSON.stringify(ov2));
await clip("#vb .ov", "29-overlay-after-click");

/* ======================= 跨样本 ======================= */
await page.click('#viewSeg button[data-view="data"]');
await page.waitForTimeout(200);
await page.locator("#samples .smp").nth(3).click();
await page.waitForTimeout(500);
await shot("11b-hots-top", { clip: { x: 0, y: 0, width: 1600, height: 860 } });
await clip("#head", "12-head-hots");
await clip("#tl", "13-timeline-hots");
const hots = await page.evaluate(() => ({ boA: rep().players[0].buildOrder.length, who: [...document.querySelectorAll("#vbWho option")].map(o => o.textContent) }));
await page.click('#viewSeg button[data-view="bo"]');
await page.waitForTimeout(400);
await clip("#bo", "30-bo-hots");
const hotsBo = await page.evaluate(() => ({
  rowsA: document.querySelectorAll("#bo .bocol.pa .borow").length,
  rowsB: document.querySelectorAll("#bo .bocol.pb .borow").length,
  filter: document.querySelector("#boFilter").innerText.replace(/\n/g, " "),
}));
console.log("⑪ HotS 老录像:", JSON.stringify({ ...hots, ...hotsBo }));

await page.locator("#samples .smp").nth(0).click();
await page.waitForTimeout(400);
await clip("#tl", "14-timeline-short");
await clip("#bo", "31-bo-short");

/* ======================= 几何自检 ======================= */
const diag = await page.evaluate(() => {
  const cards = [...document.querySelectorAll("#charts .card")].filter((c) => c._geo);
  const colA = document.querySelector("#bo .bocol.pa");
  return {
    cardCount: cards.length,
    sampleCount: DATA.replays.length,
    metrics: M.length,
    geosOk: cards.every((c) => c._geo.W > 0 && c._geo.H > 0),
    tlWidth: Math.round(document.querySelector("#tlsvg").getBoundingClientRect().width),
    tableRows: document.querySelectorAll("#tbl tbody tr").length,
    clock: document.querySelector("#clock").textContent.trim(),
    boColWidth: colA ? Math.round(colA.getBoundingClientRect().width) : 0,
    boListScrollable: (() => { const l = document.querySelector("#bo .bolist"); return l ? l.scrollHeight > l.clientHeight : false; })(),
    voiceBarH: Math.round(document.querySelector("#vb").getBoundingClientRect().height),
    wrapPadBottom: getComputedStyle(document.querySelector(".wrap")).paddingBottom,
    boOverlapsVoice: (() => {
      const l = document.querySelector("#bo .bolist").getBoundingClientRect();
      const v = document.querySelector("#vb").getBoundingClientRect();
      return l.bottom > v.top;
    })(),
  };
});
console.log("\n几何自检:\n" + JSON.stringify(diag, null, 1));

console.log(`\n预期内的探测噪声 ${expected.length} 条（悬浮组件不存在，属预期）`);
console.log(errors.length ? "\n!! 真错误:\n" + errors.join("\n") : "\n✓ 无真错误");
await browser.close();
