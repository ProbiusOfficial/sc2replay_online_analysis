// 一次性工具：把原型模板里的设计系统整段提取成生产用的 css/lab.css。
//
// 为什么用脚本而不是手抄：原型里的 <style> 块是已经过 3 轮真实渲染验收的设计系统，
// 手抄会引入无法察觉的偏差（少一个 var、少一条 hover）。提取是逐字节等价的。
//
//   node scripts/extract-lab-css.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const SRC = join(REPO, "prototype/data-lab.template.html");
const DEST = join(REPO, "css/lab.css");

const html = readFileSync(SRC, "utf8");
const start = html.indexOf("<style>");
const end = html.indexOf("</style>");
if (start < 0 || end < 0) throw new Error("在模板里找不到 <style> 块");
const block = html.slice(start + "<style>".length, end).trim();

const header = `/* ============================================================================
   录像数据分析台 · 样式
   ⚠️ 本文件由 scripts/extract-lab-css.mjs 从 prototype/data-lab.template.html
      的 <style> 块**逐字节提取**，再追加「运行态外壳」一节。
      改样式请改这里（提取只在原型与生产需要重新对齐时才跑一次）。

   设计系统速览：
     浅色主题；--a 红 = 玩家 A、--b 蓝 = 玩家 B（中国习惯：涨红跌绿）；
     图表与时间轴共用一个全局游标 S.t；所有卡片都由 syncCursor() 驱动刷新。
   ============================================================================ */

`;

// 原型里没有的：真实页面才需要的「运行态外壳」（初始化 / 拖放 / 解析中 / 错误 / 录像列表）
const shell = `

/* ==========================================================================
   运行态外壳（原型里没有，真实页面才有）
   ========================================================================== */

/* 主结果区：没数据时整块不占位（语音条也在里面，靠这条一起隐藏） */
#result{display:none}
#result.on{display:block}

/* --------------------------------------------------------------------------
   底部播报条：内层与主体同宽、居中
   --------------------------------------------------------------------------
   原型里 .vb 自己就是 flex 容器，内容从**视口左缘**起排；而主体 .wrap 用的是
   max-width:1600px + margin:0 auto。两者只有在视口 ≤1636px 时才碰巧对齐 ——
   1920 屏上条内容比主体左边缘偏 142px、2560 屏偏 462px（实测）。
   拆成两层：.vb 只画「横跨视口的背景 + 分隔线」，.vbin 负责排版并与 .wrap 严格对齐。 */
.vb{display:block;padding:0}
.vbin{display:flex;align-items:center;gap:14px;flex-wrap:wrap;
      max-width:1600px;margin:0 auto;padding:9px 18px}

/* 底部留白跟随播报条**实测高度**：窄屏它会换行变高，写死 84px 就会被压住。
   --vbh 由 js/lab/main.js 的 ResizeObserver 写入，加在**文档最后一个元素**（页脚）上。
   ⚠️ 不能写成 body{padding-bottom} —— 本文件里有 html,body{height:100%}，body 的
   content box 被固定成视口高，超出的内容会**穿过** padding 区域，那条 padding
   不产生任何滚动空间（实测页脚仍被条盖住 69px）。
   margin 同样不可靠：末尾元素的下外边距不计入 scrollHeight。 */
.wrap{padding-bottom:26px}
.pagefoot{max-width:1600px;margin:0 auto;color:var(--ink4);font-size:11.5px;line-height:1.9;
          padding:0 18px calc(var(--vbh,84px) + 24px)}
.pagefoot a{color:var(--accent)}
.pagefoot code{font-family:var(--mono)}
/* 内部指标侧栏同理：原规则只扣了顶部，没扣底部条，会钻到条下面去 */
.side{max-height:calc(100vh - var(--vbh,84px) - 96px)}

/* --------------------------------------------------------------------------
   录像列表侧边栏
   --------------------------------------------------------------------------
   宽度取 236px，与内部「指标分组」侧栏（.side）同宽，两条竖栏对齐。
   窄屏（≤1180px）退回顶部横排，避免挤压图表。 */
.layout{display:grid;grid-template-columns:236px minmax(0,1fr);gap:16px;align-items:start;margin-top:14px}
.rail{display:flex;flex-direction:column;gap:8px;min-height:0;
      position:sticky;top:64px;max-height:calc(100vh - var(--vbh,84px) - 92px)}
.rail .railhead{margin:0;flex-wrap:wrap}
.rail .railhead .grow{flex:0 0 100%;height:0}         /* 强制提示文字独占一行 */
.rail .railhead .lab{font-size:10px;white-space:normal;line-height:1.5}
.rail .samples{display:flex;flex-direction:column;gap:6px;flex:1;min-height:0;
               overflow-y:auto;overflow-x:hidden;padding:0 3px 2px 0}
.rail .smp{flex:0 0 auto;width:100%;min-width:0}
.rail .smp b,.rail .smp span{max-width:none}
.rail .smp b{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;
             white-space:normal;overflow-wrap:anywhere;overflow:hidden}

@media (max-width:1180px){
  .layout{grid-template-columns:minmax(0,1fr)}
  .rail{position:static;max-height:none}
  .rail .railhead{margin:12px 0 0}
  .rail .railhead .grow{flex:1;height:auto}
  .rail .samples{flex-direction:row;overflow-x:auto;overflow-y:visible;padding:12px 0 0}
  .rail .smp{width:auto;min-width:190px}
  .rail .smp b{display:block;white-space:nowrap;max-width:230px}
  /* 底部条也收紧：原型里 .queue 的 min-width:280px 会把窄屏的条挤成两行（实测 126px 高） */
  .vbin{gap:10px;padding:7px 18px}
  .vb .queue{min-width:150px}
}

.shellbox{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:18px 20px}
.init-status{text-align:center;padding:26px 18px}
.init-status p{margin:0 0 6px;color:var(--ink2)}
.init-status .progress{font-family:var(--mono);font-size:12px;color:var(--ink3)}
.init-status .spinner{margin:0 auto 14px}
.spinner{width:26px;height:26px;border:2.5px solid var(--line);border-top-color:var(--accent);
         border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spinner{animation-duration:2.4s}}

.drop-zone{border:1.5px dashed var(--line3);border-radius:var(--r);padding:34px 20px;text-align:center;
           background:var(--card);cursor:pointer;transition:.15s;margin-top:12px}
.drop-zone:hover,.drop-zone.dragover,.drop-zone:focus-visible{border-color:var(--accent);background:var(--accent-soft)}
.drop-zone:focus{outline:none}
.drop-zone .icon{font-size:30px;line-height:1;margin-bottom:10px}
.drop-zone p{margin:0 0 5px;color:var(--ink2)}
.drop-zone .hint{font-size:11.5px;color:var(--ink4)}
.drop-zone input[type=file]{display:none}

.loading{display:none;align-items:center;gap:11px;justify-content:center;padding:16px;margin-top:12px;
         background:var(--card);border:1px solid var(--line);border-radius:var(--r);color:var(--ink2);font-size:12.5px}
.loading.on{display:flex}
.loading .spinner{width:16px;height:16px;border-width:2px;margin:0}

.errorbar{display:none;padding:12px 15px;margin-top:12px;border-radius:var(--r);font-size:12.5px;
          background:#fdecea;border:1px solid #f3c2bd;color:#8a2b21}
.errorbar.on{display:block}
.errorbar strong{display:block;margin-bottom:3px}

.empty{padding:34px 18px;text-align:center;color:var(--ink4);font-size:12.5px;line-height:1.9}

/* 录像列表（本地批量；砍掉共享库之后的唯一入口） */
.railhead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:12px 0 0}
.railhead .lab{font-size:11px;color:var(--ink3);font-family:var(--mono)}
.railhead .lab.err{color:#c0392b}
.railhead .grow{flex:1}
.smp{position:relative;padding-left:14px}
.smp .rule{position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--line3)}
.smp.on .rule{background:var(--accent)}
.smp .err{color:#c0392b}
.smp .busy{color:var(--warn)}
`;

// ⚠️ shell 段是**模板字符串**：正文里出现反引号会提前终止字符串，出现 `${` 会被当插值。
// 这两类错误要么编译期就崩、要么静默丢内容 —— 所以写完先断言关键规则确实落地，
// 不通过就**不写文件**（与 extract-lab-views.mjs 同一套纪律：绝不产出坏文件）。
const MUST = [
  ["#result 显隐", "#result{display:none}"],
  ["底部条外层退化为背景层", ".vb{display:block;padding:0}"],
  ["底部条内容与主体同宽居中", ".vbin{"],
  ["body 底部留白跟随 --vbh", ".pagefoot{max-width:1600px;margin:0 auto"],
  ["页脚留白用 --vbh 计算", "calc(var(--vbh,84px) + 24px)"],
  [".wrap 内容间距", ".wrap{padding-bottom:26px}"],
  ["内部侧栏扣掉底部条", ".side{max-height:calc(100vh - var(--vbh"],
  ["录像列表侧边栏两列", ".layout{display:grid;grid-template-columns:236px"],
  ["侧栏窄屏回退", "@media (max-width:1180px)"],
];

const full = header + block + shell;
const missing = MUST.filter(([, needle]) => !full.includes(needle));
if (missing.length) {
  console.error("提取结果缺少关键规则，**未写入**：");
  for (const [name, needle] of missing) console.error(`  ✗ ${name}  →  期望包含 ${needle}`);
  process.exit(1);
}

writeFileSync(DEST, full);
const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
console.log(`提取 <style> 块 ${kb(block.length)} → ${DEST}（总计 ${kb(full.length)}）`);
