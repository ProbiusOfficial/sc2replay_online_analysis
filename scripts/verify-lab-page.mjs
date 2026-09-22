// 生产页面（index.html）端到端验收：真实 HTTP + 真实 Chromium + 真实录像。
//
//   python3 -m http.server 8123        # 先起服务（本脚本不负责起服务）
//   node scripts/verify-lab-page.mjs
import { chromium } from "/Users/macmini/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const SHOTS = join(REPO, "tests/screenshots-lab");
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
page.on("requestfailed", (r) => note("requestfailed: " + r.url() + " " + (r.failure()?.errorText || "")));

const step = (n, msg) => console.log(`\n【${n}】${msg}`);

/* ---------------- 1. 加载与初始化 ---------------- */
step(1, "打开页面并等待解析内核就绪");
await page.goto(BASE, { waitUntil: "load" });

// 视图层要用的 DOM 契约 —— 缺任何一个都会在挂载时炸，所以在这里先断言
const REQUIRED_IDS = [
  "viewSeg", "modeSeg", "btnCsv", "samples", "head", "clock", "tl", "tlsvg", "evlay", "tlcl",
  "tllegend", "readouts", "side", "charts", "boFilter", "bo", "boView", "tblInfo", "tblSeg", "tbl",
  "vb", "vbClock", "vbQueue", "vbProg", "vbPlay", "vbReset", "vbWho", "vbSpeed", "vbRate", "vbLang",
  "ovDot", "ovTxt", "ovBtn", "initStatus", "initProgress", "dropZone", "fileInput", "loading",
  "loadingText", "error", "result", "pickMore", "railNote",
];
const missing = await page.evaluate(
  (ids) => ids.filter((id) => !document.getElementById(id)),
  REQUIRED_IDS,
);
console.log(`  DOM 契约：需要 ${REQUIRED_IDS.length} 个 id，缺失 ${missing.length} 个` + (missing.length ? ` → ${missing.join(", ")}` : ""));
if (missing.length) errors.push("缺少 DOM id: " + missing.join(", "));

await page.waitForSelector("#dropZone", { state: "visible", timeout: 30000 });
console.log("  ✓ 解析内核就绪，拖放区已显示");

/* ---------------- 2. 拖入真实录像 ---------------- */
step(2, `解析 ${SAMPLES.length} 份真实录像（走 worker + wasm 全链路）`);
const t0 = Date.now();
await page.setInputFiles("#fileInput", SAMPLES);
await page.waitForSelector("#result.on", { timeout: 120000 });
await page.waitForTimeout(600);
console.log(`  ✓ 完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const loaded = await page.evaluate(() => ({
  files: [...document.querySelectorAll("#samples .smp")].map((b) => b.querySelector("b")?.textContent),
  note: document.querySelector("#railNote")?.textContent,
  charts: document.querySelectorAll("#charts .card").length,
  chartMetrics: [...document.querySelectorAll("#charts .card")].map((c) => c._m?.id).filter(Boolean).length,
  groups: document.querySelectorAll("#side .grp").length,
  readouts: document.querySelectorAll("#readouts .ro").length,
  tableRows: document.querySelectorAll("#tbl tbody tr").length,
  whoOptions: document.querySelector("#vbWho")?.options.length,
  boRows: document.querySelectorAll("#bo .borow").length,
  clock: document.querySelector("#clock")?.textContent,
  errorShown: document.querySelector("#error")?.classList.contains("on"),
  dropZoneVisible: (() => {
    const el = document.querySelector("#dropZone");
    return !!el && getComputedStyle(el).display !== "none";
  })(),
  debugHandle: typeof window.__lab === "object" && !!window.__lab.state,
  voiceSteps: window.__lab?.voice?.steps?.length ?? -1,
}));
console.log("  " + JSON.stringify(loaded));
// 默认只开「核心 6 项」（DEFAULT_ON），不是 28 —— 28 在「全选」时才出现
const DEFAULT_ON_COUNT = 6;
if (loaded.files.length !== SAMPLES.length) errors.push(`录像列表 ${loaded.files.length} ≠ 拖入 ${SAMPLES.length}`);
if (loaded.charts !== DEFAULT_ON_COUNT) errors.push(`默认图表数 ${loaded.charts} ≠ ${DEFAULT_ON_COUNT}`);
if (loaded.chartMetrics !== loaded.charts) errors.push("有图表卡片没绑定指标定义（_m 缺失）");
if (loaded.groups !== 7) errors.push(`左侧指标分组数 ${loaded.groups} ≠ 7`);
if (loaded.readouts !== 8) errors.push(`读数卡 ${loaded.readouts} ≠ 8`);
if (loaded.tableRows < 10) errors.push(`采样表行数 ${loaded.tableRows} 过少`);
if (loaded.boRows !== 0) errors.push(`未切到建造顺序视图却已有 ${loaded.boRows} 行`);
if (loaded.errorShown) errors.push("加载成功了但错误条仍在显示");
// 回归断言：曾经因为 `show()` 切 class 而 drop-zone 的显隐是 style.display，两套机制不一致，
// 导致加载完成后拖放区还留在页面上，把结果区整体往下推 230px。
if (loaded.dropZoneVisible) errors.push("加载完成后拖放区没有隐藏（应改走 style.display）");
if (!loaded.debugHandle) errors.push("window.__lab 调试句柄未挂上");
if (loaded.voiceSteps <= 0) errors.push("播报脚本为空（__lab.voice.steps）");

const perReplay = await page.evaluate(() =>
  [...document.querySelectorAll("#samples .smp")].map((b) => b.innerText.replace(/\n/g, " | ")),
);
console.log("  录像列表：");
for (const s of perReplay) console.log("    " + s);

/* ---------------- 2b. 布局契约 ---------------- */
step("2b", "布局契约（底部条与主体对齐 / 录像列表侧边栏 / 页脚不被遮）");
// 所有几何判据都在「滚到页面最底」时测 —— 否则量到的是中途状态，遮挡判据不可信
await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
await page.waitForTimeout(350);
const layout = await page.evaluate(() => {
  const round = (v) => Math.round(v);
  const vb = document.querySelector("#vb");
  const vbr = vb.getBoundingClientRect();
  const contentLeft = (el) =>
    el ? round(el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft)) : null;
  // 用**内容盒**底边：页脚自己带一圈 padding 当底部留白，那圈空白落在条后面不算遮挡
  const coveredBy = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.height === 0) return null;
    const padB = parseFloat(getComputedStyle(el).paddingBottom) || 0;
    return round(r.bottom - padB - vbr.top);
  };
  const rail = document.querySelector(".rail");
  const samples = document.querySelector("#samples");
  return {
    vbBottom: round(vbr.bottom),
    innerH: innerHeight,
    innerW: innerWidth,
    alignDiff: contentLeft(document.querySelector(".vbin")) - contentLeft(document.querySelector(".wrap")),
    railW: rail ? round(rail.getBoundingClientRect().width) : null,
    railSticky: rail ? getComputedStyle(rail).position : null,
    samplesDir: samples ? getComputedStyle(samples).flexDirection : null,
    samplesOverflowY: samples ? getComputedStyle(samples).overflowY : null,
    vbh: getComputedStyle(document.documentElement).getPropertyValue("--vbh").trim(),
    covered: {
      footer: coveredBy(document.querySelector("footer")),
      rail: coveredBy(rail),
      side: coveredBy(document.querySelector("#side")),
    },
    atBottom: Math.abs(scrollY + innerHeight - document.documentElement.scrollHeight) <= 2,
  };
});
console.log("  " + JSON.stringify(layout));
if (layout.vbBottom !== layout.innerH) errors.push("底部播报条没有贴住视口底部");
// 下面这条是最初的缺陷：.vb 横跨视口、内容却从视口左缘起排，与居中的 .wrap 错位（1920 屏偏 142px）
if (layout.alignDiff !== 0) errors.push(`底部播报条与主体左边缘错位 ${layout.alignDiff}px`);
if (layout.innerW > 1180) {
  if (layout.railW !== 236) errors.push(`录像列表侧栏宽度 ${layout.railW} ≠ 236`);
  if (layout.railSticky !== "sticky") errors.push(`录像列表侧栏未吸顶（position=${layout.railSticky}）`);
  if (layout.samplesDir !== "column") errors.push(`录像列表不是竖排（flex-direction=${layout.samplesDir}）`);
}
if (layout.samplesOverflowY !== "auto") errors.push(`录像列表缺少竖向溢出策略（overflow-y=${layout.samplesOverflowY}）`);
if (!layout.vbh) errors.push("--vbh 未由 JS 写入（底部留白会退回 fallback，页脚可能被遮）");
if (!layout.atBottom) errors.push("未能滚到页面最底，遮挡判据不可信");
for (const [k, v] of Object.entries(layout.covered)) {
  if (v != null && v > 0) errors.push(`滚到页面最底时 ${k} 被底部播报条盖住 ${v}px`);
}
await page.screenshot({ path: join(SHOTS, "01b-layout-bottom.png") });
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(250);

/* ---------------- 2c. SVG 等比 + 窗口缩放重绘 ---------------- */
step("2c", "SVG viewBox 必须与显示尺寸等比（防刻度文字被拉伸）");
// 曾经 mountLab 在 #result 还是 display:none 时就渲染：clientWidth=0 → viewBox 停在
// 最小值兜底（时间轴 420 / 图表 320），叠加 preserveAspectRatio="none" 后整个内容
// 被横向拉宽 ~3 倍，刻度文字明显变形。这条防线以后任何「viewBox 过期」都拦得住。
const svgCheck = await page.evaluate(() => {
  let worst = 1;
  for (const svg of document.querySelectorAll("svg")) {
    const m = svg.getScreenCTM();
    if (!m || svg.getBoundingClientRect().width === 0) continue;
    const sx = Math.hypot(m.a, m.b);
    const sy = Math.hypot(m.c, m.d);
    if (!sy || !sx) continue;
    worst = Math.max(worst, sx / sy, sy / sx);
  }
  const tl = document.querySelector("#tlsvg");
  return {
    worstXOverY: +worst.toFixed(4),
    tlViewBoxW: +(tl.getAttribute("viewBox") || "0 0 0 0").split(" ")[2],
    tlShownW: Math.round(tl.getBoundingClientRect().width),
  };
});
console.log("  " + JSON.stringify(svgCheck));
if (svgCheck.worstXOverY > 1.01) errors.push(`存在非等比缩放的 SVG（最大 x/y = ${svgCheck.worstXOverY}），文字会被拉变形`);
if (Math.abs(svgCheck.tlViewBoxW - svgCheck.tlShownW) > 4)
  errors.push(`时间轴 viewBox 宽 ${svgCheck.tlViewBoxW} ≠ 实际宽 ${svgCheck.tlShownW}`);

// 缩窄到 ≤1180px：媒体查询会让侧栏转横排、容器变宽 → 必须触发 resize 重绘拉回 viewBox
await page.setViewportSize({ width: 1100, height: 900 });
await page.waitForTimeout(650);
const rs = await page.evaluate(() => {
  const s = document.querySelector("#tlsvg");
  const m = s.getScreenCTM();
  return {
    viewBoxW: +(s.getAttribute("viewBox") || "0 0 0 0").split(" ")[2],
    shownW: Math.round(s.getBoundingClientRect().width),
    xOverY: m ? +(Math.hypot(m.a, m.b) / Math.hypot(m.c, m.d)).toFixed(4) : null,
  };
});
console.log("  缩到 1100 宽后：" + JSON.stringify(rs));
if (Math.abs(rs.viewBoxW - rs.shownW) > 4)
  errors.push(`窗口缩放后 viewBox 宽 ${rs.viewBoxW} ≠ 实际宽 ${rs.shownW}（watchResultWidth 重绘没生效）`);
if (Math.abs((rs.xOverY ?? 1) - 1) > 0.01) errors.push(`窗口缩放后出现非等比缩放 x/y=${rs.xOverY}`);
await page.screenshot({ path: join(SHOTS, "01c-resized-1100.png") });
await page.setViewportSize({ width: 1600, height: 1100 });
await page.waitForTimeout(400);

/* ---------------- 3. 逐份切换 ---------------- */
step(3, `逐份切换（共 ${SAMPLES.length} 份，验证跨样本重建）`);
const perFile = [];
for (let i = 0; i < SAMPLES.length; i++) {
  await page.locator("#samples .smp").nth(i).click();
  await page.waitForTimeout(350);
  const d = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("#charts .card")].filter((c) => c._geo);
    return {
      map: document.querySelector("#head h1")?.textContent,
      clock: document.querySelector("#clock")?.textContent,
      charts: cards.length,
      noZeroGeo: cards.every((c) => c._geo.W > 0 && c._geo.H > 0),
      readouts: document.querySelectorAll("#readouts .ro").length,
      tableRows: document.querySelectorAll("#tbl tbody tr").length,
      voiceWho: [...document.querySelectorAll("#vbWho option")].map((o) => o.textContent),
      tlTicks: document.querySelectorAll("#tlsvg i").length,
    };
  });
  perFile.push(d);
  console.log(
    `  [${i + 1}] ${d.map} · ${d.clock} · 图 ${d.charts} · 读数 ${d.readouts} · 表 ${d.tableRows} 行 · 播报对象 ${d.voiceWho.join("/")}`,
  );
  if (!d.noZeroGeo) errors.push(`第 ${i + 1} 份有图表几何为 0（渲染失败）`);
  if (d.charts !== DEFAULT_ON_COUNT) errors.push(`第 ${i + 1} 份图表数 ${d.charts} ≠ ${DEFAULT_ON_COUNT}`);
  if (d.readouts !== 8) errors.push(`第 ${i + 1} 份读数卡 ${d.readouts} ≠ 8`);
  if (d.voiceWho.length !== 2) errors.push(`第 ${i + 1} 份播报对象选项 ${d.voiceWho.length} ≠ 2`);
}

/* ---------------- 4. 游标联动 ---------------- */
step(4, "游标联动（图表 hover → 时间轴 / 读数 / 采样表）");
await page.locator("#samples .smp").nth(0).click();
await page.waitForTimeout(300);
const card = page.locator("#charts > .card").first();
await card.scrollIntoViewIfNeeded();
await page.waitForTimeout(200);
const box = await card.locator(".plot").boundingBox();
await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5, { steps: 5 });
await page.waitForTimeout(300);
const cur = await page.evaluate(() => ({
  clock: document.querySelector("#clock").textContent.trim(),
  tblOn: document.querySelector("#tbl tbody tr.on")?.cells[0]?.textContent,
  cursorLeft: document.querySelector("#tlcl").style.left,
}));
console.log("  " + JSON.stringify(cur));
if (cur.clock.startsWith("00:00")) errors.push("hover 图表未推进游标（时钟仍是 00:00）");
if (!cur.tblOn) errors.push("hover 后采样表没有高亮行");
await page.screenshot({ path: join(SHOTS, "01-data-view.png") });

/* ---------------- 4b. 时间轴点击制 ---------------- */
step("4b", "时间轴为点击制（悬停只出预览、不得移动游标，按下才动）");
// 探宝反馈：时间轴随悬停扫描太容易误触 —— 鼠标路过就改变查看位置。
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(250);
const baseClock = await page.evaluate(() => document.querySelector("#clock").textContent.trim());
const tlBox2 = await page.locator("#tl").boundingBox();
// 悬停（不按键）：时钟必须原地不动，预览浮标必须出现
await page.mouse.move(tlBox2.x + tlBox2.width * 0.7, tlBox2.y + tlBox2.height * 0.5, { steps: 4 });
await page.waitForTimeout(300);
const hoverState = await page.evaluate(() => ({
  clock: document.querySelector("#clock").textContent.trim(),
  peekOn: document.querySelector("#tl .tl-peek")?.classList.contains("on") ?? false,
  peekText: document.querySelector("#tl .tl-peek")?.dataset.t ?? "",
}));
console.log("  悬停 → " + JSON.stringify(hoverState));
if (hoverState.clock !== baseClock) errors.push("时间轴悬停仍移动游标（应为点击制）");
if (!hoverState.peekOn || !hoverState.peekText) errors.push("时间轴悬停没有显示预览浮标");
// 按下拖动：游标必须移动
await page.mouse.down();
await page.mouse.move(tlBox2.x + tlBox2.width * 0.3, tlBox2.y + tlBox2.height * 0.5, { steps: 4 });
await page.mouse.up();
await page.waitForTimeout(300);
const pressedClock = await page.evaluate(() => document.querySelector("#clock").textContent.trim());
console.log("  按下 → " + pressedClock);
if (pressedClock === baseClock) errors.push("时间轴按下后游标未移动（点击制失效）");
await page.screenshot({ path: join(SHOTS, "04b-timeline-clickseek.png") });

/* ---------------- 5. 视图与模式 ---------------- */
step(5, "视图切换 / 差值模式 / 指标全选");
await page.click('#modeSeg button[data-mode="diff"]');
await page.waitForTimeout(300);
const diffDots = await page.evaluate(() => document.querySelectorAll('#charts [data-dot="a"]:not([style*="none"])').length);
console.log(`  差值模式下可见的单方取值点 = ${diffDots}（期望 0）`);
if (diffDots !== 0) errors.push(`差值模式仍显示 ${diffDots} 个单方取值点`);
await page.click('#modeSeg button[data-mode="overlay"]');

await page.click('.sidefoot button[data-p="all"]');
await page.waitForTimeout(400);
const allCount = await page.evaluate(() => document.querySelectorAll("#charts .card").length);
console.log(`  全选指标后图表数 = ${allCount}`);
await page.screenshot({ path: join(SHOTS, "02-all-metrics.png") });
await page.click('.sidefoot button[data-p="core"]');
await page.waitForTimeout(300);

/* ---------------- 6. 建造顺序 ---------------- */
step(6, "建造顺序视图");
await page.click('#viewSeg button[data-view="bo"]');
await page.waitForTimeout(500);
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(200);
const bo = await page.evaluate(() => ({
  rowsA: document.querySelectorAll("#bo .bocol.pa .borow").length,
  rowsB: document.querySelectorAll("#bo .bocol.pb .borow").length,
  filters: document.querySelector("#boFilter").innerText.replace(/\n/g, " "),
  firstRow: document.querySelector("#bo .bocol.pa .borow")?.innerText.replace(/\n/g, " | "),
  stat: document.querySelector("#bo .bostat")?.textContent,
}));
console.log("  " + JSON.stringify(bo));
if (bo.rowsA + bo.rowsB === 0) errors.push("建造顺序两侧都没有行");
if (!bo.stat) errors.push("建造顺序列表缺少统计行");
await page.screenshot({ path: join(SHOTS, "03-build-order.png") });

const boRows = bo.rowsA;
if (boRows > 5) {
  await page.locator("#bo .bocol.pa .borow").nth(5).click();
  await page.waitForTimeout(300);
  const jumped = await page.evaluate(() => ({
    clock: document.querySelector("#clock").textContent.trim(),
    nowA: document.querySelectorAll("#bo .bocol.pa .borow.now").length,
    nowB: document.querySelectorAll("#bo .bocol.pb .borow.now").length,
  }));
  console.log("  点行跳转 → " + JSON.stringify(jumped));
  if (jumped.nowA !== 1 || jumped.nowB !== 1) errors.push(`点行后两侧高亮数 ${jumped.nowA}/${jumped.nowB} ≠ 1/1`);
  if (jumped.clock.startsWith("00:00")) errors.push("点行未跳转时间轴");

  // 老录像（HotS 2018，Eastwatch LE）专项：译名走基础表，状态名不得泄漏。
  // 曾经 buildZhIndex 把 change 表（状态名，如「兵营落地」）放在基础表之后展平，
  // 同名键被状态名覆盖 —— 探宝一眼看到兵营行显示「兵营落地」。
  await page.click("#samples .smp:nth-child(4)");
  await page.waitForTimeout(500);
  const oldBo = await page.evaluate(() => {
    const txt = document.querySelector("#bo").innerText;
    return {
      hasBarracks: /兵营/.test(txt),
      hasStateNames: /落地|起飞/.test(txt),
      hasErrorNotes: /Error on build time|upgrade missing/.test(txt),
      hasDerelictNicknames: /火蟑螂|眼虫|三本|二本|地刺|大龙(?!塔)|毒爆(?=虫?[^发])/.test(txt),
      sample: document.querySelector("#samples .smp:nth-child(4) span")?.textContent,
    };
  });
  console.log("  老录像（HotS）→ " + JSON.stringify(oldBo));
  if (!oldBo.hasBarracks) errors.push("老录像建造顺序找不到「兵营」—— Barracks 译名链路有问题");
  if (oldBo.hasStateNames) errors.push("老录像建造顺序出现状态名（落地/起飞）—— change 表覆盖了基础表");
  if (oldBo.hasErrorNotes) errors.push("老录像建造顺序出现解析错误标注（Error on build time / upgrade missing）");
  if (oldBo.hasDerelictNicknames) errors.push("老录像建造顺序出现社区俗称（应使用正式译名）");
  await page.click('#viewSeg button[data-view="data"]');
  await page.click("#samples .smp:nth-child(1)");
  await page.waitForTimeout(400);
}

/* ---------------- 6b. 对局聊天视图 ---------------- */
step("6b", "对局聊天视图");
await page.click("#samples .smp:nth-child(2)"); // CN_ZVP：15 条真实聊天
await page.waitForTimeout(400);
await page.click('#viewSeg button[data-view="chat"]');
await page.waitForTimeout(400);
const chatState = await page.evaluate(() => ({
  rows: document.querySelectorAll("#chatList .chatrow").length,
  hasKnownText: /要干嘛/.test(document.querySelector("#chatList").innerText),
  allyTagged: document.querySelectorAll("#chatList .who em").length,
}));
console.log("  " + JSON.stringify(chatState));
if (chatState.rows !== 15) errors.push(`聊天消息 ${chatState.rows} 条 ≠ 15（CN_ZVP 基准）`);
if (!chatState.hasKnownText) errors.push("聊天视图没渲染出已知消息文本（要干嘛）");
// 点击消息 → 时间轴定位。⚠️ CN_ZVP 前 9 条都挤在开局 0s，必须点时间非零的行。
const clicked = await page.evaluate(() => {
  const rows = document.querySelectorAll("#chatList .chatrow");
  const row = rows[rows.length - 1];
  row.click();
  return { t: +row.dataset.t, text: row.querySelector(".tx")?.textContent };
});
await page.waitForTimeout(300);
const chatClock = await page.evaluate(() => document.querySelector("#clock").textContent.trim());
const mm = chatClock.match(/(\d+):(\d+)/);
const gotSec = mm ? +mm[1] * 60 + +mm[2] : -1;
console.log(`  点击「${clicked.text}」（${clicked.t}s）→ ${chatClock}`);
if (Math.abs(gotSec - clicked.t) > 2) errors.push(`点击聊天消息未定位时间轴（期望 ${clicked.t}s，得到 ${chatClock}）`);
// 空态：无聊天录像应显示占位文案
await page.click("#samples .smp:nth-child(1)"); // CN_PVT：0 条
await page.waitForTimeout(400);
const emptyChat = await page.evaluate(() => document.querySelector("#chatList").innerText);
console.log("  空态 → " + JSON.stringify(emptyChat));
if (!/没有聊天消息/.test(emptyChat)) errors.push("无聊天录像未显示空态文案");
await page.click('#viewSeg button[data-view="data"]');
await page.click("#samples .smp:nth-child(1)");
await page.waitForTimeout(300);

/* ---------------- 7. 语音播报 ---------------- */
step(7, "语音播报");
const voice = await page.evaluate(() => ({
  steps: window.__lab.voice.steps.length,
  head: window.__lab.voice.steps.slice(0, 3).map((s) => `${s.t}s ${s.text}`),
  synth: typeof speechSynthesis !== "undefined",
}));
console.log("  " + JSON.stringify(voice));
if (voice.steps === 0) errors.push("播报脚本 0 项");
await page.selectOption("#vbSpeed", "8");
await page.click("#vbPlay");
await page.waitForTimeout(1600);
const playing = await page.evaluate(() => ({
  playing: window.__lab.voice.playing,
  t: Math.round(window.__lab.state.t),
  spoken: window.__lab.voice.spoken,
  btn: document.querySelector("#vbPlay").textContent,
  cur: document.querySelector("#vbQueue .qs.cur")?.innerText.replace(/\n/g, " "),
}));
console.log("  " + JSON.stringify(playing));
if (!playing.playing || playing.spoken < 0) errors.push("播报未真正运行（playing/spoken 不对）");
if (playing.t <= 0) errors.push("播报未推进全局时间轴");
await page.screenshot({ path: join(SHOTS, "04-voice-playing.png") });
await page.click("#vbReset");
await page.waitForTimeout(200);

/* ---------------- 8. 悬浮通道 ---------------- */
step(8, "悬浮通道（组件不存在 → 应真实降级）");
const ov1 = await page.evaluate(() => ({ dot: document.querySelector("#ovDot").className, txt: document.querySelector("#ovTxt").textContent }));
console.log("  探测：" + JSON.stringify(ov1));
if (!ov1.txt) errors.push("悬浮状态区没有文案");
await page.click("#ovBtn");
await page.waitForTimeout(1800);
const ov2 = await page.evaluate(() => ({
  dot: document.querySelector("#ovDot").className,
  txt: document.querySelector("#ovTxt").textContent,
}));
console.log("  点按后：" + JSON.stringify(ov2));
if (!/画中画|组件/.test(ov2.txt)) errors.push(`悬浮按钮没有给出可理解的结果：“${ov2.txt}”`);
await page.screenshot({ path: join(SHOTS, "05-overlay.png") });

/* ---------------- 9. CSV 导出 ---------------- */
step(9, "CSV 导出（走真实下载事件，不 stub createObjectURL）");
const [download] = await Promise.all([
  page.waitForEvent("download", { timeout: 15000 }),
  page.click("#btnCsv"),
]);
const csvPath = await download.path();
const csvText = readFileSync(csvPath, "utf8");
const lines = csvText.replace(/^\uFEFF/, "").split("\n");
const cols = lines[0].split(",").length;
console.log(`  文件名 ${download.suggestedFilename()} · ${lines.length} 行 · ${cols} 列`);
console.log(`  表头 ${lines[0].slice(0, 110)}…`);
if (lines.length < 10) errors.push("CSV 行数过少");
if (cols < 20) errors.push(`CSV 列数 ${cols} 过少（应为 39×2+2）`);
if (!download.suggestedFilename().endsWith(".csv")) errors.push("下载文件名不是 .csv");

console.log(`\n截图 → ${SHOTS}`);
console.log(`预期内的探测噪声 ${expected.length} 条（本地悬浮组件不存在，属预期）`);
console.log(errors.length ? "\n!! 真错误:\n" + errors.join("\n") : "\n✅ 生产页面端到端验收全过");
await browser.close();
process.exit(errors.length ? 1 : 0);
