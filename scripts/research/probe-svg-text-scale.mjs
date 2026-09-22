/**
 * 诊断：时间轴 / 图表 SVG 里的文字是否被非等比拉伸。
 *
 * 原理：`getScreenCTM()` 给出「SVG 用户坐标系 → 屏幕像素」的完整变换，
 * 从它的列向量取长度即得 x/y 方向的缩放因子 sx、sy。
 *   sx ≈ sy  → 等比，文字形状正常
 *   sx ≠ sy  → 非等比（通常因为 `preserveAspectRatio="none"` 且 viewBox 与实际尺寸不匹配）
 *              → 文字被横向或纵向拉扁，就是探宝报的「字体被奇怪拉伸」。
 *
 * 同时用 deviceScaleFactor=3 裁一张时间轴与一张图表的高分辨率图，肉眼复核。
 *
 * 用法：node scripts/research/probe-svg-text-scale.mjs   （需 8123 端口有 HTTP 服务）
 */
import { chromium } from "/Users/macmini/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const OUT = join(REPO, "tests", "screenshots-lab");
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});

async function inspect(viewport, label) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 3 });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto("http://127.0.0.1:8123/", { waitUntil: "load" });
  await page.waitForTimeout(300);
  await page.setInputFiles("#fileInput", [join(REPO, "sampleTest", "US_TVP.SC2Replay")]);
  await page.waitForFunction(() => document.querySelector("#result")?.classList.contains("on"), { timeout: 40000 });
  await page.waitForTimeout(900);

  const data = await page.evaluate(() => {
    /** 取一个 svg 的缩放因子与首个 text 的几何。 */
    const info = (svg, name) => {
      if (!svg) return null;
      const r = svg.getBoundingClientRect();
      const m = svg.getScreenCTM();
      const sx = m ? Math.hypot(m.a, m.b) : null;
      const sy = m ? Math.hypot(m.c, m.d) : null;
      const t = svg.querySelector("text");
      const tr = t && t.getBoundingClientRect();
      const natural = t && t.getComputedTextLength ? t.getComputedTextLength() : null;
      return {
        name,
        viewBox: svg.getAttribute("viewBox"),
        preserveAspectRatio: svg.getAttribute("preserveAspectRatio"),
        cssSize: { w: Math.round(r.width), h: Math.round(r.height) },
        scaleX: sx && +sx.toFixed(4),
        scaleY: sy && +sy.toFixed(4),
        xOverY: sx && sy ? +(sx / sy).toFixed(4) : null,
        firstText: t ? t.textContent : null,
        textRectW: tr ? +tr.width.toFixed(2) : null,
        // 用户坐标下的自然长度 × scaleX = 期望的屏幕宽度
        textExpectW: natural != null && sx ? +(natural * sx).toFixed(2) : null,
      };
    };

    return {
      tl: info(document.querySelector("#tlsvg"), "#tlsvg 时间轴"),
      tlBox: (() => {
        const el = document.querySelector("#tl");
        const cs = getComputedStyle(el);
        return { clientWidth: el.clientWidth, padding: `${cs.paddingLeft}/${cs.paddingRight}`, offsetWidth: el.offsetWidth };
      })(),
      svgBox: (() => {
        const el = document.querySelector("#tlsvg");
        const cs = getComputedStyle(el);
        return { cssWidth: cs.width, cssHeight: cs.height, inlineHeight: el.style.height };
      })(),
      charts: [...document.querySelectorAll("#charts .card")]
        .slice(0, 2)
        .map((c, i) => info(c.querySelector("svg"), `图表 ${i + 1}: ${c.querySelector(".nm")?.textContent ?? ""}`)),
    };
  });

  console.log(`\n=== ${label}（视口 ${viewport.width}×${viewport.height}）===`);
  for (const k of ["tl", "svgBox", "tlBox"]) console.log(`  ${k}: ${JSON.stringify(data[k])}`);
  for (const c of data.charts) console.log(`  ${JSON.stringify(c)}`);
  const bad = [data.tl, ...data.charts].filter((x) => x && x.xOverY != null && Math.abs(x.xOverY - 1) > 0.01);
  if (bad.length) {
    console.log(`  ⚠️ 非等比缩放（x/y ≠ 1）：`);
    for (const x of bad) console.log(`     ${x.name}  x/y = ${x.xOverY}（viewBox ${x.viewBox}，实际 ${x.cssSize.w}×${x.cssSize.h}）`);
  } else {
    console.log("  ✓ 全部等比（x/y ≈ 1）");
  }
  if (errs.length) console.log(`  !! 页面错误：${errs[0]}`);

  // 高分辨率裁图，肉眼复核文字
  const tlBox = await page.locator("#tl").boundingBox();
  await page.screenshot({
    path: join(OUT, `tl-text-${label}.png`),
    clip: { x: tlBox.x, y: tlBox.y, width: tlBox.width, height: tlBox.height + 24 },
  });
  const card = await page.locator("#charts .card").first().boundingBox();
  await page.screenshot({
    path: join(OUT, `chart-text-${label}.png`),
    clip: { x: card.x, y: card.y, width: card.width, height: Math.min(card.height, 320) },
  });
  await page.close();
  return bad.length;
}

let bad = 0;
bad += await inspect({ width: 1600, height: 1100 }, "1600");
bad += await inspect({ width: 1920, height: 1080 }, "1920");
bad += await inspect({ width: 1280, height: 900 }, "1280");

await browser.close();
console.log(bad ? `\n⚠️ ${bad} 处非等比缩放` : "\n✅ 无文字拉伸");
process.exit(bad ? 1 : 0);
