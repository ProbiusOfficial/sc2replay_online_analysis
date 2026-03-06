# 维护说明与项目记忆（Memory）

本文档供后期维护与 AI/人类协作者快速恢复上下文使用。

---

## 1. 项目定位

- **ReplayAnalysis** 是根项目，核心是 **sc2reader**（解析《星际争霸 II》录像的 Python 库）。
- **sc2replay_online_analysis** 是本仓库内的**子项目**：提供「在线查看 SC2 录像建造顺序」的 Web 能力，包含两种形态：
  - **后端版**：FastAPI 提供 `/api/parse`，前端上传 `.SC2Replay`，服务端用 sc2reader 解析并返回双方建造顺序。
  - **纯前端版（Pyodide）**：单页 HTML，在浏览器里用 Pyodide 跑 Python + sc2reader，适合部署到 GitHub Pages，无需自建后端。

---

## 2. 目录结构（sc2replay_online_analysis）

| 路径 | 说明 |
|------|------|
| `server.py` | 后端入口：FastAPI 应用，挂载 `static/`，根路径返回 `static/index.html`。建造顺序逻辑在 `extract_build_order(replay)`。 |
| `static/index.html` | 调用后端 **API** 的前端页（上传文件到 `/api/parse`）。 |
| `static-pyodide/index.html` | **纯前端** Pyodide 版，与根目录 `index.html` 内容一致，便于在本目录内开发。 |
| `index.html` | 纯前端入口：用于 GitHub Pages 或本地 `python -m http.server` 根路径访问。 |
| `requirements.txt` | 后端依赖：fastapi、uvicorn、python-multipart。 |
| `README.md` | 使用说明（两种方式、本地运行、部署）。 |
| `MAINTENANCE.md` | 本维护说明与记忆要点。 |

---

## 3. 运行方式

- **后端**：必须在**项目根目录**（ReplayAnalysis）下启动，以便 `import sc2reader` 能解析到根项目。
  ```bash
  cd <ReplayAnalysis 根目录>
  pip install -r sc2replay_online_analysis/requirements.txt
  python -m uvicorn sc2replay_online_analysis.server:app --reload --host 127.0.0.1 --port 8000
  ```
- **纯前端**：不能用 `file://` 打开（CORS/加载会失败），需用 HTTP：
  ```bash
  cd sc2replay_online_analysis
  python -m http.server 8080
  ```
  然后访问 `http://localhost:8080`（根路径即 `index.html`）。

---

## 4. 建造顺序逻辑（两处需对齐）

- **后端**：`server.py` 中的 `extract_build_order(replay)`。
- **纯前端**：`index.html` / `static-pyodide/index.html` 里的内联 Python 字符串 **`PARSE_SCRIPT`**（与 server 端逻辑一致）。
- **维护注意**：修改「排除单位、时间/人口计算、队伍/玩家遍历」等规则时，两处必须一起改，否则后端版与纯前端版结果会不一致。

---

## 5. Pyodide 相关要点（纯前端版）

- **sc2reader**：通过 `micropip.install('sc2reader', deps=False)` 安装（`deps=False` 避免拉取不可用依赖）。
- **mpyq**：Pyodide 没有 mpyq 的 wheel，不能靠 micropip 安装。当前做法：
  1. 用 JS `fetch` 拉取：`https://cdn.jsdelivr.net/gh/eagleflo/mpyq@master/mpyq.py`
  2. `pyodide.FS.mkdirTree('/tmp')`，`pyodide.FS.writeFile('/tmp/mpyq.py', new TextEncoder().encode(mpyqCode))`
  3. 在 Python 里 `sys.path.insert(0, "/tmp")` 后 `import mpyq`
  4. 再执行 `micropip.install('sc2reader', deps=False)`。
- 若将来 Pyodide 或 mpyq 提供官方 wheel，可考虑改为 micropip 安装并删掉上述注入逻辑。

---

## 6. GitHub Pages 部署

- 使用 **sc2replay_online_analysis** 目录下的 **根目录 `index.html`** 作为站点入口（即与 `static-pyodide/index.html` 相同的那份）。
- 若仓库 Pages 配置为「从分支的某文件夹发布」，把该文件夹指向 `sc2replay_online_analysis` 即可；或把本目录内容复制到仓库的 `docs` 等用于 Pages 的目录。
- 更新纯前端功能时：改 `static-pyodide/index.html` 后，记得同步复制到根目录 `index.html`，以更新线上版本。

---

## 7. 与根项目 docs/ 的关系

- 根目录下的 **`docs/`** 还包含 sc2reader 的 **Sphinx 文档**（如 `docs/source/`、Makefile 等），**不要**把整份 docs 挪进 sc2replay_online_analysis。
- 此前放在 `docs/index.html` 的「我们做的」Pyodide 入口已迁到 **sc2replay_online_analysis/index.html**；若仍希望用 GitHub Pages 从 `docs` 发布，可在 `docs` 下保留一份指向或复制自 `sc2replay_online_analysis/index.html` 的入口，由维护者自行决定。

---

## 8. 小结（Memory 要点）

- 子项目名：**sc2replay_online_analysis**，所有 Web 相关文件集中在此目录。
- 后端入口：`server.py`；静态入口：`static/index.html`（后端用）、根目录 `index.html` / `static-pyodide/index.html`（纯前端用）。
- 建造顺序逻辑：**server.py 的 `extract_build_order`** 与 **前端 `PARSE_SCRIPT`** 需保持同步。
- 纯前端必须 HTTP 打开；mpyq 在 Pyodide 下通过 CDN 注入到 `/tmp` 再 `import`，sc2reader 用 micropip 且 `deps=False`。
- 后端必须在 ReplayAnalysis 根目录启动；前端可在 sc2replay_online_analysis 目录下 `http.server` 或部署到 Pages。
