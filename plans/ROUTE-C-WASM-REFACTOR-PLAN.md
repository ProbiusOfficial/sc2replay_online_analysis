# 路线 C 实施计划：WASM 解析重构 + 小地图可视化

> 本文档是**自包含的开发交接文件**。在 macOS 上 clone 仓库后，仅凭本文件即可开工，不需要会话上下文。
>
> - 仓库：`https://github.com/ProbiusOfficial/sc2replay_online_analysis`
> - 文档版本：2026-09-21
> - 适用环境：macOS（含 Xcode Command Line Tools）
> - 关联文档：`README.md`、`docs/MAINTENANCE.md`（模块职责与数据流，改动前必读）
>
> ⚠️ **模块清单已过时（2026-09-22 晚补）**：本文档写作时（旧 UI 时代）把 `app.js` / `display.js` /
> `voice_reader.js` / `benchmarks.js` / `batch_rail.js` / `display_helpers.js` / `format_utils.js` /
> `constants.js` / `replays_page.js` 等标为「保留」，但同日完成的 UI 重构已把这些模块**全部删除**
> （连同 `replays.html` 与 `css/app.css`）。当前真实结构见 `docs/MAINTENANCE.md`；
> 本文档的**解析链路、协议解码、容器、时间语义**等结论仍然有效，仅「保留哪些前端模块」一行失效。

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

## 0.1 进度快照（2026-09-21）

| 阶段                       | 状态        | 说明                                                                                                                                                                                              |
| -------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 骨架与构建链路          | ✅ 本地 4/4 | `wasm/` crate（`ping()`）、`wasm-pack build` 产出 `compute_bg.wasm`、`js/worker/` 骨架、`tools/wasm-smoke.html`，已在真实 Chromium 验收通过（当时 13,691 B）                                        |
| P0 的 CI 验收              | ⚠️ 未证实   | `.github/workflows/build-wasm.yml` 已写并通过 YAML 结构校验，但**尚未 push，CI 从未运行**                                                                                                          |
| P1 · 容器层（MPQ + 解压）  | ✅ 完成     | `js/worker/decoder/mpq.ts` + `decompressors.ts`；`scripts/verify-mpq.mjs` **261 项断言全绿**（基准 = mpyq + libbz2）。**实测：SC2 录像的压缩是 bzip2 而非 zlib**，故 wasm 侧新增 `bzip2_decompress`，体积 13.4 KB → **66.8 KB** |
| P1 · 协议解码              | ✅ 完成     | `js/worker/decoder/{decoder,events}.ts` + `protocols/`（codegen 产物 + 版本选择）。`scripts/verify-protocol.mjs` **110 项断言全绿**、浏览器 `tools/protocol-browser-check.html` **109 项全绿**；性能 **70 万事件/秒**                                        |
| P1 · build_order（三路混合 + 星空加速） | ✅ 完成     | `js/worker/decoder/{build_order,chrono,recall}.ts` + `data/{build_times,ability_links}.generated.ts`（188 + 25 项）。`scripts/verify-build-order.mjs` **178 项断言全绿**（基准 = sc2reader 1.9.0 + spawningtool 3.0.0 冻结快照）：基线条目 2370（含 4 条 recall），**严格不一致 0**、**未解释条目 0**；默认模式下 **573 条由 Egg 精确定位**。详见 §0.2 与 `plans/RESEARCH-RECALL-FIX.md` |
| P1 · ReplayData 组装       | ✅ 完成     | `js/worker/decoder/replay_data.ts` 组装全部字段（`map_name` / `game_length` / `client_version` / `region` / `start_time` / `winner` / `teams` / `chat` / `worker_deaths` / `stats` / `workers_curve` / `recall`）。`scripts/verify-replay-data.mjs` 两趟口径：**parity 口径对基线 ≈30,521 个叶值 0 失败**（CN_PVT coop 形状 + US_TVP 幻象 Phoenix 走白名单，逐条计数）；**发布口径（Egg 精确起点）二次复核 ±1 秒 141 条 / supply 随起点变化 15 条**，指纹钉死。`scripts/verify-worker.mjs` 真跑 `parse.worker.js`：5 录像走完 Worker 通道，契约诚实性（BAD_REQUEST / NOT_IMPLEMENTED）零失败 |
| P4 · 移除 Pyodide（运行时） | ✅ 完成     | 删除 `js/parse_script.js` / `js/pyodide_boot.js`；`index.html` / `replays.html` 去掉 pyodide.js CDN；`constants.js` 移除 `PYODIDE_VERSION`、`state.js` 移除 `appState.pyodide`；`app.js` / `batch_rail.js` / `replays_page.js` 全部改走 `js/parse_client.js`（Worker 门面）。旧解析脚本迁至 `tools/baseline/parse_script.py`（**冻结参考**，仅用于重建金标准，站点不加载）；README / MAINTENANCE 文档同步重写。全仓 grep 无 Pyodide 运行时残留 |
| P2（缓存）/ P3（小地图）   | ❌ 未开始   | —                                                                                                                                                                                                  |

> **结论（2026-09-21 晚更新）：站点已整体切到新解析链路，Pyodide 正式下线。** P1 全部完成（容器层 + 协议解码 + build_order + ReplayData 组装），页面经由 `js/parse_client.js` → Web Worker → wasm 完成解析；旧解析脚本仅作为 `tools/baseline/parse_script.py` 冻结参考保留。P2（IndexedDB 缓存）与 P3（小地图）未开始。

<!-- 维护约定：每完成一块就更新本表，并把「还差什么」写进结论 -->

---

## 0.2 P1 剩余工作：ReplayData 组装（~~下一里程碑~~ ✅ 已完成，2026-09-21）

协议解码产出的是**六个流的原始事件**，页面要的是 `extract_replay_data()` 那个形状的 `ReplayData`。~~中间这一层尚未实现~~ 已由 `js/worker/decoder/replay_data.ts` 实现，本节保留为字段分解的原始规划：

| 字段                                        | 数据来源                            | 难度 |
| ------------------------------------------- | ----------------------------------- | ---- |
| `map_name` / `client_version` / `region`    | `replay.details`                    | 低   |
| `game_length`                               | `header.m_elapsedGameLoops` ÷ 帧率  | 低   |
| `start_time`                                | `details.m_timeUTC`                 | 低   |
| `winner`                                    | `details.m_playerList[].m_result`   | 低   |
| `chat`                                      | `message.events`（事件 id 0）       | 低   |
| `worker_deaths` / `stats` / `workers_curve` | `tracker.events`（id 0 / 2）        | 中   |
| 星空加速（`_kind: "recall"`）               | `game.events` 的 `SCmdEvent.m_abil`（`m_data.TargetPoint`，**点目标无单位名**） | ✅ 已完成 |
| **`build_order`**                           | 见下                                | **高** |

> ⚠️ **术语澄清（易混）**：**「星空加速」是旧站点给 Mass Recall 家族起的显示名**
> （`js/display_helpers.js:4-7`：`NexusMassRecall` / `MassRecallMothership` / `MothershipMassRecall` /
> `MassRecallMothershipCore`），与 **「时空加速」（Chrono Boost）是两件不相干的事**。
> 前者是星灵传送技能（`_kind: "recall"` 行），后者才是影响建造时长、需要时间回推修正的机制
> （`chrono.ts`）。本节下方第 5 点原文把两者混为一谈，已更正。调研见
> [`plans/RESEARCH-RECALL-FIX.md`](./RESEARCH-RECALL-FIX.md)。

### build_order 为什么是独立的硬骨头

现有实现的 `build_order` 来自 **spawningtool**，它不是简单读事件，而是：

1. 需要**单位数据表**：`spawningtool/lotv_constants.py`（59.7 KB）+ `hots_constants.py`（39 KB）里的
   `BUILD_DATA`（单位名 → 建造时长 / 类型 / 是否变形）、`BO_EXCLUDED`、`TRACKED_ABILITIES` 等。
2. 需要**按录像时间戳选建造时长**：`build_data_for_timestamp(timestamp)` ——
   因为平衡性热修不改 build number，同一补丁内单位建造时间会变。
3. `SUnitBornEvent` 给的是**完成时刻**，要用建造时长**回推**开始时刻（`adjust_build_time`）；
   虫族单位尤其依赖这条，否则 start/finish 相同（这正是 README 里 build-260310 记的那个坑）。
4. `supply` 字段要按「开始时刻」反查当时的供给（`get_supply`）。
5. **时空加速（Chrono Boost）** 会缩短建造时间，需要单独修正。
   （原文此处误写作「星空加速」，那是 Mass Recall，与建造时长无关 —— 见上方术语澄清。）

**结论**：这是与「协议解码」同量级的一块工作，**不该顺手塞进协议解码这一里程碑**。两条路径：

- **A（推荐）**：照协议解码的同一模式，写 `scripts/gen-spawningtool-tables.py` 把两个 constants 文件
  codegen 成 TS，再移植 build_order 构建逻辑。产物 60–80 KB，与协议表做法完全对称。
- **B**：先只做「不依赖单位表」的近似版（T/P 用 `SUnitInitEvent` 直接拿开始时刻；虫族 start_time 退化为
  完成时刻），差距逐条记录。快，但建造时间轴对虫族是错的。

两条路径都要**先冻结 Pyodide 基线**（§6-P1 任务 2）才能做字段级 diff。

> #### ⚠️ 本节已被后续调研修正（2026-09-21）—— 详见 [`plans/RESEARCH-BUILD-ORDER-TIMING.md`](./RESEARCH-BUILD-ORDER-TIMING.md)
>
> 用已完工的 P1b 解码器做了实测，上面"方案 A / 方案 B"的二分**都需要修正**：
>
> 1. **方案 B（虫族 start_time 会错）应当作废** —— 虫族恰恰是**最容易被做到精确**的一族。
>    `SUnitBornEvent.m_creatorUnitTagIndex` 指向 Egg，Egg 的 `SUnitTypeChangeEvent` 帧
>    就是孵化起点。实测 16/16 命中，Δ 精确等于官方建造时长（Zergling 384 帧 = 24 s）。
>    **零数据表。**
> 2. **建筑在三族都天然精确**：`SUnitInitEvent` 与同 tag 的 `SUnitDoneEvent` 配对即得起止，
>    实测跨补丁（4.2.1 与 5.0.15）全部命中。**零数据表。**
> 3. **方案 A 全面 codegen `BUILD_DATA`（~100 KB）属过度设计**：建造时长本身就写在
>    sc2reader 的 `train_commands.json`（**6 KB**）里，只为人/神族单位回推时用得上。
> 4. **不要抄 spawningtool 的 `FRAMES_PER_SECOND = 22.4`** —— 实测所有 Δ 在 **16 fps**
>    下才是整数；22.4 是「Faster 速度下的真实秒」约定，它默认了天梯速度。
>    这直接印证 §7 要做的 `m_gameSpeed` 修正是必要的。
> 5. **新增一项必须先做的过滤**：地图中立单位 + 模式切换事件
>    （`LiberatorAG` / `VikingAssault` / `SupplyDepotLowered` …），不过滤会凭空多出上百条建造记录。
>
> **待用户拍板**：是否按调研结论把 P1c 的实现路径改掉（推荐改）。

> #### ✅ 已按调研结论落地（2026-09-21）
>
> 落地**三路混合**，`build_order.ts` 全程不依赖 spawn 逻辑之外的状态机：
>
> | 路径 | 适用 | 起点来源 | 数据表 |
> | ---- | ---- | -------- | ------ |
> | ① Egg 精确 | 虫族单位 | `SUnitBornEvent.m_creatorUnitTagIndex` → Egg 的 `SUnitTypeChangeEvent` 帧 | **不需要** |
> | ② Init 直接 | 建筑（三族） | `SUnitInitEvent` 帧（与同 tag `SUnitDoneEvent` 配对得终点） | **不需要** |
> | ③ 表回推 | 其余单位 / 变形 / 升级 | `出生帧 − BUILD_TIMES[unit].loops` | `build_times.generated.ts`（**188 项**，非原估 100 KB） |
>
> **两个必须记住的实现细节：**
>
> 1. **帧 0 不能跳过 tag 登记。** 开局 `Nexus` / `Hatchery` / `CommandCenter` 全在 frame 0，若在
>    「跳过 frame 0」之后才登记 tag，它们后续的 `SUnitTypeChangeEvent` 找不到归属 → 整条链丢失
>    （曾泄漏 `OrbitalCommand×4 / Lair×1 / Hive×1`，引发 **1610 条级联错位**）。现改为**预扫描**
>    先把所有 Born/Init 的 tag 登记进 `tagOwner`，再跑主循环。
> 2. **时空加速必须复刻 spawningtool 的模型选择缺陷。** `set_chronoboost_data` 用**录像时间戳**选模型，
>    窗口只覆盖 2015-09 ~ 2017-12，**2017-12-19 之后的录像一律掉进 `else`** 被套上 HotS 的
>    「+50% / 20 秒」模型。本模块**保持与之一致**（注释见 `chrono.ts` 文件头），因为 P1c 的目标是
>    「换引擎但输出不变」，基线冻结的就是这套数值。修掉它属**独立议题**，需产品层单独拍板。
>
> **已声明的两类偏差**（在验收脚本里写成白名单 + 形状断言，多一条即报红）：
>
> | 录像 | 现象 | 根因 |
> | ---- | ---- | ---- |
> | `CN_PVT_T-AI` | 该录像 `m_cooperative` 真为 `true`，旧链路改用 `coop_constants`（Marine 18s vs 25s、Adept 直接印 `(Error on build time)`）；我们**始终**用 LotV 表 | 有意偏离。形状断言：条目数不变 + 单位名多重集不变 → 证明是**纯时长偏差** |
> | `US_TVP / Shameless` | 我们**多 1 条幻象 Phoenix@720** | 旧链路靠 sc2reader 的 `unit.hallucinated` 过滤，该标记来自 `SSelectionDeltaEvent` subgroup flags —— 依赖选择事件时序的有状态量；我们的协议表把 `m_unitTypeName` 折成字符串，幻象与真单位同名，无法区分 |
>
> **踩过的两个非产品缺陷（已修，记以免复发）：**
>
> 1. **`baseBuild` 在 `header.m_version.m_baseBuild`，不在 `header` 顶层。** 取错得 `NaN`，
>    `expansionFromBaseBuild(NaN)` 静默回落到 `"WoL"`，令 `chronoModel` 的两个 LotV 窗口判定
>    **全部失效** —— 而样本录像全在窗口外，**跑样本永远测不出来**。现用 `probeBaseBuild()` 作为
>    唯一取值来源 + 断言与 `header.m_version` 一致，并把模型选择矩阵（含上下界、含 cooperative 短路）
>    做成独立自测钉在脚本里。
> 2. **`multisetDiff` 的返回命名写反过。** 曾用 `ours` 播种 map 却把 base-only 塞进 `onlyOurs`，
>    导致日志里「仅基线有」实际是「仅我们有」，一度把幻象 Phoenix 的方向判反。现按
>    `onlyOurs` = 只在我们 / `onlyBase` = 只在基线 严格命名。
>
> **已做：** 星空加速（`recall`）行（4 条）—— 见 `plans/RESEARCH-RECALL-FIX.md` §10。
> 关键结论：`m_abilLink` **不全局唯一**（随补丁漂移），必须**按 datapack 区间**取集合；
> 资料片改用**依赖 hash** 判定（新增 `expansionFromDetails`）。落地文件
> `data/ability_links.generated.ts` + `recall.ts`。
>
> **仍未做（属后续里程碑）：** `supply` 字段的 `get_supply` 索引 bug 复刻（当前 9 条 fallback）。
> ~~另外新解码器尚未接进 `ReplayData`，页面仍走 Pyodide~~ —— **已完成（2026-09-21）**：`replay_data.ts`
> 组装全字段，页面已切到 Worker 链路，Pyodide 已下线。

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
| 解析脚本 | ~~`js/parse_script.js`（内嵌 Python 字符串 `PARSE_SCRIPT`，由 Pyodide 执行）~~ **已下线**；冻结参考在 `tools/baseline/parse_script.py` |
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
  - `s2protocol/` 是 Blizzard 官方 Python 实现副本，最新只到 `protocol95299`（2025-10）。
  - **⚠️ 实测修正（2026-09-21）**：原文称「6 个样本里有 5 个超出覆盖范围、**直接无法解析**」——**这个结论是错的**。官方 `json/` 与 `s2protocol/versions/` 都是**稀疏**的：只有「协议真正发生变更的补丁」才会生成定义文件，`95299` 之后直接跳到 `97364`，中间是空的。而 `sampleTest/` 里 4 个「缺失」的 baseBuild（`95841` / `96163` / `96314` / `96516`）实测 `m_version` **全部是同一个补丁 `5.0.15`**——它们本来就只有一份协议定义，不是「缺失」。
  - **实测结论：用 `protocol95299` 解码这 4 个录像全部成功**（header / details / initData / tracker / game / message 事件全部正确读出）。实测脚本与事件计数见 §6-P1「协议定义来源与版本匹配」。
  - 真正的硬约束是**跨补丁 / 跨资料片**：`US_TVR(T)_2018_old`（baseBuild `62848`，`m_version` = `4.2.1`）用 `95299` 解码会在 tracker 阶段抛 `TruncatedError`，必须用它自己的协议定义。

---

## 2. 本次重构的决策（已确定）

### 2.1 技术路线：C-3 + C-4

**C-3（解耦）**：协议解码留在 TypeScript/JavaScript 侧并在 Web Worker 中运行；Rust/WASM **只承担计算密集部分**（位置插值、轨迹重建、热力图计算）。

> 为什么不用 Rust 直接解码：`sebosp/s2protocol-rs`（MIT，v3.5.6）实测**不适配 WASM**——`rayon` 是硬依赖（`wasm32-unknown-unknown` 无线程）、`arrow` 57 与 `arrow_convert` 在 default features 中默认启用、`include_assets` 编译期嵌入资源、且 dev-deps 含 `ratatui`/`crossterm`（定位为 CLI/桌面工具，无 WASM 目标）。硬啃需长期维护裁剪分支，不建议。
>
> 该决策的收益：**SC2 更新协议时完全不触碰 Rust 代码**。

> **职责边界的实测修正（2026-09-21）**：上面把 wasm 界定为「位置插值、轨迹重建、热力图」，但 P1 实测发现**容器解压也必须放进 wasm** —— SC2 录像的数据流是 **bzip2** 压缩（实测数据见 §6-P1 任务 1），而浏览器没有原生 bzip2 解码器，这条路径位于**每次解析的必经环节**。因此纳入标准从「业务计算」修正为 **「计算密集 + 平台无原生能力」**。
>
> 这不违反 C-3 的初衷：**协议解码**（随游戏版本变化的那部分）仍在 TS 侧，wasm 里**没有任何 SC2 协议知识**，只有通用字节变换（bzip2 解压）。

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

**`ReplayData` 必须与现有 Pyodide 路径的 `extract_replay_data` 返回值同构**（这是 P1 的验收基础）。字段定义见旧链路（已迁至 `tools/baseline/parse_script.py`）的 `result` 结构：`map_name`、`game_length`、`client_version`、`region`、`start_time`、`winner`、`teams[].players[]`（含 `name`、`race`、`build_order`、`worker_deaths`、`workers_curve`、`stats`）、`chat`。TS 侧的唯一定义处：`js/worker/decoder/replay_data.ts`。

### 4.2 WASM 导出（建议签名）

```rust
// 【已实现】MPQ 容器解压。SC2 录像的数据流是 bzip2，浏览器无原生解码器，
// 且位于每次解析的必经路径上。入参**不含** MPQ 的压缩类型标记字节（调用方先剥掉）。
#[wasm_bindgen]
pub fn bzip2_decompress(data: &[u8]) -> Result<Vec<u8>, JsValue>;

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

**结构约定（2026-09-21 补充，P3 同样适用）**：纯计算写在 `*_impl` 函数里、返回 `Result<_, String>`；`#[wasm_bindgen]` 导出层只做 字符串 → `JsValue` 的转换。

> 原因（实测踩坑）：`JsValue` 的构造在 non-wasm32 目标上**未实现**，调用即 panic ——
> `wasm-bindgen-0.2.128/src/lib.rs:1316: function not implemented on non-wasm32 targets`。
> 一旦把 `JsValue` 写进核心逻辑的返回类型，这些逻辑就**无法在 native 上跑 `cargo test`**，
> 而 P1 的验收恰恰依赖 native 单测与对拍脚本。分层后 `cargo test` 正常通过（3/3）。

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
  parse_client.js           # ✅ 主线程解析门面（P1c），取代 pyodide_boot.js
  # parse_script.js / pyodide_boot.js 已随 P4 删除；旧 Python 冻结在 tools/baseline/parse_script.py

  worker/
    parse.worker.ts         # ✅ Worker 入口（P0）
    contract.ts             # ✅ 主线程 ↔ Worker 消息契约（P0）
    tsconfig.json           # ✅ 源码 .ts → 同目录 committed .js（CI 用 npx tsc 转译，站点保持零构建）
    decoder/                # 容器层 + 协议解码（TS）
      mpq.ts                # ✅ MPQ 归档读取（P1 完成；零依赖，解压后端可注入）
      decompressors.ts      # ✅ wasm 解压适配层（bzip2）
      decoder.ts            # ✅ 解码引擎：BitPackedBuffer / BitPackedDecoder / VersionedDecoder
      events.ts             # ✅ 六个流的解码入口 + 事件流遍历 + unit tag 工具
      protocols/
        index.ts            # ✅ 版本选择（补丁边界匹配 + probeBaseBuild 探测 + 降级）
        registry.generated.ts  # ✅ codegen：已内置版本 + 官方补丁边界表
        protocol62848.ts    # ✅ codegen 产物（自动生成，勿手改）
        protocol95299.ts    # ✅
        protocol97563.ts    # ✅
      state.ts              # ⬜ 单位生命周期状态机（属 §0.2 ReplayData 组装）
      replay_data.ts        # ⬜ 六流 → ReplayData 组装（属 §0.2）
    index.ts                # ✅ 对外 API：parseReplay(buffer, md5)（P0 骨架，P1 填充实现）

  viewer/
    minimap.ts              # ⬜ 小地图渲染
    trails.ts               # ⬜ 轨迹数据准备
    timeline.ts             # ⬜ 与现有时间轴联动

wasm/
  Cargo.toml
  src/lib.rs                # ping() + bzip2_decompress（纯计算走 *_impl，见 §4.2 结构约定）
  pkg/                      # 构建产物（wasm-pack output，提交入仓供 Pages 使用）

scripts/
  wasm-smoke.mjs            # ✅ wasm 加载与体积门禁（P0）
  verify-mpq.mjs            # ✅ MPQ + bzip2 验收，261 项断言（P1）
  make-mpq-fixtures.py      # ✅ 生成 MPQ 基准（仅在需要重建基准时跑，CI 不依赖 Python）
  gen-protocol-tables.py    # ✅ 官方协议表 → TS codegen（P1；新增补丁支持时重跑）
  verify-protocol.mjs       # ✅ 协议解码验收，110 项断言（P1；CI 不依赖 Python）
  make-protocol-fixtures.py # ✅ 用官方 s2protocol 生成协议基准（P1）
  bench-protocol.mjs        # ✅ 解码性能基准（P1）

tests/
  fixtures/
    mpq-baseline.json       # ✅ MPQ 期望值固化（只存尺寸/md5，不含录像内容）
    protocol-baseline.json  # ✅ 六流事件摘要 + 首尾采样（411 KB，P1）
  baseline/                 # ⬜ ReplayData 的 Pyodide 金标准快照（§6-P1 任务 2，未做）

tools/
  wasm-smoke.html           # ✅ 浏览器冒烟页（P0 验收后可删）
  mpq-browser-check.html    # ✅ MPQ 容器层浏览器验收（P1）
  protocol-browser-check.html # ✅ 协议解码浏览器验收（P1）

.protocol-cache/            # 官方协议 .py 与版本列表的下载缓存（已 gitignore，运行时不需要）
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

1. ✅ **实现 MPQ 读取 —— 已完成（2026-09-21）**。产物：`js/worker/decoder/mpq.ts`（容器解析，零依赖）+ `decompressors.ts`（wasm 解压适配层）。

   **验收**：`node scripts/verify-mpq.mjs` → **261 项断言全绿**。基准 `tests/fixtures/mpq-baseline.json` 由 `scripts/make-mpq-fixtures.py` 用 Python 的 `mpyq` + `bz2`（libbz2）生成后**固化入仓**，因此 **CI 不需要 Python**。覆盖 5 个录像 × 全部 75 个文件条目。

   **实测关键结论（其中 (a) 推翻了此前假设）**：

   **(a) 数据流是 bzip2，不是 zlib。** 5 个样本共 **53 个压缩块，全部为 bzip2**（类型标记 `0x10`）；主力流 `replay.tracker.events` / `replay.game.events` / `replay.initData` 无一例外。压缩比最高 8.22（`hero vs reynor` 的 tracker：58,018 B → 476,635 B）；累计 600,848 B → 1,880,238 B。
   → **浏览器没有原生 bzip2，这是 P1 的硬前置条件。** 已按 §2.1 的边界修正放进 wasm：`bzip2_decompress`（`bzip2-rs` 0.1.2，纯 Rust，可编译到 `wasm32-unknown-unknown`）。正确性用 53 个真实压缩块与 libbz2 逐块比对通过。wasm 体积 13.4 KB → **66.8 KB**。

   **(b) `replay.header` 不在 MPQ 内。** 它不在 `(listfile)` 里，而是 **user data header（`MPQ\x1b`）的 `content` 字节**（实测长度 114–115 B）。读取顺序：offset 0 读 user data header → 依其 `mpqHeaderOffset`（实测 1024）读 MPQ header（`MPQ\x1a`，`format_version = 3`）。入口：`MpqArchive.readHeaderContent()`。

   **(c) 实测样本的 MPQ 结构完全一致**：`format_version = 3`、`sector_size_shift = 5`、hash 表 32 条、block 表 17 条、listfile 共 15 个文件。每个文件都带 `MPQ_FILE_SINGLE_UNIT` 且未置 `SECTOR_CRC`，走单块压缩分支。

   **(d) `archivedSize === 0` 的文件（实测 `replay.sync.history`）应返回 `null`** —— 与本仓库参考实现 `mpyq` 的约定一致，**这不是错误**，校验脚本须按 `null` 断言。

   ⚠️ 压缩仅在「至少省下 1 字节」时才生效，判定条件为 `block.size > block.archivedSize`（与 `mpyq` 一致）。实测 `replay.details` 与 `replay.message.events` **未压缩**，此时块首字节是数据本身，**不能**当压缩类型标记读。

2. ✅ **实现协议解码 —— 已完成（2026-09-21）**。产物：`js/worker/decoder/decoder.ts`（解码引擎）、`events.ts`（六流入口）、`protocols/`（codegen 产物 + 版本选择）；codegen 脚本 `scripts/gen-protocol-tables.py`。

   **验收**：`node scripts/verify-protocol.mjs` → **110 项断言全绿**；浏览器 `tools/protocol-browser-check.html` → **109 项全绿、0.63 s、零错误**。基准 `tests/fixtures/protocol-baseline.json`（411 KB，由 `scripts/make-protocol-fixtures.py` 用**官方 s2protocol** 生成后固化，CI 不需要 Python），覆盖 5 个录像 × 6 个流 ≈ **8.2 万条事件**，按**全量 sha256** 逐字节比对。性能见 `scripts/bench-protocol.mjs`：**70 万事件/秒**（最大一场 39,642 条事件全流程 45 ms）。

   - 读取 user data header 的 `content`（即 `replay.header`，见上）拿到 `m_version.m_baseBuild`（选协议版本）与 `m_elapsedGameLoops`（总时长）。
   - 从 `replay.details` 与 `replay.initData`（`m_syncLobbyState.m_gameDescription`）读取 **`m_gameSpeed`** —— 时间换算必需，见 §7。
   - 解码 `replay.details`（地图名、玩家、种族、时长）、`replay.tracker.events`（单位生命周期、玩家统计、位置快照）、`replay.game.events`（命令）、`replay.message.events`（聊天）。
   - **协议定义来源**（2026-09-21 实测定论）：
     - ❌ **npm 包 `s2protocol`（TS 移植）不可用**。v1.0.0（2026-01-24 发布，MIT，依赖仅 `mpyqjs2`）的 tarball 里**根本没有 `dist/` 目录**，而 `package.json` 的 `main`/`module`/`exports` 全指向 `dist/index.js` —— 发布不完整，直接 `import` 必失败。且其 `src/versions/` 只到 `protocol95299`，与官方稀疏程度一致，同样缺我们需要的 4 个 baseBuild。**唯一可取的是它的 `src/` 结构可作 TS 重写的参照。**
     - ✅ **codegen 源改用官方 `s2protocol/versions/protocolNNNNN.py`，而不是 `json/protocolNNNNN.json`**（2026-09-21 实践修正）。两者同源，但 `json/` 放的是 **SDL 原始 AST**（`TypeDecl` / `ConstDecl` / `Module`），要能用还得先跑官方那套 SDL 编译器；而 `.py` 是官方**已编译好**的解码指令表（`typeinfos` + 三张事件表），直接 `ast.literal_eval` 提取即可，省掉「自己实现 SDL 编译器」这种偏离目标的工作。生成器用 `ast` 静态解析，**不执行**官方文件里的任何代码。
     - 📐 **解码引擎自己重写，实际约 560 行 TS**（含注释）。官方 `decoders.py` ~300 行，结构为 `BitPackedBuffer` → `BitPackedDecoder` / `VersionedDecoder`，方法集固定：`_array` `_bitarray` `_blob` `_bool` `_choice` `_fourcc` `_int` `_null` `_optional` `_real32` `_real64` `_struct`（`VersionedDecoder` 另加 `_vint` `_skip_instance` `_expect_skip`）。
     - ⚠️ **官方 `versions/__init__.py` 的 `build()` 不做任何降级**：它直接 `` _import_protocol('protocol%05d' % build_version) ``，找不到就抛异常。降级逻辑必须自己写。

   **实现中踩到并已修正的四件事（都会导致「看起来能跑但数据错位」，务必保留）**：

   **(a) 解码器分流必须照搬官方，两个解码器不能混用。** 实测确认的分工：
   `header` / `details` / `tracker.events` → `VersionedDecoder`（带 skip 标记，随补丁演进）；
   `initData` / `game.events` / `message.events` → `BitPackedDecoder`（与版本强绑定，省掉标记以减小体积）。
   **用错不会立刻报错**，会读出一堆看似合理但完全错位的数据，所以这条只能照抄、不能凭直觉。

   **(b) `_fourcc` 与 `_bitarray` 在两个解码器上返回类型不同，必须分别实现。**
   `VersionedDecoder._fourcc` 是 `read_aligned_bytes(4)` → **bytes**（TS 侧 `Uint8Array`）；`BitPackedDecoder._fourcc` 是 `read_unaligned_bytes(4)` → **str**。
   `_bitarray` 同理：Versioned 版返回原始字节，BitPacked 版返回读出的整数值。实测差异体现在 `details.m_playerList[].m_toon.m_programId` 上。

   **(c) `vint` 必须用 BigInt 累加。** Python 的 int 是任意精度，而 `VersionedDecoder` 里**所有 int 都走 vint**（`bounds` 不参与），其中包含 64 位的 `m_timeUTC`。用 JS number 累加会静默丢精度 —— 实测 `m_timeUTC` 差 4（`134169213391093540` vs `134169213391093544`），足以让对拍失败。实现上做了「单字节 vint 走 number 快路径」，性能无损失。

   **(d) 64 位字段的 `bounds` 下界超出 JS 安全整数**（协议里是 `-2**63`），codegen 必须把它写成字符串、TS 侧用 `BigInt` 还原，否则字面量在 JS 里会静默丢精度。

   **(e) 「先有鸡还是先有蛋」：选协议要 `baseBuild`，读 `header` 又要协议。** 官方 Python 的做法是拿录像自报的 build 去 import 对应模块，对没内置的 build 直接失败 —— 不能照搬。实现为 `probeBaseBuild()`：**从最新内置版本往旧逐个试**，第一个能读出正整数 `m_baseBuild` 的就采用。依据是 `m_version` 是 header 的第二个字段、结构跨补丁稳定（实测用 95299 能正确读出 4.2.1 老录像的 baseBuild）。⚠️ 探测成功**不等于**该协议能解这个录像（见第 4 项的隐蔽风险），它只用来选正式协议。
3. 实现单位生命周期状态机：`SUnitInitEvent` / `SUnitDoneEvent` / `SUnitBornEvent` / `SUnitDiedEvent` / `SUnitTypeChangeEvent`。
   ❌ **未开始**。注意：协议解码层已把事件**原样解出**（含 `m_unitTypeName`、`m_controlPlayerId`、`m_x/m_y`、`m_creatorUnitTagIndex` 等），状态机是在其上的**归约**，属于 §0.2 的 ReplayData 组装范畴。
4. **必须实现未知版本降级 —— 但匹配单位是「补丁版本」，不是 `baseBuild`**（2026-09-21 实测修正）。

   Blizzard 只在**补丁级别**变更协议：`m_version` 的 `(m_major, m_minor, m_revision)` 相同的所有 baseBuild 共用同一份协议定义。实测证据（本地用官方 `protocol95299` 逐个解码）：

   | 录像                 | baseBuild | `m_version` | 使用的定义   | 结果                                          |
   | -------------------- | --------- | ----------- | ------------ | --------------------------------------------- |
   | `US_TVP`             | 95841     | **5.0.15**  | protocol95299 | ✅ tracker 2144 / game 20900 / message 10     |
   | `hero vs reynor`     | 96163     | **5.0.15**  | protocol95299 | ✅ tracker 9427 / game 30186 / message 29     |
   | `CN_PVT_T-AI`        | 96314     | **5.0.15**  | protocol95299 | ✅ tracker 448 / game 965 / message 6         |
   | `CN_ZVP`             | 96516     | **5.0.15**  | protocol95299 | ✅ tracker 395 / game 1165 / message 27       |
   | `US_TVR(T)_2018_old` | 62848     | 4.2.1       | protocol95299 | ❌ tracker 阶段 `TruncatedError`（后补入 protocol62848 后 ✅） |

   > 最后一行后来已解决：把 62848 的官方定义一并收录（`AVAILABLE_BUILDS = [62848, 95299, 97563]`）后，该录像完整解码成功（tracker 2395 / game 13950 / message 9），故它**不是**降级路径的实例。上表保留原始实验记录，用来佐证「跨补丁硬解会在 tracker 阶段崩」这一风险。

   **实现方式（2026-09-21 落地）**：不自己读 `m_version` 三元组，而是把官方 `json/` 目录的版本列表当**补丁边界表**用 —— codegen 时抓取并写进 `protocols/registry.generated.ts` 的 `OFFICIAL_BUILDS`（实测 **92 项**，跨 15405–97563）。判定规则（`selectProtocolTables()`）：

   1. 求 `bound` = `OFFICIAL_BUILDS` 里 **≤ `baseBuild` 的最大值**，即该录像所属补丁的官方定义；
   2. `bound` 已内置 → 直接用它，**不算降级**（不论 `baseBuild` 是否等于 `bound`）；
   3. 未内置 → 取内置版本里与 `baseBuild` **数值最接近**的一份，标 `degraded: true` 并在 `note` 里写明差额。

   第 3 步用「数值距离」而不是「取更旧的」，是因为补丁之间的 build 号跨度差异极大（5.0.15 → 5.0.16 差 2065，而 97425 → 97563 只差 138），数值更近的通常同代。

   ⚠️ 第 3 步的风险是真实的，且有隐蔽性：跨补丁硬解时 **`header` / `details` 往往仍能正常读出**（实测 `62848` 用 `95299` 读出了 baseBuild、`elapsedGameLoops`、地图名、玩家名与种族，全部正确），**只有 `tracker` 阶段才崩**（`TruncatedError`）。所以**不能以「header/details 读得出来」作为定义匹配成功的判据**，必须验证 tracker/game 事件流能完整走到末尾。

   SC2 在 2026 年 6–7 月一个月内连发过 3 个 base build（97364 / 97425 / 97563），这条路径一定会被触发；2026-09-21 的 4/5 样本命中同一补丁，说明**同补丁多 build 是常态，不是例外**。
5. 迁移现有 `parse_script.js` 中的特殊处理逻辑，逐条对照：
   - 虫族单位 `start_time` 回推（sc2reader 不对虫族做建造时间回推，导致 start/finish 相同）
   - 星空加速（`_kind: "recall"`，Mass Recall 家族：`NexusMassRecall` / `MassRecallMothership` /
     `MothershipMassRecall` / `MassRecallMothershipCore`）事件。**实测：这 4 个能力都是点目标
     （`m_data.TargetPoint`），指令里没有目标单位** —— 旧链路 `target` 恒为 `null`、`unit` 恒为 `""`，
     新解码器应如实复刻（不要假装能拿到目标名）。
     ✅ **已实现**（`recall.ts`）：`NexusMassRecall` 的 link 随补丁漂移（`96883` 区间是 724），
     所以集合必须按 datapack 区间取；玩家归属走两跳桥（`userId` → `wssId` → pid），
     且**按帧有序插入**而非旧链路的 append-to-end（README `build-260412` 记为 bug）。
   - 玩家统计（`PlayerStatsEvent`）的定点数换算：`food_used` / `food_made` 超过 1000 时需 `/4096`
   - 工人阵亡与累计击杀/损失
   - 工人数量逐秒曲线（`workers_curve`）

**验收（硬门槛）**：分两层，**协议层已完成，ReplayData 层未开始**。

**第一层 · 协议层（✅ 已完成 2026-09-21）** —— 对齐对象是**官方 Python 解码器**，不是 Pyodide：

- 六个流（header / details / initData / tracker / game / message）的**全量 sha256 逐字节一致**，
  覆盖 `sampleTest/` 全部 5 个录像 ≈ 8.2 万条事件。
- 工具：`node scripts/verify-protocol.mjs`（110 项）+ `tools/protocol-browser-check.html`（109 项）。
- 基准生成：`python3 scripts/make-protocol-fixtures.py`（用官方 s2protocol，产物固化入仓）。

> 这一层能先做完，是因为**官方 s2protocol 给出了可复现的金标准**，不必等 Pyodide 基线。

**第二层 · ReplayData 层（❌ 未开始）** —— 对齐对象是**现有 Pyodide 路径**：

对 `sampleTest/` 的 5 个录像 + `dependence/` 内可用录像，逐场对比新路径与 Pyodide 路径的输出：

- `map_name` / `winner` / `region` / `client_version` 完全一致
- `teams[].players[].build_order` 的**条数与每条的 `start_time`** 一致（允许 ±0 容差；若因算法改进而有意不同，必须逐条记录差异原因）
- `chat` 条目数与时间一致
- `stats` 的 `minute` 序列一致

**前置条件：先冻结 Pyodide 基线**（§6-P1 任务 2，未做）。用现在还能跑的 Pyodide 路径把 5 个样本的完整 `ReplayData` 导出成 JSON 快照存进 `tests/baseline/`，之后 diff 就不需要 Pyodide 运行时了 —— 这也是能尽早摘掉 Pyodide 的关键。

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

> **✅ 已于 2026-09-21 执行完毕**（比原计划提前 —— P1 验收达标后才动刀，顺序符合 §2.2 的约束）。

1. ~~删除 `js/parse_script.js`、`js/pyodide_boot.js`~~ ✅，~~清理 `index.html` / `replays.html` 中的 Pyodide CDN 引用~~ ✅；`#initStatus` 初始化 UI **保留**但改由 `parse_client.js` 驱动（Worker 拉起 + ping 冒烟，文案改为实话）。
2. ~~更新 `README.md`（依赖说明、功能概述中的 Pyodide 段落）与 `docs/MAINTENANCE.md`（模块对照表、数据流图、改功能时的入口指引）~~ ✅。
3. ~~更新 `js/constants.js`：移除 `PYODIDE_VERSION`~~ ✅；同时移除 `state.js` 的 `appState.pyodide`（→ `parserReady`）。
4. 计划外补充：旧 Python 逐字节迁至 `tools/baseline/parse_script.py`（头部写明「冻结参考，勿改勿挪回」），
   `scripts/freeze-baseline.py` 改读该文件，重跑后 5 份基线 JSON **逐字节不变**（仅 manifest 的来源/hash 字段更新）—— 证明迁移无行为影响。

**验收（2026-09-21 实测）**：全仓 grep 无 Pyodide 运行时残留（代码 / 文档 / UI 文案，历史 plan 与验收注释里的「旧链路」叙述除外）；
五个验收脚本全绿：`verify-mpq` 261 项、`verify-protocol` 110 项、`verify-build-order` 178 项、
`verify-replay-data` ≈30,521 叶值 0 失败、`verify-worker`（真跑 parse.worker.js，5 录像 + 契约诚实性）全绿。
**首屏不再下载 Python 运行时**（站点唯一的 CDN 依赖剩 Chart.js）。

---

## 7. 时间语义规范（必读）

> 本节结论**不依赖现有实现**：基于 SC2 游戏机制的权威资料独立调研，并用本地真实录像做了实测验证。现有实现是被检验的对象，不是依据。

### 7.1 权威时间模型

**录像文件只记录 game loop（逻辑帧）**，所有时间都必须由它换算。权威换算关系如下。

1. **基准**：Normal 速度下 **16 game loops = 1 秒**（逻辑帧率，与游戏速度设置无关）。
2. **速度倍率**（来源：Liquipedia `Game_Speed`，精确值分母为 4096）：

| 速度                   | 倍率    | 精确值                        | 1 分钟 Normal 时间对应的真实秒数 |
| ---------------------- | ------- | ----------------------------- | -------------------------------- |
| Slower                 | 0.6     | 2457/4096 = 0.599853515625    | 100                              |
| Slow                   | 0.8     | 3276/4096 = 0.7998046875      | 75                               |
| Normal                 | 1.0     | 4096/4096 = 1.0               | 60                               |
| Fast                   | 1.2     | 4915/4096 = 1.199951171875    | 50                               |
| **Faster**（天梯默认） | **1.4** | **5734/4096 = 1.39990234375** | **42.86**                        |

3. **换算公式**（与 SC2 地图脚本 API 的惯例一致：`elapsed = mission_time / game_speed`）：

```
gameTime    = elapsedGameLoops / 16        // Normal 基准的时间
displayTime = gameTime / speedFactor       // 游戏内时钟显示的时间
```

4. **速度值存在录像里，必须读取，不能假设**：

   - `replay.details` → `m_gameSpeed`
   - `replay.initData` → `m_syncLobbyState.m_gameDescription.m_gameSpeed`

   实测（见 7.3）两处取值一致。注意原始值是**整数枚举**（不是 `"Faster"` 这样的字符串），需要做映射；映射表在实现时必须用真实录像验证。

### 7.2 版本差异：LotV 是分界线

来自 Liquipedia `Game_Speed` 条目的两条关键说明（务必理解）：

- **Legacy of the Void（2015-11 起）之后**：*"all time-related values shown in game will now display real-time seconds. That includes tooltips ... and the match clock which is shown above the minimap."* → 游戏内显示的是**真实时间**，即 `gameTime / speedFactor`。
- **LotV 之前（WoL / HotS）**：*"all time-related values shown in game were assuming Normal speed, so when playing on Faster, they were incorrect in terms of real-time seconds."* → 游戏内显示的是 **Normal 基准时间**，即 `gameTime`（换算时把 speedFactor 视为 1.0）。

因此正确规则是：

```
speedFactor = isLotVOrLater(replay) ? speedMultiplier(replay.m_gameSpeed) : 1.0
displayTime = (elapsedGameLoops / 16) / speedFactor
```

LotV 起始 build 约为 **38749**（3.0 补丁）；也可用 `release` 主版本号判定（1.x = WoL，2.x = HotS，3.x 及以上 = LotV）。

另外两个必须知道的细节：

- **回放速度会影响游戏内时钟**：*"Replays store the speed at which they were recorded such that playing a replay back at a different speed will make the in-game clock not show real-time."* 所以在客户端里以非原速回放时，看到的时钟不能直接作为对照基准。
- **SC2 的 real time 与墙钟并不相等**：引擎在卡顿/减速时假装时间没有流逝，正常条件下也可能每分钟落后墙钟约 1 秒。**因此「墙钟时间」无法从录像精确还原，不应作为对齐目标。**

### 7.3 现有实现的偏差诊断（审计证据）

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

旧链路（`tools/baseline/parse_script.py`，原 `js/parse_script.js`）—— 产出的是**逻辑秒**：

```python
"game_length": st_data.get("frames", 0) // max(st_data.get("frames_per_second", 16), 1),
# 以及散落各处的 frame >> 4
```

`js/benchmarks.js` + 旧链路 —— 图表横轴与统计分钟数**已缩放**：

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

**实测数据 A：录像文件的原始帧数**（本地用 Blizzard 官方 s2protocol + mpyq 读取本仓库录像）。
注意这列是 `header.m_elapsedGameLoops` 的**原始逻辑帧**，**不等于**页面里的 `game_length`（见下方「实测数据 B」）：

| 录像                   | baseBuild | elapsedGameLoops | gameTime（loops/16） | /1.4      |
| ---------------------- | --------- | ---------------- | -------------------- | --------- |
| `US_TVR(T)_2018_old`   | 62848     | 38953            | 40:34                | **28:58** |
| `hero(w) vs reynor g1` | 96163     | 20875            | 21:44                | 15:31     |
| `US_TVP`               | 95841     | 22987            | 23:56                | 17:06     |
| `CN_PVT_T-AI`          | 96314     | 6323             | 06:35                | 04:42     |
| `CN_ZVP`               | 96516     | 2654             | 02:45                | 01:58     |
| `10000 Feet LE (7)`    | 96516     | 30800            | 32:05                | 22:55     |

字段位置已确认：`header.m_elapsedGameLoops` 为总帧数；`m_gameSpeed` 同时存在于 `details` 与 `initData.m_syncLobbyState.m_gameDescription`，两处取值一致，实测为**整数 `4`**。

**附带发现（与时间无关但同样重要）**：本仓库 `s2protocol/` 副本最新只到 `protocol95299`。~~上表 6 个录像中有 5 个的 baseBuild 超出其覆盖范围，直接无法解析。~~

**⚠️ 该结论已于 2026-09-21 实测否证**：4 个「超出覆盖」的 baseBuild（`95841` / `96163` / `96314` / `96516`）实测 `m_version` 全部是 **`5.0.15`**，用 `protocol95299` **可完整解码**（tracker / game / message 事件流全部走到末尾）。真正会失败的只有跨补丁的 `62848`（`4.2.1`）。详见 §6-P1 第 4 条的实测表与 §1.4。

**由此诊断出的偏差**：

**实测数据 B：页面实际渲染出来的数字**（2026-09-21，真实 Chromium + 完整 Pyodide 链路：
`python3 -m http.server 8080` → `http://127.0.0.1:8080/` → 选择 `sampleTest/` 录像）：

| 录像                 | baseBuild | 页面「时长」 | 建造表首项 | 建造表末项 | `loops/16/1.4` | 是否吻合 |
| -------------------- | --------- | ------------ | ---------- | ---------- | -------------- | -------- |
| `US_TVR(T)_2018_old` | 62848     | **28:58**    | 00:01      | 27:40      | 28:58.6        | ✅       |
| `CN_ZVP`             | 96516     | **01:58**    | 00:16      | 01:39      | 01:58.5        | ✅       |

两场录像均解析成功、无控制台报错、五张图表正常渲染。

**由此诊断出的偏差**：

1. **【2026-09-21 实测修正】原文「时长与建造表相差 1.4 倍」不成立**。原文推断「时长走 `formatRealTime` 不缩放 ⇒ 显示 40:34」，但漏掉了一环：`game_length` 在**解析层就已经被除过一次**——

   ```python
   # spawningtool/parser.py
   self.frames_per_second = self.constants.FRAMES_PER_SECOND
   # lotv_constants.FRAMES_PER_SECOND = 22.4   ← 16 × 1.4
   # hots_constants.FRAMES_PER_SECOND = 16
   ```

   即 `game_length = replay.frames // 22.4`（LotV）**本身就等于 displayTime**，1.4 已被隐含在除数里。实测 `US_TVR(T)_2018_old` 页面显示 **28:58**（不是 40:34），与 `38953/16/1.4 = 28:58.6` 吻合。
   真正的后果有两个，都比原文描述更隐蔽：
   - **`/1.4` 被硬编码了两遍**（解析层 22.4、展示层 `GAME_TIME_FACTOR`），改一处不改另一处就会静默错位；
   - **真正的口径错位出现在 HotS / WoL 老录像**上（除数 16 ⇒ `game_length` = 逻辑秒，而建造项仍走 `formatGameTime` 除以 1.4），方向与原文相反。见偏差 3。
2. **速度系数被硬编码为 1.4**，未读取 `m_gameSpeed`。对非 Faster 的录像（自定义游戏、战役、合作模式，以及设为 `Fast` / `Normal` 的对局）会全部算错。**这条成立**——`22.4` 与 `1.4` 都只是在赌「天梯默认 Faster」。
3. **资料片语义确实被区分了，但只区分在解析层、且与展示层不一致**。spawningtool 按资料片切除数（LotV → 22.4，HotS → 16，与 §7.2「LotV 后显示真实秒、之前显示 Normal 基准」的语义一致）；但展示层恒定 `/1.4`。后果：LotV 录像两处碰巧对得上，**HotS / WoL 录像则「时长」按逻辑秒显示、建造表按 displayTime 显示，相差 1.4 倍**。项目声称支持 build 15405 起，这条老录像路径真实存在。
4. **`SC2_FASTER_REAL_FACTOR = 0.9803` 缺乏依据，并引入了新的不一致**：它让语音时间轴比界面显示小约 2%（30 分钟对局约差 36 秒）。按 7.2 最后一条，它试图补偿的「墙钟差异」本身无法从录像还原，这个系数不应出现在时间轴上。附带一提，1.4 也不是精确值（应为 5734/4096），虽然偏差仅约 0.01%，可忽略。
5. **虫族单位的 `start_time` 是回推值**（见 `README.md` 的 build-260310 记录），与其它种族不同源，跨种族对比时可能有轻微偏差。这是独立问题，与上述换算无关。

### 7.4 必须遵守的规范（P1 落地）

1. **解析层输出两个明确的时间量，并写明单位**：

   - `logicalSeconds = frame / 16`（原始，Normal 基准）
   - `displaySeconds = logicalSeconds / speedFactor`（游戏内显示口径）

   `speedFactor` 由解析层根据录像的 `m_gameSpeed` 与版本判定，**不要让展示层自己算**。

2. **展示层只做格式化，不做换算**。函数名必须自证语义：`formatLogicalTime()` / `formatDisplayTime()`。**禁止保留语义模糊的 `formatRealTime` / `formatGameTime` 并存** —— 7.3 第 1 条的偏差正是这样产生的。

3. **读取并保存 `m_gameSpeed`**，把原始整数与映射后的名称一并放进解析结果，例如 `gameSpeed: { raw: 4, name: "Faster", factor: 1.39990234375 }`，便于排查。

4. **删除 `SC2_FASTER_REAL_FACTOR`**。语音播报的时间轴必须与显示层同源，不要再引入独立系数。

5. **语音播报改由统一时间轴驱动**，不要用 `Date.now()` + `setInterval` 独立计时（当前实现是 `voiceStartTime + setInterval(50ms)`），否则暂停、跳步、拖动后容易与画面脱节。

6. **「对局时长」与「建造时间轴」必须使用同一个 `displayTime` 口径** —— 这是本节要解决的核心问题。

### 7.5 验证清单

1. 取 `sampleTest/` 中一场录像，在 SC2 客户端里播放（**必须原速播放**，否则游戏内时钟不能作为基准），记录游戏内显示的总时长。
2. 在页面上对照三处数字：`game-info` 的「时长」、建造时间轴最后一项、图表横轴末点。**LotV 录像已于 2026-09-21 实测吻合**（见 7.3 实测数据 B）；仍待验证的是 **HotS / WoL 老录像**，按 7.3 偏差 3，预期「时长」与建造表相差 1.4 倍。
3. 用 `US_TVR(T)_2018_old.SC2Replay` 做回归基准：期望时长约 **28:58**（`38953 / 16 / 1.4`），而不是 40:34。→ **页面侧已实测通过**（显示 28:58）；客户端侧（SC2 游戏内时钟）仍待确认。
4. 构造或寻找一场非 Faster 设置的对局（自定义游戏里可设置速度），确认时间随 `m_gameSpeed` 变化。
5. 用一场 WoL / HotS 时代的老录像，确认走 `speedFactor = 1.0` 分支。
6. 把最终结论写回 `docs/MAINTENANCE.md`，避免后续再次踩坑。

> 说明：第 3 条的 28:58 已在**页面侧**实测确认（2026-09-21）。但**客户端侧尚未验证**：仍需在 SC2 客户端里原速回放该录像，核对游戏内时钟是否为 28:58 —— 这同时是 `m_gameSpeed = 4 → Faster` 这条枚举映射的唯一外部基准。**在此之前，7.1 的换算模型属于「有源码与文献支撑的强推断」，不是已封板的结论。**

### 7.6 旧版诊断（v1，保留备查）

以下为上一版基于纯代码阅读的推断，其中「可疑点」已被上面的实测证实或修正，保留以备对照：

1. **「对局时长」与「建造时间轴」不是同一条时间轴**：时长走 `formatRealTime`（未缩放），建造项走 `formatGameTime`（除以 1.4）。→ **该推断已被 2026-09-21 实测否证**（LotV 录像两处口径一致，见 7.3 偏差 1）；但同源问题在 HotS / WoL 老录像上以相反方向存在，见 7.3 偏差 3。
2. **`SC2_FASTER_REAL_FACTOR = 0.9803` 来源不明**。（当时估计 30 分钟对局 1% 误差 ≈ 18 秒。）→ 实测偏差约 2%，约 36 秒，且该系数本身不应存在，见 7.3 第 4 条。
3. **虫族单位的 `start_time` 是回推值**（见 `README.md` 的 build-260310 记录），与其它种族不同源。→ 仍然成立，属独立问题。

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

**本地验收命令（P1 起）**：

```bash
# 1) Rust 侧单测（含「bzip2 损坏输入必须干净返回 Err」）
cd wasm && cargo test

# 2) 改过 wasm/src 后重建产物。注意 wasm-pack 每次构建都会写一个内容为 "*" 的 pkg/.gitignore，
#    必须删掉，否则整个产物目录会被 git 静默忽略。
wasm-pack build --target web --release && rm -f pkg/.gitignore

# 3) 改过 js/worker/**/*.ts 后转译（产物是同目录的 .js，随源码一起提交，站点保持零构建）
npx --yes --package typescript@5 -- tsc --project js/worker/tsconfig.json

# 4) MPQ + bzip2 验收：261 项断言，含 53 个 bzip2 块的解压后 md5
node scripts/verify-mpq.mjs
```

> **工程提示**：改「同一个函数的多处调用点」时（例如给 `decompressBlock` 全部调用加 `this.decompressor`），
> 改完**务必回读文件确认每一处都落盘**。编辑工具在单次批量修改里可能只应用部分改动，
> 而这类遗漏**编译不会报错**（参数是可选类型），只在运行期表现为「行为静默降级」。
> 本项目实际踩过一次：三处调用漏了一处，表现为 `mpq.ts` 明明传了解压器却报「未注入解压后端」。

- **改功能时的入口**（沿用 `docs/MAINTENANCE.md`，本重构后需更新）：
  - 改容器读取 / 解压后端 → `js/worker/decoder/mpq.ts` + `decompressors.ts`
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
P1a ✅ 容器层（Node）：node scripts/verify-mpq.mjs → 261 项断言全绿（MPQ 结构 + 53 个 bzip2 块解压后 md5）
    ✅ 容器层（浏览器）：tools/mpq-browser-check.html → 95 项检查全绿，0 页面错误（真实 Chromium）
    ✅ wasm 侧：cd wasm && cargo test → 3/3（含「bzip2 损坏输入必须干净返回 Err」）
    ✅ 体积：compute_bg.wasm = 66.8 KB（预算 500 KB）
P1b ✅ 协议层（Node）：node scripts/verify-protocol.mjs → 110 项断言全绿
        （5 录像 × 6 流 ≈ 8.2 万条事件，对照官方 s2protocol，全量 sha256 逐字节一致）
    ✅ 协议层（浏览器）：tools/protocol-browser-check.html → 109 项全绿、0.63 s、零错误
    ✅ 版本选择：补丁边界匹配；probeBaseBuild 探测；降级带 note
    ✅ 性能：node scripts/bench-protocol.mjs → 70 万事件/秒
P1c ✅ ReplayData 组装（六流 → extract_replay_data 同构结构）
    ✅ 前置：tests/baseline/ 已冻结 5 录像的旧链路快照（sc2reader 1.9.0 + spawningtool 3.0.0；
       生成源迁至 tools/baseline/parse_script.py，重跑逐字节一致）
    ✅ build_order：三路混合（Egg 精确 / Init 直接 / 表回推 188 项）+ 时空加速修正
       → node scripts/verify-build-order.mjs → 178 项断言全绿
         （基线 2370 条含 4 条 recall，严格不一致 0、未解释 0；默认模式 573 条 Egg 精确定位）
    ✅ 星空加速 recall 行：按 datapack 区间取能力 link（`data/ability_links.generated.ts`，25 项）
       + `recall.ts`（采集 + 按帧有序并入）；资料片改用依赖 hash 判定（`expansionFromDetails`）
    ✅ 剩余字段：chat / worker_deaths / stats / workers_curve / 实体与胜者（`replay_data.ts`）
    ✅ 字段级 diff：node scripts/verify-replay-data.mjs → 两趟口径，
       parity ≈30,521 叶值 0 失败（CN_PVT coop 形状 + US_TVP 幻象 Phoenix 走白名单）；
       发布口径对 parity：±1 秒 141 条 / supply 变化 15 条，指纹钉死
    ✅ 接线：parse.worker.ts 收 parse → extractReplayData；contract.ts 的 ReplayData 从 replay_data.ts re-export
P2  缓存命中；批量解析期间 UI 不冻结
P3  小地图随时间轴平滑推进；轨迹可辨认
P4  ✅ 全站无 Pyodide 残留（代码/文档/UI）；页面走 parse_client.js → Worker；
    旧 Python 迁至 tools/baseline/parse_script.py（冻结参考）
时间同步  时长/建造轴/图表三处口径一致；m_gameSpeed 已读取并参与换算；
          WoL/HotS 走 speedFactor=1.0 分支；SC2_FASTER_REAL_FACTOR 已删除
CI  ⚠️ 尚未 push，从未运行（用户明确：成品出来前先不看 gh 相关）
```
