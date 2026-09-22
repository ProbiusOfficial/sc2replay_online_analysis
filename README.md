## StarCraft II Replay Analysis - Online

![banner](./assets/banner.png)

一个基于浏览器端的《星际争霸 II》录像分析工具。**全部解析在本地完成，录像文件不会上传到任何服务器。**

> **2026-09 产品方向调整**：**「共享录像库」功能已下线**（无自建后端可持续运营），
> 站点转为**纯客户端**。`replays.html` 与上传相关代码保留在仓库中但已从导航移除，不再维护。
> 主页面重做为「**录像数据分析台**」：官方回放 overlay 口径的 28 张指标图 + 建造顺序 +
> 沙盘模拟 + 语音播报。

### 使用方法

线上演示（GitHub Pages）：https://rep.probius.xyz/

本地预览（**必须从项目根目录**提供 HTTP，勿用浏览器直接双击打开文件，否则 ES Module 与 `fetch("data.json")` 可能失败）：

```bash
python -m http.server 8080
```

浏览器访问 `http://127.0.0.1:8080/`，把 `.SC2Replay` 拖进页面即可（可一次拖多个）。

开发与维护时，模块职责、解析数据流与发布方式见 **[docs/MAINTENANCE.md](docs/MAINTENANCE.md)**。

### 待补的可选组件

**桌面悬浮窗（`sc2-overlay.exe`）尚未实现。** 它是一个**可选**的 Windows 小组件：
装了就有一个无边框、置顶、逐像素透明、点击穿透的建造轴浮层；
**不装也完全不影响使用**，此时「悬浮到桌面」会降级为浏览器自带的 Document 画中画
（顶部会带浏览器标题栏，且不能透明）。

- 视觉规格稿：`prototype/overlay-exe.html`（四种版式，`?embed=1` 即 exe，里 WebView2 要加载的形态）
- 方案调研（含通道设计、反作弊边界、Win32 细节）：`docs/RESEARCH-ALWAYS-ON-TOP-OVERLAY.md`

### 项目结构（站点零构建）

站点自身仍是**纯静态、零构建**：没有打包器、没有 `node_modules`，GitHub Actions 直接发布整仓。
唯一的「构建」发生在 **CI**（`.github/workflows/build-wasm.yml`）：Rust → wasm、Worker TypeScript → JS，
产物提交回仓库（`wasm/pkg/`、`js/worker/**/*.js`），所以本地开发**不用**装 Rust / TypeScript。

| 路径 | 说明 |
|------|------|
| `index.html` | **主页面**（录像数据分析台）：左侧录像列表侧边栏 + 数据分析 / 建造顺序 / 沙盘模拟 / 对局聊天四个视图 + 底部语音播报条 + 悬浮通道 |
| `css/lab.css` | 主页面的设计系统（浅色；`--a` 红 = 玩家 A、`--b` 蓝 = 玩家 B） |
| `js/lab/main.js` | 主页面编排层：文件输入 → 解析 → 适配 → 挂载；运行态（初始化 / 进度 / 错误） |
| `js/lab/data.js` | **数据适配层**：`ReplayData` → 视图层形状（含 39 字段短名映射、建造项分类、玩家时间网格对齐） |
| `js/lab/views.js` | 视图层（**由脚本从原型逐字节提取**，见 `scripts/extract-lab-views.mjs`）：全部渲染与交互 |
| `js/lab/sandbox.js` | **沙盘模拟视图**：canvas 上重演对局（单位图标 / 建筑 / 矿线 / 交战涟漪），与 views.js 零侵入，见 docs/MAINTENANCE.md |
| `js/lab/unit_icons.js` | 单位/科技图标名解析（映射归一 + 名单查询），沙盘与建造序共用；名单数据在 `unit_icons.generated.js` |
| `assets/units/` | 沙盘与建造序共用的 222 张单位图标（256×256 webp，懒加载）。取自 starcraft2.ai 的图标集，**素材版权归 Blizzard Entertainment，粉丝非商用** |
| `js/parse_client.js` | 主线程解析门面：拉起解析 Worker、`parseReplayBufferToData` |
| `js/worker/` | **解析 Worker**：MPQ 容器 + 六流协议解码 + `ReplayData` 组装（TS，由 CI 转译） |
| `wasm/` | Rust 源码与其 wasm 产物（bzip2 解压等热点） |
| `data.json` | 单位 / 建筑 / 升级等中文译名（建造顺序的分类与显示都依赖它） |
| `prototype/` | **设计来源**：交互原型、以及 `extract-lab-*.mjs` 提取生产文件时所依赖的模板。⚠️ 不要删，提取脚本靠它 |
| `tests/baseline/` | `ReplayData` 字段级对拍的金标准快照 |
| `tests/screenshots-lab/` | 生产页面端到端验收的截图产物 |
| `scripts/` | codegen 与验收脚本（`gen-*.py` / `verify-*.mjs` / `extract-lab-*.mjs` / `research/`） |
| `docs/` | 维护说明与调研报告（功能全集、竞品矩阵、悬浮窗方案） |

**已删除（2026-09-22 UI 重构）**：
上一代 UI 的 `css/app.css`、`js/app.js`、`js/display.js`、`js/display_helpers.js`、
`js/voice_reader.js`、`js/benchmarks.js`、`js/batch_rail.js`、`js/constants.js`、
`js/format_utils.js`、`js/export_build.js`；共享录像库的 `replays.html`、`js/replays_page.js`、
`js/share_upload.js`、`js/upload_api.js`、`js/telemetry.js`；以及未入仓的 `server/`。
删完后 `js/` 下 **44 个模块全部可达** —— 用 `node scripts/analyze-module-reachability.mjs` 核验
（它连 `new Worker(...)` / `new URL("...", import.meta.url)` 这类**字符串路径**的边都会走）。
仍保留 `tools/baseline/parse_script.py`：重建金标准基准要用的冻结参考，**不是死代码**。

### 功能概述

- **纯前端运行**：解析全部在浏览器里完成 —— Rust→WASM 负责容器解压，TypeScript 解码器在 **Web Worker** 中还原六个事件流并组装 `ReplayData`。**不加载 Python 运行时**，主线程不参与解析，大录像与多文件批量时页面不再冻结；**录像文件不会上传**。
- **沙盘模拟**：在抽象沙盘上重演对局 —— **斜视角**（45° 菱形等距投影 + 基地椭圆平台，可切回平面）、**左上/右上面板**（玩家名 + 单位/农民/建筑实时计数 + 编成 chips + 生产条 + 人口/军队）、**底部资源条**（双方矿/气 + 采集率 + 人口）、单位用**真实游戏图标**渲染（图标外圈/底色 = 归属方）、军队走位（稀疏采样点间插值）、矿线 / 气泉 / Xel'Naga 塔、交战涟漪（精确死亡坐标）。与全局时间轴同一条游标，可 1~16× 播放。**整页让位的大画布** + **⛶ 全屏**。**不需要地图文件**。这是上帝视角的抽象沙盘，不是拟真小地图（录像里没有地形 / 迷雾 / 血量）。
- **39 个计分字段完整呈现**：官方客户端回放 overlay（Resources / Income / Spending / Army / Losses）所用的 `SPlayerStatsEvent` 有 **39 个 `m_scoreValue*` 字段**，本页把它们做成 **28 张可视图表**（少数为派生求和，如「军队价值 = 矿 + 气」）。字段口径与官方完全一致，因此零学习成本。
- **全局时间轴为主控**：一条时间轴显示双方军队价值差的镜像包络，自动标记**交战**与**工人批量损失**事件；在任意图表或时间轴上移动鼠标，全部视图（读数卡 / 图表游标 / 采样表）同步。
- **读数卡与差值**：8 个核心指标双方对位，带差值与「谁领先」。
- **原始采样表 + CSV 导出**：可选指标跟随游标高亮滚动；一键导出 39 字段 × 双方的完整宽表。
- **建造顺序**：双列对位、按分钟分组、类别色条（建筑 / 单位 / 科技 / 农民 / 星空加速）、跟随时间轴高亮、点行跳转、类别筛选、中英双语、工人阵亡计数。
  > 原始 `build_order._kind` **只有 `unit` / `recall` 两种**，「建筑 / 单位 / 升级」是用 `data.json` 名表反查的 —— 这是旧链路 `itemIsTechUpgrade()` 的同一判据。
- **语音播报**：把建造顺序按时间轴朗读出来，可调倍速（1/2/4/8×）与语速、可切换播报对象与语言；**播报会推进全局时间轴**，切样本 / 切对象 / 改筛选都不打断。
- **桌面悬浮（可选）**：见上文「待补的可选组件」。未安装时降级为浏览器 Document 画中画。
- **批量录像**：一次拖入多个 `.SC2Replay`，在**左侧录像列表侧边栏**（吸顶、可滚动）里切换；
  单份解析失败不会影响其余，失败原因在错误条里逐条列出。
- **无视版本**：只要数据完好就能看（含 2018 年的 HotS 老录像）。

![录像数据分析台 · 数据分析视图](./assets/screenshot-data.png)

![录像数据分析台 · 建造顺序视图](./assets/screenshot-build-order.png)

---

### 依赖说明

解析逻辑是**对既有 Python 生态实现的等价重写**，语义对齐对象为：

- **sc2reader 1.9.0** 与 **spawningtool 3.0.0**：站点以前直接在浏览器里跑这两个库（Pyodide）；
  现在的 TypeScript 解码器逐字段复刻它们的输出，判据是 `tests/baseline/*.json`
  —— 由它们离线生成的冻结快照（源码 `tools/baseline/parse_script.py`，生成脚本 `scripts/freeze-baseline.py`）。
- **运行时不依赖 Python**：这两个库只在**重建基准**时需要，站点实际加载的产物是
  `wasm/pkg/*.wasm` 与 `js/worker/**/*.js`。改动解析口径后必须重新冻结基线并跑
  `scripts/verify-replay-data.mjs`，流程见 [docs/MAINTENANCE.md](docs/MAINTENANCE.md)。

### ~~上传服务部署（可选）~~ —— 已下线并移除

**共享上传与共享录像检索已于 2026-09 下线**（无自建后端可持续运营），站点转为纯客户端。
相关的 `server/`（FastAPI 服务）、`replays.html`、`js/replays_page.js`、`js/share_upload.js`、
`js/upload_api.js`、`js/telemetry.js` 已于 2026-09-22 **从仓库删除**（被删文件都在 git 历史里）。
如需重新启用，得先自行评估服务端托管与内容审核成本，再从头实现。

- ~~文档：`server/README.md`~~（未入仓，本机亦已不存在）
- ~~默认上传地址：`https://replayapi.s.3q.hair/api/replays/upload`~~



---

### 许可证与致谢

- 感谢 贝妮小姐
- 致谢 https://github.com/wayne19980/sc2build-tts ，感谢 @wayne19980 老师


- **sc2reader（依赖库）**

  本项目依赖的 `sc2reader` 源码来自 `ggtracker/sc2reader`，其遵循 MIT 许可证，声明如下：

  > The MIT License, http://www.opensource.org/licenses/mit-license.php  
  >  
  > Copyright (c) 2011-2013 Graylin Kim  
  >  
  > ...
  
- **SC2ReplayAnalyzer-main（数据翻译参考来源）**

  本项目中 `data.json` 的部分中文翻译与升级时间数据参考自 `AltriaZ0/SC2ReplayAnalyzer` 项目中的`.toml`文件，其遵循 MIT 许可证，声明如下：

  > MIT License  
  >  
  > Copyright (c) 2024 AltriaZ0  
  >  
  > ...

在此对 **sc2reader** 以及 **SC2ReplayAnalyzer-main** 项目作者和贡献者表示感谢。

### 更新日志

```build-260922i2
*译名全面对齐灰机wiki「星际争霸名词中英对照表」（用户定标准：一切以该表为准）
- data.json 全表重写 zh：unit 90 / build 76 / upgrade 92 / change 51，共 238 处变更。
  生成过程：灰机wiki 对照表（646 条，真实 Chrome 过 Cloudflare 后经 api.php 取 wikitext）
  为主源，exact → 驼峰展开 → 状态后缀剥离三级匹配；缺口按国服客户端惯例补
  （如 人类步兵武器等级2、星灵空中护甲等级3、异虫近战武器等级2、先进弹道学、
  双蛇杖反应堆 等科技名，对照表未覆盖，按客户端惯例推定）。
- 探姬保留（用户钦定，不跟随对照表的 探机）；双名条目取第一译（Queen→虫后、
  Viking→维京战机）；草稿经用户逐条过目后实施（plans/zh-official-draft.json）。
- ⚠️ 复盘：第一版对照时我误判该表是「台服体系」（铁鸦/异龙/眼虫/爆虫/巢虫领主…），
  实际这些正是国服官方名——被用户纠正。教训：对不懂的领域不要凭印象下结论。
- 沙盘/老页面两套 e2e 全过（建造序 77 图标、firstRow 探姬Probe 均正常）。
```

```build-260922i
*缺失图标调研与修复（用户反馈：有些图标缺失）
- 写了全量审计脚本（样本录像实际出现的每个单位名 + data.json 全部 92 条升级名
  × 真实解析链 `unit_icons.js`），清出 9 个缺图标单位名 + 28 个缺图标科技名。
- 修复三类：
  ① 拼写/单复数：`TemplarArchive` → 图标集的 `TemplarArchives`；空军护甲复数系
  （`ProtossAirArmorsLevel*` / `ZergFlyerArmorsLevel*` / `ZergGroundArmorsLevel*`）
  → 单数 `*ArmorLevel*`；`DisruptorPhased` → `Disruptor`、`LurkerDenMP` → `LurkerDen`。
  ② 具名升级借所属单位图标：渡鸦反应堆/锁定/快速发射器/蓝火 → 渡鸦·导弹车，
  女妖隐形/速度 → 女妖，隐刀闪烁 → 影 stride， DrillClaws → 地雷，盾牌墙 → 地堡，
  建筑甲 → 工程湾，风暴对建 → 风暴，虚空速度 → 虚空，王虫速度 → 王虫 等（tooltip
  仍显示准确中文名）。
  ③ 噪声剔除修正：`Beacon[A-Za-z0-9]*`（原正则漏了数字尾，BeaconCustom1-4 漏网）、
  `InvisibleTargetDummy`、`Nuke` 进 SKIP。
- 审计复测：样本单位侧缺图标 = 0（剩余名单全是 pid0 中立物，按设计走矢量绘制）；
  科技侧仅剩 `GameHeartActive`（OB 比赛模块，噪声过滤已排除）。
- 建造序同步受益（iconOf 走同一模块）：5 样本 2371 行实测 2367 行命中图标，
  其余 4 行为星空加速（recall，设计无图标）；`Nuke` 行借幽灵图标（核弹无独立图标）。
- 顺带：图标逻辑已收敛到 `js/lab/unit_icons.js`，审计脚本可直接 import 真实解析链测。
- 沙盘/老页面两套 e2e 全过。
```

```build-260922h
*建造顺序每行加单位/科技图标（用户：都有图标了，建造顺序也该有）
- 新增 `js/lab/unit_icons.js`：图标名解析的唯一实现（`iconKey` / `upgradeIconKey` /
  `hasIcon` / `hasUpgradeIcon`），沙盘与建造序共用，不再两处漂移；
  sandbox.js 相应重构为引用共享模块。
- data.js 建造序每行新增 `icon` 字段（命中图标集给文件名，没有的回退类别字，
  **不发无谓的图片请求**）。
- 原型模板的 `renderBo` 行内加 `<img class="glyimg">`（有图标替代类别字，
  类别底色仍保留），重跑 `extract-lab-views.mjs` 再生 views.js；
  图例说明仍保留类别色条语义。
- verify-lab-page 建造序步骤新增图标数量断言（≥50，实测 77/77 行全命中）；
  老页面/沙盘两套 e2e 全过，47 个 js 模块全部可达。
```

```build-260922g
*科技时间复查（用户发现与原站差 5 秒）—— 三方数据全部自洽，口径差异 + 一处精度升级
- 复查结论（Eastwatch 2018 的 PersonalCloaking，三方对照）：
  ① 原始事件逐位一致：完成事件双方都在 gameloop 20943 → /22.4 = 15:35（我们 HUD 显示
  的就是完成时刻；原站 upgrades 数组 15:34 差 1 秒舍入）。
  ② 原站「时间轴 14:08」是**研究下令时刻**：他们 buildOrder 的 frame 19017 = 完成帧
  20943 − 研究时长 1926.4 loops（120.4 游戏秒）—— build_times 表逐位吻合。
  ③ 我们建造序视图的 14:03 是 spawningtool 口径提取的**第一条相关指令**，比实际开始
  早 6 秒（玩家先点了一次）。完成时刻才是硬事实；下令时刻带几次点击的解释空间。
- 精度升级：科技进度条时长从 data.json `time`（粗粒度）改为 worker 的
  `BUILD_TIMES[name].loops`（精确研究帧数，`/16 × gameSecFactor` 换算实秒）——
  进度条窗口现在与原站的下令→完成区间逐位对齐（14:09 → 15:35）。
- 科技 chip tooltip 明确「完成 @ mm:ss」语义，避免与建造序的下令时刻混淆。
- 编成行剔除 `Beacon*` 地图信标（老录像里以中立建筑存在，混进了军队编成统计）。
- 沙盘/老页面两套 e2e 全过。
```

```build-260922f
*沙盘 HUD 三连：科技进度条 + APM/EPM + 战损/镜头，外加 HUD 显示开关
- 解析层新增 `ReplayData.tracks`：`commands`（`SCmdEvent`+`SCmdUpdate*` 按**整秒桶**
  聚合的 APM/EPM 双序列）与 `cameras`（`SCameraUpdateEvent` 镜头轨迹扁平表）。
  **APM 口径对齐 starcraft2.ai（实测对拍）**：原站同局平均 APM 97 = (SCmdEvent 1292 +
  SCmdUpdate 1518) / 29 分钟，逐位吻合 —— 即「动作」= 指令 + 目标更新事件。
  镜头坐标实测 world = 原始值 / 64（2018 老 build 同样适用）。
  EPM 无业界统一定义：同签名（能力/事件名+粗粒度目标）≤16 gameloop 连点折叠为 1，
  自洽近似，代码注释里已声明别当官方口径。
- 面板科技行补**进度条**：原始事件只有完成时刻，进行中区间 = [完成−研究时长, 完成)，
  从 data.json 升级表 `time`（16fps 游戏秒）× gameSecFactor **回推**近似（LotV 口径，
  老版本时长可能略有出入）——已在代码与数据透传处注明。
- 面板新增**战损行**（累计损失数 + 最近 10 秒损失图标）；stats 行新增
  **APM / EPM** 实时读数；画布新增**镜头标记**（双方当前屏幕的视野框，
  平面/斜视角都跟随投影变换）。
- 画布图例下新增「HUD 显示」开关行（编成/科技/生产/战损/APM·EPM/资源条/镜头标记
  共 7 项），localStorage 记忆。
- 验收：Eastwatch 20:00 APM 32/45、战损 106/113、科技开关显隐切换断言；
  沙盘/老页面两套 e2e 全过。
```

```build-260922e
*沙盘 HUD 新增「科技」行（用户：科技情况这些我看现在没有）
- 解析层新增 `ReplayData.upgrades`（`SUpgradeEvent` → `{pid, name, time, count}`），
  时间与 `game_length` 同基准；`Spray*` / `RewardDance*` / `GameHeartActive` 等噪声行
  原样保留在数据里，由展示端过滤（⚠️ doc 注释里写 `Spray*/RewardDance*` 会提前闭合
  块注释，tsc 报 30+ 错——本次踩的坑）。
- data.js 透传并补 `zh` 中文名（data.json 的 upgrade 表连内部名都有：zerglingattackspeed
  → 狂狗、PunisherGrenades → 震撼弹）。
- 左上/右上面板新增「科技 N」行：截至当前游标已完成的升级，图标 chips 按完成时间排序、
  超 12 个折叠为 +N，tooltip = 中文名 @ 完成时刻；无图标的升级显示中文名文字 chip。
- 升级名 → 图标映射（`UPGRADE_ICON_MAP`）：`TerranInfantryArmorsLevelN` →
  `TerranInfantryArmorLevelN`（tracker 复数 vs 图标单数）、`TerranVehicleAndShipArmors`
  → `Plating`、`NeosteelFrame` → `NeosteelArmor`、`zerglingattackspeed` → `AdrenalGlands`、
  `BlinkTech` → `Blink`、`PsiStormTech` → `PsionicStorm`、`CentrificalHooks` →
  `CentrifugalHooks`、`PunisherGrenades` → `ConcussiveShells` 等；⚠️ 前缀正则 replace
  会吞掉 `LevelN` 后缀（首版把 `ArmorLevel3` 换成了 `Armor3`），替换串必须带上 `Level`。
- 验收：Eastwatch 20:00 双方科技数 17/10（原站同局终局 24/15，进度吻合）；
  断言 + 截图全过；老页面 e2e 回归全过。
```

```build-260922d
*沙盘对标原站 overview 播放器：斜视角 + 左上/右上面板 + 底部资源条
- 实地用浏览器抓取原站 overview 播放器（ReplayDojo）后复刻三件套：
  ① **斜视角**（默认开，可关）：地图 45° 菱形等距投影（X=(x−y)、Y=(x+y)/2），
  基地位置从矿线聚类推出并画椭圆平台（≥3 个矿/气点的簇），斜视角下按深度（x+y）
  排序绘制保证遮挡关系正确；图标保持直立，死亡涟漪/出生点圈压扁成椭圆。
  ② **左上/右上面板**：玩家名 + 单位/农民/建筑实时计数 + 编成 chips（活体军队按类型
  计数 icon+数量，降序前 10）+ 生产条（建造中建筑带进度条 + 最近 12s 出生单位渐隐）
  + 人口/军队读数，面板外侧玩家色条。
  ③ **底部资源条**：双方 矿/气存量 + 采集率 + 人口，取 stats_series（与图表同口径）。
- 数据交叉验证：Eastwatch 2018 那场 20:00，我们的 HUD 与原站四项全部一致
  （农民 80、建筑 94、人口 200/247、军队价值 11,050）。单位计数口径略宽（含运输/召唤物）。
- 数据上限的如实标注：tracker 没有「生产开始」事件，「生产中」对训练单位只能用
  「最近出生」近似（建筑 born→done 区间是精确的）——已写进代码注释与图例。
- 新增 js/lab/unit_icons.generated.js（由 scripts/gen-unit-icon-manifest.mjs 从
  assets/units/ 生成）：渲染先查名单再请求图标，HUD 的 <img> 不再对缺图名字打 404
  （canvas 兜底静默、DOM 兜底必须显式查表——这次踩的坑）。
- 验收升级：斜视角默认开启断言、面板计数正则、资源条正则；沙盘/老页面两套 e2e 全过，
  46 个 js 模块全部可达。
```

```build-260922c
*沙盘模拟两项升级：单位图标化 + 大画布布局重做
- 新增 assets/units/：222 张 256×256 单位 webp 图标（1.7MB），从 starcraft2.ai 的图标集抓取
  （命名与 tracker 单位名天然一致，含 SiegeTankSieged / MULE / TechLab 等变体）。
  **素材版权归 Blizzard Entertainment，粉丝非商用**（README 与图例均已标注）。
- js/lab/sandbox.js 图标渲染：懒加载 + 36px 预缩放缓存（避免每帧从 256px 缩放）；
  iconKey() 归一化变体（*Flying / *Burrowed / *TechLab / *Reactor / LiberatorAG / ThorAP /
  LurkerMP系 / GhostAlternate / AdeptPhaseShift / BattleHellion / CreepTumorQueen /
  Observer·OverseerSiegeMode / OverlordTransport / OracleStasisTrap / RavagerCocoon）；
  缺图/离线回退到按类别的矢量点阵；归属 = 图标底下的玩家色圆面（军队）/ 外圈（建筑）。
  ⚠️ 踩坑：图标是绘制那一帧才发起请求的，加载完成后若游标不动不会重绘 ——
  onload 里必须标脏（lastT=-1）下一帧才换掉点阵。
- 布局重做（回应「沙盘被固定在小视窗」）：切进沙盘后**整页让位** ——
  录像列表侧栏 / 对局头 / 语音播报条 / 页脚隐藏，1600px 宽度上限解除
  （body.sandboxview 规则，lab.css）；画布高度 = 100vh − 顶栏 − 工具条 − 时间轴
  （1600×1100 视口下从 1310×611 → 1568×818，越高的屏收益越大）。
  录像切换移进沙盘工具条（#sbReplay 下拉，走 views.js 的 focusReplay()）；
  对局头信息压缩为工具条一行（#sbMapInfo）。
- 新增「⛶ 全屏」：对 .wrap 申请 Fullscreen API（时间轴 + 工具条 + 画布一起进全屏），
  .wrap:fullscreen 规则接管画布高度，fullscreenchange 同步按钮文案。
- 验收同步升级：几何契约（全宽 >1400 / 高 >700 / 主体解除上限）、工具条下拉切录像、
  图标加载数断言；全过。verify-lab-page.mjs 老页面回归全过。
```

```build-260922b
*新增「沙盘模拟」视图（第四个视图，纯客户端，不需要任何地图资源）：
- 解析层新增 ReplayData.sandbox（js/worker/decoder/replay_data.ts::buildSandbox）：
  从 tracker 流重建单位级时间线 —— 出生/死亡（含精确死亡坐标）/变形/建造完成 +
  SUnitPositionsEvent 稀疏位置采样。位置事件语义照搬 sc2reader
  events/tracker.py::UnitPositionsEvent（unit_index 从 m_firstUnitIndex 起每三元组
  累加、坐标 ×4）；事件只带 tag 的 index 部分，用「born 建 index→单位、died 清除」
  的活动表映射。时间在 worker 里就换算成与 game_length 同基准的秒（沙盘是第三套
  时间口径之外的「与 game_length 同基准」口径，见 replay_data.ts 头部时间基准表）。
  ⚠️ 实测结论（scripts/research/probe-sandbox-poc.mjs，5 样本含 2018 build 62848）：
  位置事件只上报「在动」的单位（静态单位 0 命中），每 240 gameloop 一批、按索引滚动
  轮转，开局约 2 分钟后才开始出现；坐标极值推地图范围，矿线来自开局中立单位。
  交叉验证：US_TVR 2018 战列巡航舰 born=1079.6s / 首采样 1189.3s 与 starcraft2.ai
  同一场录像的 API 数据完全一致。
- 新增 js/lab/sandbox.js（沙盘视图，手写模块）：canvas 底图（矿/气泉/Xel'Naga 塔/
  可破坏物/出生点，离屏缓存）+ 动态层（建筑方块、军队圆点、农民、阵亡涟漪、变形跟随），
  1/4/8/16× 播放推进全局游标，拖时间轴即定位；与 views.js 刻意零侵入（读 labState、
  写 sandboxSeek、自挂 #viewSeg 监听切 body.sandboxview），views.js 保持可重复提取。
- extract-lab-views.mjs 追加第 5 处断言补丁：sandboxSeek()（沙盘推进全局游标的唯一
  写入口，内部 rAF 节流），已重新提取 views.js。
- index.html 新增「沙盘模拟」按钮与 #sandboxView 容器 + 口径说明；lab.css 新增
  body.sandboxview 显隐规则与沙盘样式。
- 新增验收：verify-sandbox-view.mjs（真实 Chromium + 5 份真实录像：视图切换 / DOM 契约 /
  数据流断言 window.__sandbox / 画布像素采样 / 时间轴联动 / 播放推进 / 切样本重建 / 截图）。
  verify-lab-page.mjs 的 DOM 契约加入沙盘 9 个 id，端到端全过（无回归）；
  verify-replay-data.mjs / verify-worker.mjs / analyze-module-reachability.mjs（45 模块全可达）全过。
- 基线不受影响：sandbox 是新增字段，对拍 diff 由 expected 键驱动，天然忽略。
```

```build-260922
*主页面重做为「录像数据分析台」，砍掉共享录像库，站点转为纯客户端：
- 新增 js/lab/ 三个模块：main.js（编排：文件输入 → 解析 → 适配 → 挂载）、
  data.js（适配层：ReplayData → 视图层形状）、views.js（渲染与交互，由
  scripts/extract-lab-views.mjs 从原型 prototype/data-lab.template.html 逐字节提取）。
- index.html 整页重做：官方回放 overlay 口径的 28 张指标图（39 个 m_scoreValue* 字段）、
  全局时间轴主控（军队价值差镜像包络 + 交战/工人损失事件标记）、8 张读数差值卡、
  原始采样表 + CSV 导出、建造顺序双列视图、语音播报条、悬浮通道。移除 Chart.js CDN 依赖。
- 解析层新增 stats_series（列式，39 字段完整原始采样序列），与 stats[]（逐分钟摘要）
  并存。⚠️ 时间基准改用录像是自己的帧率常量（gameloop / fps），与 game_length 同基准；
  旧 stats[].minute 硬编码 /1.4 的口径错位仅保留在旧字段里，未动（避免破坏对拍）。
- 砍掉共享录像库：index.html 移除导航与上传入口；replays.html、replays_page.js、
  share_upload.js、upload_api.js、telemetry.js、server/ 保留在仓库但不再维护、不再被引用。
- 上一代 UI 模块（app.js / display.js / voice_reader.js / benchmarks.js / batch_rail.js 等）
  保留未删但已无页面引用，仅为回退。
- 新增验收：verify-lab-page.mjs（真实 HTTP + 真实 Chromium + 5 份真实录像的端到端验收，
  含 43 个 DOM 契约 id、跨样本重建、游标联动、建造顺序跳转、语音状态机、悬浮降级、CSV 下载）。
- 新增提取工具：extract-lab-css.mjs / extract-lab-views.mjs（原型 → 生产，带断言式定点替换与自检）。
- **删除全部旧代码**（不再是「保留未引用」）：上一代 UI 的 14 个模块（css/app.css、js/app.js、
  js/batch_rail.js、js/benchmarks.js、js/constants.js、js/display.js、js/display_helpers.js、
  js/export_build.js、js/format_utils.js、js/replays_page.js、js/share_upload.js、js/telemetry.js、
  js/upload_api.js、js/voice_reader.js）与 replays.html。新增 scripts/analyze-module-reachability.mjs
  做依赖闭包核验（连 new Worker / new URL(..., import.meta.url) 这类字符串路径的边都会走），
  现 js/ 下 44 个模块全部可达、零死代码。
- **录像列表改为左侧吸顶侧边栏**（236px，与「指标分组」侧栏同宽；≤1180px 退回顶部横排），
  含「＋ 添加录像」入口与加载状态提示。
- **修掉底部播报条的位置缺陷**：原先 .vb 横跨视口且自己就是 flex 容器，内容从视口左缘起排，
  与居中的主体（max-width 1600）错位 —— 实测 1920 屏偏 142px、2560 屏偏 462px。
  现拆成 .vb（背景层）+ .vbin（内容层，与主体同宽居中）；条高由 ResizeObserver 写入 CSS 变量 --vbh，
  供页面底部留白与各吸顶侧栏扣减（窄屏条会换行变高，写死 84px 会压住内容）。
  ⚠️ 页面底部留白由 &lt;footer class="pagefoot"&gt; 承担 —— 不能写成 body{padding-bottom}，
  因为 lab.css 里有 html,body{height:100%}，body 的 content box 固定为视口高、溢出的内容会**穿过** padding 区。
- 新增 scripts/research/probe-layout.mjs：5 种视口 × 空态/有数据的几何契约探针
  （条贴底 / 与主体对齐 / 不遮挡页脚与侧栏 / 侧栏竖排可滚）。
```

```build-260921
*解析内核替换为 Rust/WASM + TypeScript Worker（正式下线 Pyodide）：
- 新增 js/worker/：MPQ 容器解析、六个事件流的协议解码，以及 build_order / worker_deaths / stats /
  workers_curve / chat 的组装（decoder/replay_data.ts），产出与旧链路 extract_replay_data 同构的 ReplayData。
- 解析从主线程搬进 Web Worker：新增 js/parse_client.js（initParser / parseReplayBufferToData / isParserReady），
  app.js / batch_rail.js / replays_page.js 全部改走 Worker，大录像与多文件批量时页面不再冻结。
- 移除 Pyodide：删除 js/parse_script.js、js/pyodide_boot.js，去掉 index.html / replays.html 的 pyodide.js CDN 引用，
  constants.js 的 PYODIDE_VERSION 与 state.js 的 appState.pyodide 一并移除；首屏不再下载 Python 运行时。
- 旧解析脚本迁至 tools/baseline/parse_script.py，只作为 tests/baseline/ 金标准的生成源保留（离线运行，不进站点）。
- 新增验收脚本：verify-replay-data.mjs（ReplayData 对基线的字段级 diff，parity / 发布两趟口径）、
  verify-worker.mjs（真跑 parse.worker.js 的端到端通道验收）。
```

```build-260419
*前端工程化（零构建拆分）：
- 原单文件 `index.html` 内联样式与脚本，已拆分为 `css/app.css` 与多份 `js/*.js`（ES Module，`js/app.js` 为入口）；行为与 DOM `id` 保持兼容，部署仍为静态文件，无需打包命令。
- 新增 [docs/MAINTENANCE.md](docs/MAINTENANCE.md)，说明各文件职责、解析链路、本地运行与改动的推荐入口。

*批量录像与左侧摘要：
- 文件选择框支持 `multiple`，拖放区可一次接收多个录像；解析队列在浏览器内顺序执行，避免临时文件路径冲突。
- 左侧为圆角悬浮面板（类似独立浮窗），展示每场摘要并可切换当前详单；宽屏下可拖动右缘调整宽度；窄屏下列表以流式区域展示，隐藏拖宽手柄。

*说明与修复：
- README 补充「项目结构」表、本地 HTTP 注意事项；修复入口 `app.js` 对 `collectSc2ReplayFiles` 的导入路径（应从 `format_utils.js` 引用）。
```

```build-260412
*对局分析图表（README说明补全）：
在「功能概述」中写明五类 Chart.js 图表的含义、数据来源（Tracker / workers_curve）及展示条件。

*建造顺序语音播报（Build Order Reader）：
-语音步骤与左侧建造列表使用同一套时间排序；修复 Python 将「星空加速 / recall」追加在 build_order 末尾导致未排序时，播报顺序与界面不一致、甚至出现跳到后期步骤的问题。
- Document画中画改为横向信息条：大号计时、当前步骤与多步预览、双进度条；PiP 内不展示语速/语言等设置；支持随窗口缩放、主面板「画中画字号」调节（localStorage 记忆）；PiP 内提供「开始 / 暂停」。
- 语音合成：同一定时周期内只前进一条播报，避免同秒多条瞬间入队；新一条播报前 cancel 队列，减轻叠音；拖动时间轴过程中仅同步进度不播报，松手后再播当前步。
- 「星空加速」类步骤的朗读文案缩短为「加速加某建筑」式读法，减轻 TTS 冗长与异常感。

*建造列表：已移除「显示初始化事件」开关及对 0 秒事件的过滤（与 spawningtool 整理后的数据一致，见 build-260310 日志）。
```

```build-260310
*虫族单位开始时间修正:
sc2reader 对虫族单位（通过幼虫孵化）的 started_at 没有做「建造时间回推」，
导致 start_time 和 finish_time 相同，都是「孵化完成时刻」。采用回推策略，
将 start_time 设置为孵化开始时刻，finish_time 设置为孵化完成时刻。

*建造列表：不再提供 “显示初始化事件” 开关及对 0 秒事件的过滤；后端使用 spawningtool 等已整理好的建造顺序，直接按数据展示。

*前端时间轴渲染调整:
时间轴排序与展示逻辑统一基于修正后的 start_time / finish_time。
```

