# 路线 C 实施计划：WASM 解析重构 + 小地图可视化

> 本文档是**自包含的开发交接文件**。在 macOS 上 clone 仓库后，仅凭本文件即可开工，不需要会话上下文。
>
> - 仓库：`https://github.com/ProbiusOfficial/sc2replay_online_analysis`
> - 文档版本：2026-09-21
> - 适用环境：macOS（含 Xcode Command Line Tools）
> - 关联文档：`README.md`、`docs/MAINTENANCE.md`（模块职责与数据流，改动前必读）

---

## 0. 快速开始

```bash
git clone https://github.com/ProbiusOfficial/sc2replay_online_analysis.git
cd sc2replay_online_analysis
```

前端是**零构建静态站**，本地预览只需 HTTP 服务（`file://` 下 ES Module 与 `fetch("data.json")` 会失败）：

```bash
python3 -m http.server 8080
# 浏览器打开 http://127.0.0.1:8080/
```

---

## 1. 项目现状

### 1.1 这是什么

一个《星际争霸 II》录像（`.SC2Replay`）的**在线解析与共享工具**。目前是纯前端方案：用 Pyodide 在浏览器里跑 Python，加载 `sc2reader` + `spawningtool` 解析录像，输出建造顺序时间轴、聊天记录、升级与技能事件、五张 Chart.js 分析图、TTS 语音播报、批量侧栏与 TXT 导出。

核心理念是**录像不上传服务器**（`server/` 目录是一个独立的可选共享服务，不在本仓库版本控制内）。

### 1.2 当前技术栈

| 部分 | 实现 |
| --- | --- |
| 页面 | `index.html`（本地解析）、`replays.html`（共享录像库） |
| 样式 | `css/app.css` |
| 逻辑 | `js/*.js`（ES Module，入口 `js/app.js` / `js/replays_page.js`） |
| 解析 | **Pyodide**（CDN 加载）+ 运行时 `micropip` 安装 `sc2reader`、`spawningtool`；另从 `cdn.jsdelivr.net/gh/eagleflo/mpyq@master/mpyq.py` 拉取 `mpyq` |
| 解析脚本 | `js/parse_script.js`（内嵌 Python 字符串 `PARSE_SCRIPT`，由 Pyodide 执行） |
| 图表 | Chart.js 4（CDN，UMD） |
| 翻译数据 | `data.json` |
| 发布 | `.github/workflows/static.yml` 把整仓发布到 GitHub Pages |

### 1.3 当前的关键缺陷（本次重构的动因）

1. **解析阻塞主线程**：Pyodide 同步执行，大录像或多文件批量时页面冻结。
2. **冷启动成本高**：Pyodide 运行时（10MB 量级）+ 现场 `micropip` 安装两个包，首屏慢。
3. **无解析结果缓存**：同一录像重复打开要重新解析。
4. **能力上限**：没有单位位置数据，做不了小地图与轨迹可视化。
5. **无法做地形相关分析**：纯重放拿不到地图通行/高度数据（本次明确不做，见 §2.3）。

### 1.4 样本与素材

- `sampleTest/`：5 个样本录像（含 2018 年老版本录像、PVZ/PVT/ZVP、带空格的玩家名）。
- `dependence/`、`s2protocol/`：本地素材目录，**已在 `.gitignore` 中，不参与发布**。
  - `s2protocol/` 是 Blizzard 官方 Python 实现副本。注意：其中最新版本为 `protocol95299`，**已落后官方 3 个版本**（官方已到 `97563`），若引用需先更新。

---

## 2. 本次重构的决策（已确定）

### 2.1 技术路线：C-3 + C-4

**C-3（解耦）**：协议解码留在 TypeScript/JavaScript 侧并在 Web Worker 中运行；Rust/WASM **只承担计算密集部分**（位置插值、轨迹重建、热力图计算）。

> 为什么不用 Rust 直接解码：`sebosp/s2protocol-rs`（MIT，v3.5.6）实测**不适配 WASM**——`rayon` 是硬依赖（`wasm32-unknown-unknown` 无线程）、`arrow` 57 与 `arrow_convert` 在 default features 中默认启用、`include_assets` 编译期嵌入资源、且 dev-deps 含 `ratatui`/`crossterm`（定位为 CLI/桌面工具，无 WASM 目标）。硬啃需长期维护裁剪分支，不建议。
>
> 该决策的收益：**SC2 更新协议时完全不触碰 Rust 代码**。

**C-4（CI 编译）**：wasm 在 GitHub Actions 的 `ubuntu-latest` 上编译，产物随 GitHub Pages 部署。`.wasm` 与宿主 OS 无关，因此 Windows/macOS 差异不影响构建产物。

### 2.2 移除 Pyodide

方向是**最终移除 Pyodide**。

但迁移期必须保留双跑：Pyodide 路径作为**验收对照物**（见 §6 P1 的字段级 diff 门槛）。顺序必须是「新路径达标 → 再移除旧路径」，不能先删后补。P4 才执行移除。

### 2.3 小地图不做视野遮蔽

明确排除。原因：视野遮蔽需要地图的悬崖/高度/通行网格数据，纯重放文件不提供（参考竞品 starcraft2.ai 是靠服务端地图库实现的）。

P3 的范围限定为：**单位位置、军队移动轨迹、死亡位置、时间轴联动**。地图底图使用静态地图预览图。

### 2.4 本次不做（非目标）

- 不做服务端解析（不改变「录像不上传」的产品定位）。
- 不做地形/迷雾分析。
- 不引入前端构建工具链（保持零构建发布；`wasm/` 的编译产物通过 CI 生成后提交到固定路径）。
- 不重构 `css/app.css` 与现有 UI 结构。

---

## 3. 环境搭建（macOS）

```bash
# 1) Xcode Command Line Tools（Rust 编译 C 依赖需要）
xcode-select --install

# 2) Rust 工具链
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# 3) WASM 目标
rustup target add wasm32-unknown-unknown

# 4) wasm-pack（二选一）
brew install wasm-pack
# 或：cargo install wasm-pack

# 5) 可选：wasm-opt（体积优化，来自 binaryen）
brew install binaryen

# 6) 校验
rustc --version && cargo --version && wasm-pack --version
```

其他依赖：Node.js（用于 TypeScript 解码器的类型检查与单测）、Python 3（用于与官方 `s2protocol` 做对照校验）。

**macOS 相对 Windows 的差异提示**：Windows 需额外安装 Visual Studio C++ 生成工具（数 GB）才能走 MSVC 工具链，且有 260 字符路径限制；macOS 无此问题。若后续需要在 Windows 上也能编译，一律走 CI。

---

## 4. 目标架构

```
┌──────────────────────── 主线程（UI） ────────────────────────┐
│  index.html / replays.html                                    │
│  app.js · display.js · voice_reader.js · benchmarks.js  ← 保留 │
│  js/viewer/   ← 新增：小地图与轨迹渲染（Canvas 2D）            │
└──────────────────────────┬───────────────────────────────────┘
                           │ postMessage（Transferable ArrayBuffer）
┌──────────────────────────▼───────────────────────────────────┐
│  Web Worker（解析线程）                                       │
│  ├─ js/worker/decoder.ts   事件解码（MPQ + 协议）              │
│  └─ wasm/compute.wasm      位置插值 / 轨迹重建 / 热力图         │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│  IndexedDB：按 md5 缓存解析结果，免二次解析                    │
└──────────────────────────────────────────────────────────────┘
```

### 4.1 接口契约

**Worker 请求**

```ts
type ParseRequest = {
  type: "parse";
  id: string;                 // 请求 id
  md5: string;                // 用于缓存键
  buffer: ArrayBuffer;        // 已转移所有权的录像字节
};

type SkipRequest = { type: "skipCache"; id: string; md5: string };
```

**Worker 响应**

```ts
type ParseResponse =
  | { type: "ok"; id: string; md5: string; cached: boolean; data: ReplayData }
  | { type: "error"; id: string; md5: string; message: string; code?: string };
```

**`ReplayData` 必须与现有 Pyodide 路径的 `extract_replay_data` 返回值同构**（这是 P1 的验收基础）。当前字段见 `js/parse_script.js` 的 `result` 结构：`map_name`、`game_length`、`client_version`、`region`、`start_time`、`winner`、`teams[].players[]`（含 `name`、`race`、`build_order`、`worker_deaths`、`workers_curve`、`stats`）、`chat`。

### 4.2 WASM 导出（建议签名）

```rust
// 位置轨迹：把稀疏的 UnitPositionsEvent 快照 + 移动命令插值成逐秒轨迹
#[wasm_bindgen]
pub fn build_trails(positions_json: &str, commands_json: &str) -> String;

// 按时间窗口聚合的军队价值/热度，用于小地图热力图
#[wasm_bindgen]
pub fn compute_heatmap(events_json: &str, window_secs: u32) -> String;

// 轨迹包围盒与采样缩放，供 Canvas 渲染
#[wasm_bindgen]
pub fn normalize_trails(trails_json: &str, map_w: f32, map_h: f32) -> String;
```

数据交换统一走 JSON 字符串；大数组可改用 `Float32Array` + `Transferable` 以减少序列化开销。

### 4.3 IndexedDB 结构

```
DB: sc2replay
  store: replays    keyPath: md5
     { md5, parsedAt, parserVersion, data: ReplayData }
  store: meta       keyPath: key
     { key: "parserVersion", value: "1" }
```

`parserVersion` 变更时整体失效缓存（解析逻辑升级后不返回陈旧结果）。当前 `replays.html` 已有的 `localStorage` 列表缓存（`sc2ReplayLibraryCacheV1`）与解析结果缓存是两回事，不要混淆。

---

## 5. 目录规划

```
js/
  app.js                    # 入口（保留，改为调用新解析层）
  replays_page.js           # 共享库页入口（保留）
  display.js                # 结果渲染（保留，注意 §7 的时间语义）
  display_helpers.js        # 文案与排序（保留）
  format_utils.js           # 格式化（保留，时间函数需统一，见 §7）
  voice_reader.js           # 语音播报（保留）
  benchmarks.js             # 图表（保留）
  batch_rail.js             # 批量侧栏（保留）
  share_upload.js / upload_api.js / telemetry.js
  state.js / constants.js / errors_init.js
  parse_script.js           # 迁移期保留（对照用），P4 删除
  pyodide_boot.js           # 迁移期保留（降级路径），P4 删除

  worker/
    parse.worker.ts         # Worker 入口
    decoder/                # 协议解码（TS）
      mpq.ts                # MPQ 归档读取
      protocol.ts           # 协议版本表与选择
      events.ts             # tracker / game / message events 解码
      state.ts              # 单位生命周期状态机
    index.ts                # 对外 API：parseReplay(buffer, md5)

  viewer/
    minimap.ts              # 小地图渲染
    trails.ts               # 轨迹数据准备
    timeline.ts             # 与现有时间轴联动

wasm/
  Cargo.toml
  src/lib.rs
  pkg/                      # 构建产物（wasm-pack output，提交入仓供 Pages 使用）
```

---

## 6. 分阶段任务

### P0 · 骨架与构建链路

**目标**：打通「CI 编译 wasm → 页面调用成功」的最小闭环，不涉及业务逻辑。

任务：

1. 创建 `wasm/` crate（`crate-type = ["cdylib"]`，依赖 `wasm-bindgen`），实现一个 `pub fn ping() -> String`。
2. 本地跑通 `wasm-pack build --target web --release`，产物落到 `wasm/pkg/`。
3. 新增 `.github/workflows/build-wasm.yml`：在 `ubuntu-latest` 上装 Rust + `wasm32-unknown-unknown` + `wasm-pack`，编译并把 `wasm/pkg/` 提交回仓库或作为 artifact 供 Pages 使用。
4. 创建 `js/worker/parse.worker.ts` 骨架与 `js/worker/index.ts` 调用层，主线程能收到 Worker 的 ping 响应。

**验收**：`git push` 后 CI 自动产出 wasm；页面里 `await import("../wasm/pkg/compute.js")` 能调用 `ping()` 并拿到返回值。

### P1 · 解析内核迁移（最关键阶段）

**目标**：新路径产出与 Pyodide 路径**字段级一致**的 `ReplayData`。

任务：

1. 实现 MPQ 读取（可参考 `mpyq` 的 Python 实现或 npm 生态的 MPQ 读取器）。
2. 实现协议解码：
   - 读取 `replay.header` 拿到 `m_version.m_baseBuild`，据此选择协议版本。
   - 解码 `replay.details`（地图名、玩家、种族、时长）、`replay.tracker.events`（单位生命周期、玩家统计、位置快照）、`replay.game.events`（命令）、`replay.message.events`（聊天）。
   - **协议定义来源**：以 Blizzard 官方 `s2protocol` 仓库的 `json/protocolNNNNN.json` 为准。建议写一个 codegen 生成 TS 的类型/解码表，避免手工维护。
   - 可参考 npm 包 `s2protocol`（TypeScript 移植，附带 `mpyqjs2`），但需先验证其浏览器可用性与版本覆盖。
3. 实现单位生命周期状态机：`SUnitInitEvent` / `SUnitDoneEvent` / `SUnitBornEvent` / `SUnitDiedEvent` / `SUnitTypeChangeEvent`。
4. **必须实现未知版本降级**：若本地无对应 `baseBuild` 的协议定义，不要抛错终止；回退到最接近的旧版本解析，并在结果中带 `degraded: true` 与提示文案。SC2 在 2026 年 6–7 月一个月内连发过 3 个 base build（97364 / 97425 / 97563），这条路径一定会被触发。
5. 迁移现有 `parse_script.js` 中的特殊处理逻辑，逐条对照：
   - 虫族单位 `start_time` 回推（sc2reader 不对虫族做建造时间回推，导致 start/finish 相同）
   - 星空加速（`NexusMassRecall` / `MassRecallMothership` / `MassRecallMothershipCore` / `MassRecallMothershipCore`）事件与目标单位
   - 玩家统计（`PlayerStatsEvent`）的定点数换算：`food_used` / `food_made` 超过 1000 时需 `/4096`
   - 工人阵亡与累计击杀/损失
   - 工人数量逐秒曲线（`workers_curve`）

**验收（硬门槛）**：

对 `sampleTest/` 的 5 个录像 + `dependence/` 内可用录像，逐场对比新路径与 Pyodide 路径的输出：

- `map_name` / `winner` / `region` / `client_version` 完全一致
- `teams[].players[].build_order` 的**条数与每条的 `start_time`** 一致（允许 ±0 容差；若因算法改进而有意不同，必须逐条记录差异原因）
- `chat` 条目数与时间一致
- `stats` 的 `minute` 序列一致

建议写一个 `scripts/compare-parsers.mjs`，同时跑两条路径并输出 diff 报告，纳入 CI。

### P2 · 缓存与切换

1. 接入 IndexedDB 缓存（§4.3）。
2. 批量场景改走 Worker 队列（`js/batch_rail.js` 的 `processBatchFiles` 改为调用新解析层），主线程不再阻塞。
3. 默认走新路径；Pyodide 保留为显式降级开关（例如 URL 参数 `?legacy=1` 或 `window.SC2_USE_LEGACY_PARSER`）。

**验收**：同一录像二次打开命中缓存（无重复解析）；批量 5 个录像期间页面可正常滚动交互。

### P3 · 小地图可视化

数据来源与限制（**务必注意**）：

- `NNet.Replay.Tracker.SUnitPositionsEvent`：**每 15 秒**一次，坐标需 **乘 4**，单次最多 **256 个单位**，且**只记录在此期间受到伤害的单位**。
- 位置本身是稀疏的，必须用 game events 里的移动命令做插值补全，否则轨迹会断断续续。
- 死亡位置可从 `SUnitDiedEvent` 取得。

任务：

1. 在 Worker 中产出 `trails`（逐秒单位位置）与 `deaths`（死亡点）。
2. `js/viewer/minimap.ts`：Canvas 2D 渲染地图底图 + 单位点 + 轨迹线；支持按玩家过滤。
3. 与现有时间轴/语音播放联动（复用 `voice_reader.js` 的计时驱动，或抽出统一的时间轴控制器）。
4. UI 上标注「位置为近似值」（因为插值 + 稀疏采样）。

**验收**：30 分钟以上的对局中，小地图位置随时间轴平滑推进，无明显跳变；行军路线可辨认。

### P4 · 移除 Pyodide

1. 删除 `js/parse_script.js`、`js/pyodide_boot.js`，清理 `index.html` / `replays.html` 中的 Pyodide CDN 引用与初始化 UI（`#initStatus`）。
2. 更新 `README.md`（依赖说明、功能概述中的 Pyodide 段落）与 `docs/MAINTENANCE.md`（模块对照表、数据流图、改功能时的入口指引）。
3. 更新 `js/constants.js`：移除 `PYODIDE_VERSION`。

**验收**：全站无 Pyodide 残留（代码、文档、UI 文案），首屏无 Python 运行时下载。

---

## 7. 已知风险：录像还原后时间不同步（必读）

这是历史遗留问题，务必在 P1 阶段正面解决，**不要在新解析器里把旧的不一致一起继承过去**。

### 7.1 代码中的具体线索

当前代码里存在**两套并存的时间换算常量**和**至少一处语义不一致的用法**：

`js/constants.js`：

```js
export const GAME_TIME_FACTOR = 1.4;        // "Faster" 速度下 1 真实秒 ≈ 1.4 游戏秒
export const SC2_FASTER_REAL_FACTOR = 0.9803; // 仅在语音播报中使用的经验修正系数
```

`js/format_utils.js` —— 两个函数语义不同：

```js
export function formatRealTime(seconds) {          // 不做任何缩放
  const s = Math.max(0, Math.round(seconds));
  return `${...}:${...}`;
}
export function formatGameTime(gameSeconds) {      // 除以 GAME_TIME_FACTOR
  const s = Math.max(0, Math.round(gameSeconds / GAME_TIME_FACTOR));
  return `${...}:${...}`;
}
```

`js/display.js` —— **同一个页面里混用两者**：

```js
info.push(`<span><strong>时长</strong> ${formatRealTime(gameLen)}</span>`);   // 对局时长：未缩放
...
return { timeStr: formatGameTime(t), ... }                                    // 建造项：已缩放
```

`js/parse_script.js` —— 产出的是**逻辑秒**：

```python
"game_length": st_data.get("frames", 0) // max(st_data.get("frames_per_second", 16), 1),
# 以及散落各处的 frame >> 4
```

`js/benchmarks.js` + `parse_script.js` —— 图表横轴与统计分钟数**已缩放**：

```python
gsec = frame / 16.0
dsec = gsec / 1.4          # 除过 1.4
minute = int(dsec / 60) + 1
```

`js/voice_reader.js` —— 又引入 `SC2_FASTER_REAL_FACTOR`：

```js
time: (it.start_time / GAME_TIME_FACTOR) * SC2_FASTER_REAL_FACTOR,   // 转成"真实秒"驱动计时器
// 反算时：
const rawStart = (appState.voiceSteps[idx].time / SC2_FASTER_REAL_FACTOR) * GAME_TIME_FACTOR;
```

### 7.2 由此推断的可疑点

1. **「对局时长」与「建造时间轴」可能不是同一条时间轴**：时长走 `formatRealTime`（未缩放），建造项走 `formatGameTime`（除以 1.4）。若 `game_length` 与 `build_order[].start_time` 同为逻辑秒，则时长会显示为建造轴末端的约 1.4 倍。
2. **`SC2_FASTER_REAL_FACTOR = 0.9803` 来源不明**：它只影响语音播报的计时驱动，若该系数与实际游戏速度不匹配，播报进度会随时间累积偏差（30 分钟对局中，1% 的误差约等于 18 秒）。这也可能表现为「语音提示的时间与画面对不上」。
3. **虫族单位的 `start_time` 是回推值**（见 `README.md` 的 build-260310 记录），与其它种族不同源，可能造成跨种族对比时的偏差感。

### 7.3 统一规范（P1 必须落地）

1. **用一个真值源定义时间语义**，建议统一为两个明确的量并写进文档：

   - `logicalSeconds` = `frame / 16`（游戏逻辑秒，与游戏速度无关）
   - `displaySeconds` = `logicalSeconds / 1.4`（游戏内 UI 显示的时间，仅用于展示）

2. **所有时间显示必须显式选择其中一个**，函数名要能自证：`formatLogicalTime(t)` / `formatDisplayTime(t)`。禁止再有语义模糊的 `formatRealTime` / `formatGameTime` 并存。

3. **`SC2_FASTER_REAL_FACTOR` 必须重新标定或删除**。标定方法：录制/选取一场已知游戏内时长的对局，用录像在客户端内播放，记录「游戏内时钟」与「真实秒表」的比值；若实测就是 1.4，则删除该系数。

4. **`game_length` 的语义要在解析层就定清楚并写入字段注释**，不要留给展示层猜。

5. **语音播报改为由统一时间轴驱动**，不要自行用 `Date.now()` 做独立计时（当前是 `voiceStartTime + setInterval(50ms)`），避免与展示层各算各的。

### 7.4 验证方法

1. 取 `sampleTest/` 中一场录像，在 SC2 客户端里播放，记录对局结束时**游戏内显示的总时长**（例如 `12:34`）。
2. 在页面上对照三处数字：`game-info` 的「时长」、建造时间轴最后一项、图表横轴末点。
3. 三者应指向同一时刻（或能明确解释差异）。若时长恰好是另外两者的 1.4 倍，即确认 7.2 第 1 条。
4. 对比录像内某条已知聊天消息的时间（聊天记录的 `time` 来自 `frame >> 4`）与它在客户端回放时出现的时间点。
5. 把结论写回本文档或 `docs/MAINTENANCE.md`，避免后续再次踩坑。

---

## 8. 其他风险与对策

| 风险 | 等级 | 对策 |
| --- | --- | --- |
| TS 侧解码器跟不上 SC2 协议更新 | 中 | 以官方 `json/protocolNNNNN.json` 为源做 codegen；实现未知版本降级（§6 P1 第 4 条）；加定期巡检官方仓库 `json/` 目录的任务 |
| npm `s2protocol`（TS 移植）是个人项目、浏览器可用性未验证 | 中 | P1 第一件事就是验证它；不达标则自研解码器，只实现所需子集 |
| wasm 体积失控 | 中 | 只用 `wasm-bindgen`，避免引入重量级依赖；CI 加体积预算门禁（建议 < 500KB）；`wasm-opt -Oz` |
| 小地图位置数据稀疏导致轨迹断裂 | 中 | 用 game events 的移动命令插值；UI 明确标注「近似位置」 |
| 新路径与旧路径结果不一致 | 高 | P1 设字段级 diff 硬门槛；迁移期双跑；逐条记录有意差异 |
| 移除 Pyodide 后失去对照物 | 中 | 必须先完成 P1 验收再执行 P4，顺序不可颠倒 |
| 零构建原则被破坏 | 低 | wasm 产物经 CI 生成后提交到 `wasm/pkg/`，本地开发不需要构建工具链（可选） |

---

## 9. 上游依赖与参考资料

### 协议定义（权威来源）

- **Blizzard/s2protocol**（MIT）：`https://github.com/Blizzard/s2protocol`
  - `json/protocolNNNNN.json` 是协议定义的权威来源，由 Blizzard CI **自动提交**，随游戏补丁更新。
  - 截至 2026-09-21，最新为 `protocol97563`（2026-07-16 提交，对应游戏 5.0.16）。2026 年 6–7 月曾在一个月内连发 97364 / 97425 / 97563 三个 base build。

### 解析器参考

- `sc2reader`（Python，现用）：`https://github.com/ggtracker/sc2reader`
- `s2protocol-rs`（Rust，MIT）：`https://github.com/sebosp/s2protocol-rs`
  - 不适配 WASM（见 §2.1）；但它的**单位状态机与事件模型**、以及从官方 JSON 生成代码的思路有参考价值。
  - README 的「Generating protocol-specific code」一节给出了从官方 JSON 生成解析代码的流程。
- `s2protocol`（npm，TypeScript 移植）：`https://www.npmjs.com/package/s2protocol`
- `zephyrus-sc2-parser`（Python，有状态模型与选择/控制组追踪）：`https://pypi.org/project/zephyrus-sc2-parser/`

### Tracker Events 语义

- s2protocol 官方 README 的 Tracker Events 说明（含 `SUnitPositionsEvent` 的坐标换算 `* 4`、256 单位上限）。
- sc2reader 文档：`http://sc2reader.readthedocs.org/en/latest/events/tracker.html`

### 竞品参考

- `https://www.starcraft2.ai`（SC2 Replay AI Coach）：服务端解析 + PixiJS 等距渲染 + LLM 教练。其小地图/轨迹实现（位置快照 + 命令插值）与本项目 P3 目标一致，可作产品形态参考。

---

## 10. 协作约定

- **分支**：功能分支开发，通过 PR 合入默认分支。CI 会在 PR 上跑 wasm 构建与解析器对比。
- **本地预览**：改动前端后必须通过 HTTP 服务验证（`python3 -m http.server 8080`），不要直接打开 `file://`。
- **改功能时的入口**（沿用 `docs/MAINTENANCE.md`，本重构后需更新）：
  - 改解析字段/逻辑 → `js/worker/decoder/`
  - 改批量侧栏 → `js/batch_rail.js`
  - 改主界面/建造表/聊天 → `js/display.js` + `js/display_helpers.js`
  - 改语音 → `js/voice_reader.js`
  - 改图表 → `js/benchmarks.js`
  - 改小地图 → `js/viewer/`
- **不要在 Python 字符串里引入未转义的 `` ` `` 或 `${`**（迁移期 `parse_script.js` 仍存在时的历史坑）。
- **避免循环 import**（当前依赖方向：`batch_rail` → `display` → `voice_reader` / `benchmarks`，不反向）。

---

## 附录 A · 风险扫描遗留项（与本次重构无关但建议顺手处理）

以下问题来自对当前仓库的静态审计，若在 P1 触及相关文件可一并修复：

1. `js/display.js` 是唯一未做 HTML 转义的渲染路径（地图名、玩家名、单位名直接进 `innerHTML`），存在潜在存储型 XSS，尤其在 `replays.html` 拉取公共录像时。建议对新解析层产出的所有字符串统一走 `escapeHtml`。
2. `docs/` 在 `.gitignore` 中，但 `docs/MAINTENANCE.md` 已被 git 跟踪（ignore 对已跟踪文件无效）——新增的 docs 文件会被静默忽略。建议从 `.gitignore` 移除 `docs`。
3. `index.html` 与 `replays.html` 中 voice-reader 面板的 HTML 重复了约 60 行，可抽为 `<template>`。

## 附录 B · 验收清单速查

```
P0  CI 能自动产出 wasm；页面调用 ping() 成功
P1  样本录像字段级 diff 全部通过；未知版本降级路径可用
P2  缓存命中；批量解析期间 UI 不冻结
P3  小地图随时间轴平滑推进；轨迹可辨认
P4  全站无 Pyodide 残留（代码/文档/UI）
时间同步  三处时间数字语义一致且可解释；SC2_FASTER_REAL_FACTOR 已标定或删除
```
