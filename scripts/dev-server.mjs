// 开发静态服务器 —— 与 `python -m http.server` 唯一的差别:所有响应带 `Cache-Control: no-store`。
//
// 为什么需要它:python SimpleHTTP 不发缓存头,浏览器对 js 模块(尤其 **module Worker 的
// 依赖图**)走启发式缓存,改完代码刷新页面时 worker 可能仍跑旧模块 —— 表现为主线程
// 的新文案已生效、worker 侧的新字段(如 players[].chronos)却缺席,极难排查。
//
//   node scripts/dev-server.mjs            # http://127.0.0.1:8123/index.html
//   PORT=9000 node scripts/dev-server.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// fileURLToPath 对目录给出带尾分隔符的形式,统一剥掉再做前缀比较(Windows 上 \ )
const ROOT_CMP = ROOT.endsWith(sep) ? ROOT.slice(0, -sep.length) : ROOT;
const PORT = Number(process.env.PORT || 8123);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".SC2Replay": "application/octet-stream",
};

createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://localhost");
    let p = normalize(join(ROOT, decodeURIComponent(u.pathname)));
    if (!p.startsWith(ROOT_CMP + sep) && p !== ROOT_CMP) {
      res.writeHead(403);
      return res.end("forbidden");
    }
    if (u.pathname === "/" || u.pathname.endsWith("/")) p = join(p, "index.html");
    const data = await readFile(p);
    res.writeHead(200, {
      "Content-Type": MIME[extname(p).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`dev server (no-store) → http://127.0.0.1:${PORT}/index.html`);
});
