/**
 * 模块可达性分析 —— 决定哪些前端文件是「死代码」。
 *
 * 为什么要脚本而不是肉眼判断：ES Module 的入口是 index.html 的
 * `<script type="module" src>`，然后靠 import 图扩散；而 Worker 是**字符串路径**
 * （`new Worker("js/worker/parse.worker.js")`），不在 import 图里，必须单独接上。
 * 手动列清单容易漏掉这种间接依赖（例如 errors_init → format_utils → ...）。
 *
 * 从入口出发走一遍，**闭包外的 .js/.ts 才是可安全删除的**。
 *
 *   node scripts/analyze-module-reachability.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

/** 收集要扫描的 HTML 入口（按当前站点实际引用的页面）。 */
const HTML_ENTRIES = readdirSync(REPO).filter((f) => f.endsWith(".html"));

/** 解析一个文件里所有静态依赖（import / export-from / 动态 import / Worker / HTML src）。 */
function depsOf(file) {
  const src = readFileSync(file, "utf8");
  const out = new Set();
  const isHtml = file.endsWith(".html");

  if (isHtml) {
    for (const m of src.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) out.add(m[1]);
    for (const m of src.matchAll(/<link[^>]+href=["']([^"']+\.css)["']/g)) out.add(m[1]);
    return [...out];
  }

  // import ... from "x" / import("x") / export ... from "x"
  for (const m of src.matchAll(/(?:^|\s)(?:import|export)\s[^;'"]*?from\s*["']([^"']+)["']/gm)) out.add(m[1]);
  for (const m of src.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) out.add(m[1]);         // 副作用导入
  for (const m of src.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) out.add(m[1]);    // 动态导入
  // Worker / SharedWorker 的字符串路径（这是 import 图抓不到的一类）
  for (const m of src.matchAll(/new\s+(?:Shared)?Worker\s*\(\s*["']([^"']+)["']/g)) out.add(m[1]);
  // `new URL("./x.js", import.meta.url)` —— Worker 常这么建；这是最容易漏的一条边，
  // 漏掉会把整个 js/worker/** 误判成死代码。
  for (const m of src.matchAll(/new\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)) out.add(m[1]);
  return [...out];
}

/**
 * 把模块路径解析成**一组**文件。
 *
 * 一个「模块」在磁盘上可能是两个文件：`x.ts`（源码，入仓）与 `x.js`（tsc 产物，
 * 站点真正加载的，也入仓）。两者必须同生共死 —— 只删 `.js` 会让源码失去产物，
 * 只删 `.ts` 会让下次编译无从下手。所以图的节点是「模块组」而不是文件。
 */
function resolveModule(absPath, fromFile) {
  const base = absPath.startsWith("/") ? join(REPO, absPath) : resolve(dirname(fromFile), absPath);
  const stem = base.replace(/\.(js|ts)$/, "");
  const group = [];
  for (const ext of [".js", ".ts", ".css", ".html"]) {
    const p = stem + ext;
    if (existsSync(p) && statSync(p).isFile()) group.push(p);
  }
  // 无扩展名或非 JS 后缀的资源（例如 .json/.wasm）按原路径找
  if (!group.length && existsSync(base) && statSync(base).isFile()) group.push(base);
  return group;
}

const reachable = new Set();
const missing = [];
const queue = [];

for (const html of HTML_ENTRIES) queue.push(join(REPO, html));
while (queue.length) {
  const f = queue.shift();
  if (reachable.has(f)) continue;
  if (!existsSync(f)) { missing.push(f); continue; }
  reachable.add(f);
  for (const d of depsOf(f)) {
    const group = resolveModule(d, f);
    if (!group.length) { if (!/^https?:|^data:/.test(d)) missing.push(`${relative(REPO, f)} → ${d}`); continue; }
    queue.push(...group);
  }
}

/** 扫描 js/ 下所有 .js/.ts，与闭包求差。 */
function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(js|ts)$/.test(name) && !name.endsWith(".d.ts")) acc.push(p);
  }
  return acc;
}

const all = walk(join(REPO, "js"));
const dead = all.filter((f) => !reachable.has(f)).sort();
const live = all.filter((f) => reachable.has(f)).sort();

const rel = (f) => relative(REPO, f).replace(/\\/g, "/");
console.log(`入口 HTML：${HTML_ENTRIES.join(" / ")}`);
console.log(`\n=== 可达模块（${live.length}）===`);
for (const f of live) console.log("  ✓ " + rel(f));
console.log(`\n=== 不可达（候选删除，${dead.length}）===`);
for (const f of dead) console.log("  ✗ " + rel(f));
if (missing.length) {
  console.log(`\n=== 解析不到的引用（${missing.length}）===`);
  for (const m of missing) console.log("  ? " + m);
}
console.log(
  `\n结论：js/ 下共 ${all.length} 个模块，可达 ${live.length}，不可达 ${dead.length}` +
    (dead.length ? ` → 可删 ${dead.reduce((s, f) => s + statSync(f).size, 0) / 1024 | 0}KB` : ""),
);
