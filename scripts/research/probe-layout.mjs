/**
 * 布局诊断：录像列表侧栏（.rail）、嵌在其中的播报面板（#vb）、页面主体（.wrap）的几何关系。
 *
 * 历史（探宝反馈「显示位置异常，不一定在底部和居中」）：
 *   `.vb` 原先是 `position:fixed;left:0;right:0` 且自己是 flex 容器 —— 内容从
 *   **视口左缘**起排，而主体 `.wrap` 是 max-width:1600px 居中，宽屏上两者错位（1920 屏 142px）。
 *
 * 现状（2026-09 底栏重做，提交 9b448f7）：横跨视口的固定条已经没了，播报面板改成嵌在
 * **.rail 侧栏内部**的一块面板（`#vb` 是 `.rail` 的后代）。所以旧的四条判据
 * （条贴视口底 / .vbin 与 .wrap 左缘对齐 0 / --vbh 底部留白 / 被条遮挡）**整批作废** ——
 * lab.css 里留了台账：「条没了，留白回到定义系统里的 26px，--vbh 也不再需要」。
 *
 * 现在要守的是：
 *   1. 归属      #vb 必须是 .rail 的后代（不再横跨视口）
 *   2. 不越界    滚到页面最底时，面板整块落在视口内（仅宽屏；≤1180 时面板退回正文下方的单列整宽块，
 *                滚到最底它本来就在视口上方 —— 那时只守「不漏出视口宽」）
 *   3. 不裁剪    .rail 是 overflow:hidden 的吸顶容器 —— 面板底边不得低于 .rail 底边
 *   4. 吸顶      侧栏 sticky、宽 236、底边不超出视口
 *   5. 侧边栏    .samples 竖排 + overflow:auto（仅在 >1180 宽时）
 *   6. 空态      #result 隐藏时整块不占位（#vb / .rail 尺寸均为 0）
 *   7. 无横向溢出（新布局的兜底判据，替代作废的「被底栏遮挡」）
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

  // 关键：所有几何判据都在「滚到最底」时测 —— 否则量到的是中途状态
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(450);

  const m = await page.evaluate(() => {
    const R = (el) => (el ? el.getBoundingClientRect() : null);
    const round = (v) => Math.round(v);

    const vb = document.querySelector("#vb");
    const rail = document.querySelector(".rail");
    const samples = document.querySelector("#samples");
    const vbr = R(vb);
    const railr = R(rail);

    return {
      viewport: { w: innerWidth, h: innerHeight },
      vbH: round(vbr.height),
      vbW: round(vbr.width),
      vbTop: round(vbr.top),
      vbBottom: round(vbr.bottom),
      vbInsideRail: !!rail && rail.contains(vb),
      railW: railr ? round(railr.width) : null,
      railBottom: railr ? round(railr.bottom) : null,
      railStatic: rail ? getComputedStyle(rail).position : null,
      railOverflow: rail ? getComputedStyle(rail).overflowY : null,
      samplesDir: samples ? getComputedStyle(samples).flexDirection : null,
      // 判「可滚动」要看**溢出策略**，不是看当前是否溢出 —— 3 份录像放得下时
      // scrollHeight 本来就不该超过 clientHeight（第一版在这里误报过）。
      samplesOverflowY: samples ? getComputedStyle(samples).overflowY : null,
      samplesCount: samples ? samples.children.length : 0,
      hOverflow: round(document.documentElement.scrollWidth - innerWidth),
      atBottom: Math.abs(scrollY + innerHeight - document.documentElement.scrollHeight) <= 2,
      errs: [],
    };
  });
  await page.close();
  return { ...m, errs };
}

function report(tag, m, withData) {
  const problems = [];
  if (!withData) {
    // 空态：#result 整块不占位，面板与侧栏都不该有尺寸
    if (m.vbH !== 0) problems.push(`空态下面板仍有高度 ${m.vbH}px（#result 应整块隐藏）`);
    if (m.railW !== 0) problems.push(`空态下侧栏仍有宽度 ${m.railW}px（#result 应整块隐藏）`);
  } else {
    // 宽屏：播报面板嵌在 sticky 侧栏里，两条边界都要守
    if (!m.vbInsideRail) problems.push("#vb 不在 .rail 内（底栏重做后应嵌在侧栏里）");
    if (m.railBottom != null && m.railBottom > m.viewport.h + 1) {
      problems.push(`侧栏底边越出视口 ${m.railBottom - m.viewport.h}px`);
    }
    // .rail 是 overflow:hidden —— 面板比它高就会被静默裁掉，而「算矩形重叠」量不出这种裁切
    if (m.railBottom != null && m.vbBottom > m.railBottom + 1) {
      problems.push(`面板被 .rail 的 overflow:hidden 裁掉 ${m.vbBottom - m.railBottom}px`);
    }
    if (!m.atBottom) problems.push("未能滚到底，几何判据不可信");
    if (m.hOverflow > 1) problems.push(`页面横向溢出 ${m.hOverflow}px`);
    if (m.viewport.w > 1180) {
      if (m.vbTop < 0 || m.vbBottom > m.viewport.h + 1) {
        problems.push(`滚到最底时面板越出视口(top=${m.vbTop} bottom=${m.vbBottom} h=${m.viewport.h})`);
      }
      if (m.railW !== 236) problems.push(`侧栏宽 ${m.railW}≠236`);
      if (m.railStatic !== "sticky") problems.push(`侧栏未吸顶(${m.railStatic})`);
      if (m.samplesDir !== "column") problems.push(`列表方向 ${m.samplesDir}`);
      if (m.samplesOverflowY !== "auto") problems.push(`列表溢出策略 ${m.samplesOverflowY}（应为 auto）`);
    } else {
      // 窄屏（≤1180）：面板退回正文下方的**单列整宽块**，不再嵌在吸顶侧栏里 ——
      // 滚到最底时它本来就落在视口上方，所以这里不判「在视口内」，只守不漏出视口宽。
      if (!m.vbInsideRail) problems.push("窄屏下 #vb 脱离了 .rail");
      if (m.vbW > m.viewport.w + 1) problems.push(`窄屏下面板宽 ${m.vbW} 超出视口 ${m.viewport.w}`);
      if (m.samplesDir !== "row") problems.push(`窄屏列表应横排，实测 ${m.samplesDir}`);
    }
  }
  if (m.errs.length) problems.push(`页面错误 ${m.errs[0]}`);

  console.log(
    `  ${tag.padEnd(14)} 面板 ${String(m.vbW).padStart(3)}×${String(m.vbH).padStart(3)}` +
      ` y=${String(m.vbTop).padStart(5)}→${String(m.vbBottom).padStart(5)}` +
      ` 侧栏内=${m.vbInsideRail ? "是" : "否"}` +
      ` | 侧栏 ${String(m.railW).padStart(3)}px/${m.railStatic}/${m.railOverflow}` +
      ` | 列表 ${m.samplesDir}/overflow:${m.samplesOverflowY}${m.samplesCount ? `×${m.samplesCount}` : ""}` +
      ` | 横向溢出 ${m.hOverflow}px` +
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
