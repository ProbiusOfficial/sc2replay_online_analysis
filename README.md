# StarCraft II Replay Analysis - Online（在线分析）

基于 sc2reader 的网页版星际争霸 II 录像建造顺序查看工具。拖入 `.SC2Replay` 文件即可查看双方建造顺序。

## 两种使用方式

### 方式一：纯前端（推荐，可部署 GitHub Pages）

无需后端，解析在浏览器内完成，文件不会上传到任何服务器。

**本地预览：**

> ⚠️ **不要直接双击打开 index.html**（`file://` 协议会导致 CORS 错误）。必须通过本地 HTTP 服务器访问。

```bash
# 在本目录（或 static-pyodide）下启动静态服务器：
cd sc2replay_online_analysis
python -m http.server 8080
# 或
npx serve .
```

然后访问 http://localhost:8080（根目录 `index.html` 即纯前端入口）

**部署到 GitHub Pages：**

1. 使用本目录根下的 `index.html` 作为站点入口（与 `static-pyodide/index.html` 相同）
2. 在 GitHub 仓库 **Settings → Pages** 中：
   - **Source** 选择 "Deploy from a branch"
   - **Branch** 选 `main`（或你的默认分支）
   - **Folder** 选 `sc2replay_online_analysis`（或把该目录内容放到仓库 `docs` 等用于 Pages 的目录）
3. 保存后等待 1–2 分钟，访问对应 Pages 地址即可使用

> 若修改了 `static-pyodide/index.html`，需同步复制到根目录 `index.html` 以更新线上版本。

**技术说明：** 使用 Pyodide 在浏览器中运行 Python，通过 micropip 安装 sc2reader；mpyq 需通过 CDN 注入（见 MAINTENANCE.md）。首次加载约 5–10 秒（下载 Python 运行时），之后会缓存。

---

### 方式二：Python 后端

需要本地运行 Python 服务（依赖项目根目录的 sc2reader）。

1. 安装依赖（在项目根目录或本目录）：

```bash
pip install -r sc2replay_online_analysis/requirements.txt
```

2. 启动服务（**必须在项目根目录 ReplayAnalysis 下**，以便 `import sc2reader`）：

```bash
cd C:\Users\admin\Desktop\ReplayAnalysis
python -m uvicorn sc2replay_online_analysis.server:app --reload --host 127.0.0.1 --port 8000
```

3. 在浏览器中打开 http://127.0.0.1:8000

## 功能

- 拖放上传录像文件
- 显示地图名称与游戏时长
- 并排展示双方建造顺序
- 每项显示：游戏内时间、人口、单位/建筑名称

## 目录结构

- `server.py` — 后端 API（FastAPI），挂载 `static/`，根路径返回 `static/index.html`
- `static/index.html` — 调用后端 `/api/parse` 的前端页面
- `static-pyodide/index.html` — 纯前端 Pyodide 版（与根目录 `index.html` 一致，便于本地开发）
- `index.html` — 纯前端入口，用于 GitHub Pages 或本地 `http.server` 根路径
- `requirements.txt` — 后端依赖
- `MAINTENANCE.md` — 维护说明与记忆要点

## 技术栈

- **纯前端版**：Pyodide + sc2reader（浏览器内 Python）
- **后端版**：FastAPI + sc2reader
- 前端：原生 HTML/CSS/JS
