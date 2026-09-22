/**
 * 布局诊断：底部播报条、页面主体、录像列表侧边栏三者的几何关系。
 *
 * 起因（探宝反馈「显示位置异常，不一定在底部和居中」）：
 *   `.vb` 原先是 `position:fixed;left:0;right:0` 且自己是 flex 容器 —— 内容从
 *   **视口左缘**起排，而主体 `.wrap` 是 max-width:1600px 居中，于是宽屏上两者错位。
 *
 * 判据（都必须是「滚到页面最底」时测，否则量到的是中途状态）：
 *   1. 贴底        .vb 的 bottom == 视口高
 *   2. 同宽居中    .vbin 的内容左边缘 == .wrap 的内容左边缘（差 0）
 *   3. 不遮挡      footer / .rail / .side 的 bottom ≤ .vb 的 top
 *   4. 不换行      .vbin 的直接子元素垂直方向只有 1 行（数 offsetTop 的唯一值）
 *   5. 侧边栏生效  .samples 为竖排且可滚动，宽度等于规格
 *
 * 用法：node scripts/research/probe-layout.mjs   （需要 8123 端口有 HTTP 服务）
 */
import { chromium } from "/Users/macmini/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs";
import { join } from "node:path";

const URL = "http://127.0.0.1:8123/";
const REPO = "/Users/macmini/sc2rep/sc2replay_online_analysis/";
const SAMPLES = ["sampleTest/US_TVP.SC2Replay", "sampleTest/CN_ZVP.SC2Replay", "sampleTest/CN_PVT_T-AI.SC2Replay"];

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});

async function measure(width, height, withData) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(URL, { waitUntil: "load" });
  await page.waitForTimeout(300);

  if (withData) {
    await page.setInputFiles("#fileInput", SAMPLES.map((s) => join(REPO, s)));
    await page.waitForFunction(() => document.querySelector("#result")?.classList.contains("on"), { timeout: 40000 });
    await page.waitForTimeout(600);
  }

  // 关键：所有判据都在「滚到最底」时测
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(450);

  const m = await page.evaluate(() => {
    const R = (el) => (el ? el.getBoundingClientRect() : null);
    const round = (v) => Math.round(v);
    const contentLeft = (el) => {
      if (!el) return null;
      return round(el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft));
    };

    const wrap = document.querySelector(".wrap");
    const vbin = document.querySelector(".vbin");
    const vb = document.querySelector("#vb");
    const footer = document.querySelector("footer");
    const rail = document.querySelector(".rail");
    const samples = document.querySelector("#samples");
    const side = document.querySelector("#side");
    const vbr = R(vb);

    /**
     * 元素底边低于播报条顶边多少 → 被遮的像素数（≤0 表示没被遮）。
     *
     * 用**内容盒**底边（扣掉自身 padding-bottom）：页脚自己带一圈 padding 当底部留白，
     * 那圈留白本来就落在条后面（是空白，看不见），真正要保证的是**文字**不被遮。
     * 若留白规则失效，内容盒底边就等于文档底，这个判据照样会失败 —— 仍然有效。
     */
    const coveredBy = (el) => {
      const r = R(el);
      if (!r || r.height === 0) return null;
      const padB = parseFloat(getComputedStyle(el).paddingBottom) || 0;
      return round(r.bottom - padB - vbr.top);
    };

    return {
      viewport: { w: innerWidth, h: innerHeight },
      vbBottom: round(vbr.bottom),
      vbTop: round(vbr.top),
      vbH: round(vbr.height),
      // 数「行」必须用**元素中心线**：.vbin 是 align-items:center，同一行里高度不同的
      // 子元素 offsetTop 本来就各不相同 —— 用 offsetTop 会把 1 行误判成 4 行（踩过）。
      vbLines: vbin
        ? new Set(
            [...vbin.children]
              .filter((e) => e.offsetHeight > 0)
              .map((e) => {
                const r = e.getBoundingClientRect();
                return Math.round(r.top + r.height / 2);
              }),
          ).size
        : null,
      wrapContentLeft: contentLeft(wrap),
      vbinContentLeft: contentLeft(vbin),
      covered: {
        footer: coveredBy(footer),
        rail: coveredBy(rail),
        side: coveredBy(side),
        samples: coveredBy(samples),
      },
      railW: rail ? round(rail.getBoundingClientRect().width) : null,
      railStatic: rail ? getComputedStyle(rail).position : null,
      samplesDir: samples ? getComputedStyle(samples).flexDirection : null,
      // 判「可滚动」要看**溢出策略**，不是看当前是否溢出 —— 3 份录像放得下时
      // scrollHeight 本来就不该超过 clientHeight（第一版在这里误报过）。
      samplesOverflowY: samples ? getComputedStyle(samples).overflowY : null,
      samplesCount: samples ? samples.children.length : 0,
      vbhVar: getComputedStyle(document.documentElement).getPropertyValue("--vbh").trim() || "(未设)",
      docH: document.documentElement.scrollHeight,
      scrollY: round(scrollY),
      atBottom: Math.abs(scrollY + innerHeight - document.documentElement.scrollHeight) <= 2,
      errs: [],
    };
  });
  await page.close();
  return { ...m, errs };
}

function report(tag, m, withData) {
  const align = m.vbinContentLeft != null && m.wrapContentLeft != null ? m.vbinContentLeft - m.wrapContentLeft : null;
  const problems = [];
  if (m.vbBottom !== m.viewport.h) problems.push(`条未贴底(${m.vbBottom}≠${m.viewport.h})`);
  if (align !== 0) problems.push(`对齐差 ${align}px`);
  // 「条占两行」只作信息、不算失败：--vbh 会跟着实测高度走，布局已自适应；
  // 窄屏上队列里有真实文字时本来就需要更多宽度。
  if (m.atBottom) {
    for (const [k, v] of Object.entries(m.covered)) {
      if (v != null && v > 0) problems.push(`${k} 被遮 ${v}px`);
    }
  } else problems.push("未能滚到底，遮挡判据不可信");
  if (withData && m.viewport.w > 1180) {
    if (m.samplesDir !== "column") problems.push(`列表方向 ${m.samplesDir}`);
    if (m.samplesOverflowY !== "auto") problems.push(`列表溢出策略 ${m.samplesOverflowY}（应为 auto）`);
  }
  if (m.errs.length) problems.push(`页面错误 ${m.errs[0]}`);

  console.log(
    `  ${tag.padEnd(14)} 条 h=${String(m.vbH).padStart(2)} 行=${m.vbLines}` +
      ` | 对齐差 ${String(align).padStart(4)}px` +
      ` | 侧栏 ${String(m.railW).padStart(3)}px/${m.railStatic}` +
      ` | 列表 ${m.samplesDir}/overflow:${m.samplesOverflowY}${m.samplesCount ? `×${m.samplesCount}` : ""}` +
      ` | --vbh=${m.vbhVar.padEnd(5)}` +
      ` | ${problems.length ? "⚠️ " + problems.join(" · ") : "✓"}`,
  );
  return problems.length;
}

let bad = 0;
console.log("=== 一、空态（未加载录像）===");
for (const [w, h] of [[1280, 900], [1600, 900], [1920, 1080], [2560, 1440], [1024, 768]]) {
  bad += report(`${w}×${h}`, await measure(w, h, false), false);
}

console.log("\n=== 二、加载 3 份录像（有数据）===");
for (const [w, h] of [[1280, 900], [1600, 900], [1920, 1080], [2560, 1440], [1024, 768]]) {
  bad += report(`${w}×${h}`, await measure(w, h, true), true);
}

await browser.close();
console.log(bad ? `\n⚠️ ${bad} 处问题` : "\n✅ 全部通过");
process.exit(bad ? 1 : 0);
