<div align="center">

<img src="assets/banner.png" alt="SC2 Replay Online Analysis" width="720">

# 星际争霸Ⅱ 录像在线分析台

**纯前端本地解析 · 零上传 · 实战指标复盘 · 建造顺序 · 沙盘模拟 · 语音播报 · Windows 桌面悬浮窗**

[![Build WASM + Worker](https://github.com/ProbiusOfficial/sc2replay_online_analysis/actions/workflows/build-wasm.yml/badge.svg)](https://github.com/ProbiusOfficial/sc2replay_online_analysis/actions/workflows/build-wasm.yml)
[![Build Overlay (Windows)](https://github.com/ProbiusOfficial/sc2replay_online_analysis/actions/workflows/build-overlay.yml/badge.svg)](https://github.com/ProbiusOfficial/sc2replay_online_analysis/actions/workflows/build-overlay.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**在线使用 → [rep.probius.xyz](https://rep.probius.xyz/)**

</div>

---

把 `.SC2Replay` 拖进浏览器，就能得到一场完整的复盘：**解析、指标、建造顺序、沙盘重演、语音播报全部在本地完成**，任何文件都不会离开你的电脑。

如果你还想「对着打一遍」，可以选装一个 Windows 桌面悬浮窗 —— 把这份录像的建造顺序钉在《星际争霸Ⅱ》画面上，边打边对照。

## ✨ 功能总览

| 模块 | 说明 |
| --- | --- |
| 📊 **数据分析** | 官方回放 overlay 口径的 `SPlayerStatsEvent` 全部 39 个计分字段，呈现为 28 张实战指标图（矿/气采集、人口、工人、军队价值、支出、损失…）；跨玩家时间网格对齐；原始采样表 + CSV 导出 |
| 📋 **建造顺序** | 双列视图，按建筑 / 单位 / 科技 / 农民筛选，精确到卵（Egg）起点的计时，中英文名切换，与全局时间轴联动跳转 |
| 🗺 **沙盘模拟** | Canvas 重演整场对局：单位实时位置、滚轮以光标为锚缩放、自由平移、血条与阵营配色、随全局时间轴推进 |
| 🔊 **语音播报** | Web Speech API 中文朗读建造序列，倍速可调，随全局时间轴推进、切对象不打断 |
| 💬 **对局聊天** | 完整聊天记录，按时间轴对齐回看 |
| 🖥 **桌面悬浮窗** | 可选 Windows 组件：把建造顺序做成游戏画面上的置顶透明浮层（见下文） |

**解析能力**：MPQ 容器（Rust/WASM 解压）+ Blizzard 官方协议六流解码（TypeScript 实现），多版本录像兼容（实测覆盖 build 62848 ~ 97563）；解码结果与官方 `s2protocol` 逐字节对拍验收。

## 🚀 快速开始

**在线使用**：打开 [rep.probius.xyz](https://rep.probius.xyz/)，把 `.SC2Replay`（可多选）拖进页面即可 —— 解析在浏览器本地完成，不上传任何文件。

**本地运行**：站点是零构建的纯静态资源，任意静态服务器即可。

```bash
git clone https://github.com/ProbiusOfficial/sc2replay_online_analysis.git
cd sc2replay_online_analysis
python -m http.server 8080
```

浏览器打开 `http://127.0.0.1:8080/`，把 `.SC2Replay` 拖进页面。

> ⚠️ 请通过 HTTP 访问（ES Module 与 `fetch("data.json")` 在 `file://` 下不可用）。浏览器要求 Chrome / Edge 等现代 Chromium 内核。

## 🖥 桌面悬浮窗（可选 · Windows）

**不装也完全不影响任何功能** —— 装了之后，分析页的建造顺序可以变成一颗钉在《星际争霸Ⅱ》画面上的**置顶透明浮层**，跟着录像的建造节奏边打边练。

### 下载

| 渠道 | 地址 |
| --- | --- |
| 稳定下载 | [rep.probius.xyz/download/sc2-overlay.exe](https://rep.probius.xyz/download/sc2-overlay.exe)（附 [sha256 校验](https://rep.probius.xyz/download/sc2-overlay.txt)） |
| 构建产物 | [Actions · Build Overlay (Windows)](https://github.com/ProbiusOfficial/sc2replay_online_analysis/actions/workflows/build-overlay.yml) 每次构建的 artifact |

### 功能

- **三种版式**：条形（默认，32px 紧凑贴边）/ 双行 / 竖向贴边
- **两种底板**：实底卡片 / 纯文字覆盖 —— 无底板，仅文字与单位图标浮于游戏之上（Oopz / Discord 游戏内覆盖式）
- **单位图标**：内置全量单位/建筑/升级图标，按解析出的建造项自动匹配
- **跟随游戏窗口**：自动吸附游戏右上角；手动拖动后按你拖的位置跟随，位置持久化
- **游戏开始自动起表**：推送后武装待命，切进游戏瞬间从 0:00 起表；时钟按游戏速度倍率（Faster 1.4×）推进，与实战建造节奏对齐
- **全局热键**：`Alt+↑` 播放/暂停 · `Alt+↓` 重置 · `Alt+←/→` ±10s（游戏有焦点也可用）
- **托盘菜单**：显示隐藏 / 播放控制 / 鼠标穿透 / 跟随 / 仅游戏内显示 / 重置位置 / 协议注册 / 退出
- **自走时钟**：脚本推送后独立走表，关掉浏览器也不停
- **单实例 + 协议唤起**：重复启动自动合并；`sc2overlay://` 协议可从浏览器一键唤起
- **自包含**：单文件 exe，无需安装运行时

### 使用要求

1. SC2 显示模式设为 **「窗口模式（最大化）」** —— 独占全屏下第三方窗口不渲染（Windows 合成机制边界，OBS 等工具同理）
2. 首次从网页推送时，允许浏览器的「本地网络访问」权限
3. exe 为未签名构建，部分杀软可能提示 —— 构建过程全部公开可查（Actions 日志 + sha256），介意可自行编译

### 工作方式

分析页与悬浮窗通过 `127.0.0.1:18760` 本地回环通信（HTTP + SSE）：**浏览器负责解析与准备播报脚本，悬浮窗负责显示与走时钟** —— 脚本推送后悬浮窗独立运行，浏览器关闭也不影响。不注入游戏进程、不读取游戏内存、不修改任何游戏文件。

## 🏗 工作原理

```
.SC2Replay 文件（本地）
   │  拖入浏览器
   ▼
┌──────────────── 浏览器（全部本地计算） ───────────────┐
│ Rust/WASM：MPQ 容器 + bzip2 解压                      │
│ TypeScript：Blizzard 协议六流解码 → ReplayData        │
│ 视图层：28 张指标图 / 建造顺序 / 沙盘 / 语音播报       │
└──────────────┬────────────────────────────────────────┘
               │ 127.0.0.1:18760（可选，HTTP + SSE）
               ▼
┌──────────────── sc2-overlay.exe（Go + WebView2） ──────┐
│ 置顶透明浮层 · 自走时钟 · 全局热键 · 托盘 · 跟随游戏   │
└─────────────────────────────────────────────────────────┘
```

## 🛠 本地开发

### 站点（零构建）

仓库里的 `wasm/pkg/` 与 `js/worker/**/*.js` 产物由 CI 回仓，本地无需 Rust / TypeScript 工具链，静态服务器即可开发调试。视图层代码由原型模板提取生成：改 `prototype/data-lab.template.html` 后重跑 `node scripts/extract-lab-views.mjs`。

### 桌面悬浮窗

```bash
cd overlay
go build -tags desktop,production -o sc2-overlay.exe .
```

依赖：Go 1.24+、Windows 10+（WebView2 运行时）。**必须带 `-tags desktop,production`**，裸 `go build` 会弹出 Wails 错误框。

### 图标资源管线

单位/建筑图标素材（`assets/units/`）黑底需抠成真透明，且解析器单位名与图标文件名不同构（`VikingFighter→Viking`、`LurkerMPEgg→Lurker`、`Armors→Armor`…）：

```bash
python scripts/gen-overlay-icons.py          # 生成透明副本 + icons.json 映射表
python scripts/gen-overlay-icons.py --check  # 校验映射与副本一致性
```

### 测试与验收

```bash
node scripts/verify-mpq.mjs           # MPQ 容器 + bzip2（5 录像 × 75 文件条目）
node scripts/verify-protocol.mjs      # 协议解码 vs 官方 s2protocol 逐字节对拍
node scripts/verify-build-order.mjs   # 建造顺序口径（178 断言，含 Egg 起点）
node scripts/verify-replay-data.mjs   # ReplayData 全字段 vs 基准（约 3 万叶值）
node scripts/verify-worker.mjs        # Worker 端到端 + 契约诚实性
node scripts/verify-lab-page.mjs      # 生产页面端到端（真实 Chromium）
node scripts/verify-sandbox-view.mjs  # 沙盘视图（真实录像 + 截图）
```

## ⚙️ 自动构建流水线

| Workflow | 触发 | 产物 |
| --- | --- | --- |
| `build-wasm.yml` | `wasm/`、`js/worker/`、验收脚本变更 | wasm + Worker TS 产物回仓（Pages 直接可用） |
| `build-overlay.yml` | `overlay/`、图标管线变更 | `sc2-overlay.exe` 构建 + gofmt/vet + 冒烟测试（启动并探测 `/health`）+ sha256，回仓 `download/` 并上传 artifact |

两条流水线均公开可查：构建参数、冒烟输出、校验和全部在 Actions 日志中可见。

## 📁 目录结构

```
├── index.html              # 分析台入口（零构建静态页）
├── css/lab.css             # 主设计系统
├── js/
│   ├── lab/                # 视图层（views.js 由原型模板提取生成）
│   ├── parse_client.js     # 解析门面（Worker 生命周期）
│   └── worker/             # MPQ / 协议解码（TS，CI 转译）
├── wasm/                   # Rust：MPQ + bzip2（wasm-pack）
├── overlay/                # 桌面悬浮窗（Go + Wails v2 + WebView2）
│   ├── frontend/dist/      # 悬浮页 + 单位图标（真透明副本）+ icons.json
│   ├── main.go             # 入口：窗口选项 + 单实例 + 协议转发
│   ├── app.go              # 本地服务 / 版式锚定 / 模式看护
│   ├── tray.go             # 托盘菜单
│   ├── hotkey.go           # 全局热键
│   ├── sse.go              # /live 状态回推
│   └── win32.go            # Win32 直调（ex-style / 热键 / 进程识别）
├── prototype/              # 设计原型（views.js 的提取来源）+ 悬浮窗规格稿
├── assets/units/           # 单位图标素材（黑底原版，透明副本由管线生成）
├── scripts/                # codegen / 验收 / 提取 / 图标管线
├── tests/                  # 金标准基线 + 端到端截图
├── docs/                   # 维护说明与调研报告
└── download/               # CI 构建的悬浮窗 exe（自动更新）
```

## 🔒 隐私与合规

- **零上传**：解析、存储、播报全部在浏览器本地完成；悬浮窗通信只走 `127.0.0.1` 回环
- **反作弊边界**：悬浮窗不注入游戏进程、不读取游戏内存、不修改游戏文件 —— 只是一个显示自己数据的置顶窗口；请在窗口化全屏下使用，定位为**练习与复盘工具**
- **素材版权**：单位/建筑图标版权归 Blizzard Entertainment 所有，本项目粉丝非商用

## 🙏 致谢

- [Blizzard s2protocol](https://github.com/Blizzard/s2protocol) — 协议定义与解码基准
- [sc2reader](https://github.com/GrayFace/sc2reader) / [spawningtool](https://github.com/stoiclaw/spawningtool) — 解析语义对拍基线
- [SC2_Coop_Overlay](https://github.com/daydreamofscience/SC2_Coop_overlay) — 架构先例
- [starcraft2.ai](https://starcraft2.ai) — 单位图标素材
- 炉石传说灰维基 — 中文译名参照
- [Wails](https://wails.io) — 桌面壳框架

## 📄 许可证

[MIT](LICENSE) © 探姬_Official
