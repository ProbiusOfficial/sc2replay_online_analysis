# 置顶悬浮窗（Overlay）实现方案调研

> 结论日期：2026-09-22 ｜ 场景：SC2 录像分析站的「建造顺序语音播报浮层」
> 目标平台：**Windows**（本机开发环境是 macOS，所有 Windows 行为均标注了证据强度）
>
> ⚠️ **行号引用说明（2026-09-22 晚补）**：本文 §2「现状」一节引用的
> `js/voice_reader.js:299-393`、`index.html:119` 等**已被删除** —— 同日完成 UI 重构，
> 上一代 UI 的 14 个模块与 `replays.html` 已从仓库移除。等价实现在
> `js/lab/views.js`（`openPip()` / 悬浮探测与降级）与 `prototype/overlay-exe.html`（视觉规格稿）。
> 结论与方案部分**不受影响**，行号仅作历史定位。

---

## 0. 结论先行

| 判断 | 内容 | 置信度 |
| --- | --- | --- |
| **走哪条路** | **外置 Windows 组件**（独立 exe，置顶 + 逐像素透明 + 点击穿透 + 不抢焦点），网页只负责分析并把播报脚本推给它 | 高 |
| **不能走哪条路** | **往 SC2 进程注入**（DLL / DirectX hook）。SC2 由 **Warden** 保护，注入是封号级风险，且 Blizzard 明确把「未修改的客户端」写进 EULA | 高 |
| **最大的隐藏坑** | **Chrome 142（2025-10）起对「公网页面 → 环回/局域网地址」加权限门**，`ws://127.0.0.1` 也会被拦。这不是理论问题，是 2026 年的既成事实 | 高（官方博客）/ 中（WebSocket 覆盖时点） |
| **最稳的架构** | 让组件**自己托管分析页**（`http://127.0.0.1:PORT`），则**同源**，LNA / CORS / 混合内容三个问题同时消失；公网静态站退化为「未装组件时的纯分析模式」 | 高 |
| **技术上做不到的** | 独占全屏（Exclusive Fullscreen）下第三方窗口不可见。**必须在 SC2 里选「窗口化全屏 / Windowed Fullscreen」** | 高（多来源一致）/ 未在 SC2 实测 |
| **现在这一版的定位** | demo 已实现**真实探测 + 真实降级**：探测不到组件时自动退回浏览器 Document 画中画（即线上现有实现），并如实标注走的是哪条路 | 已验证 |

---

## 1. 我们现在的「悬浮框」到底是什么

不是自研的浮窗，是 **Document Picture-in-Picture（Document PiP）**。

| 位置 | 内容 |
| --- | --- |
| `index.html:119` | `<button id="pipBtn" title="打开悬浮小窗（浏览器 Document 画中画）">悬浮模式</button>` |
| `index.html:96-114` | `.voice-reader-pip-strip` —— PiP 窗口里实际显示的那条精简带（时间 / 当前步 / 前后文 / 开始暂停） |
| `js/voice_reader.js:299-393` | `requestPiP()`：`window.documentPictureInPicture.requestWindow({ width: 560, height: 120 })`，把 `#voiceReader` 整个 DOM 搬进新窗口，并把主文档的 `styleSheets` 逐条复制过去；另有内联 CSS 兜底 |
| `js/voice_reader.js:419-425` | 不支持时回退到 `<video>.requestPictureInPicture()`，再不行 `alert("当前浏览器不支持悬浮模式（Document画中画）")` |

### 它的能力边界

| 能力 | Document PiP | 说明 |
| --- | --- | --- |
| 系统级置顶 | ✅（浏览器负责） | 本机 macOS Chrome 打开成功（见 §8 证据），但「是否真置顶 / 能否盖住全屏」**本次未实测** |
| 逐像素透明 / 圆角 | ❌ | 窗口背景固定，做不出透明浮层 |
| 点击穿透 | ❌ | 只能开关整窗交互，做不到「透明处穿鼠标」 |
| 不抢焦点 | ❌ | 点一下悬浮窗 = 游戏丢输入 |
| 盖住独占全屏游戏 | ❌ | 宿主是浏览器窗口 |
| 全局热键 | ❌ | 浏览器只在自己的前台时收键 |
| 尺寸 / 位置 / 字号 | ⚠️ 受限 | 只能给初始尺寸；`voice_reader.js` 只能用 `--voice-pip-font-scale` 缩放字号、用 `clamp()` 自适应 |
| 安装成本 | ✅ 零 | 这正是它唯一不可替代的优点 |

### ⛔ 这份天花板是**规范写死的**，不是 Chrome 偷懒

2026-09-22 补：读了 [WICG Document Picture-in-Picture 规范](https://wicg.github.io/document-picture-in-picture/) 后确认，
上面表格里那些 ❌ 大多来自规范的 **§3.2 Security Considerations —— 「防冒充」是强制性要求**：

| 规范条款 | 原文要点 | 我们受到的约束 |
| --- | --- | --- |
| **§3.2.2 Origin Visibility** | 「It is **required** that the user agent makes it clear to the user **which origin is controlling** the DocumentPictureInPicture window **at all times**」 | **标题栏 + origin 去不掉。** 这就是截图里 `127.0.0.1:60966` 出现在浮窗顶部的原因，HTTPS 站点会显示成自己的域名 |
| **§3.2.1 Positioning** | `moveTo()` / `moveBy()` **必须被禁用** | 窗口位置**不能由网页决定**，用户自己拖 |
| **§3.2.3 Maximum size** | UA **必须**限制最大尺寸，防止网页用置顶窗盖满屏幕 | 做不出全屏浮层 |
| **§3.2.4 Fullscreen** | `requestFullscreen()` 在 PiP 窗口内**必须被禁用** | 同上 |
| §3.3 / 规范正文 | 只有**一个** PiP 窗口；PiP **不能比 opener 活得久**（关标签页 / 刷新即关） | 多浮层不可能；页面一刷新浮层就没了 |

另外两条实测/社区确认的行为：

- **PiP 窗口会抢键盘焦点**（WICG issue #146）→ 印证「不抢焦点做不到」。
- 浏览器支持面：**Chrome/Edge/Brave/Vivaldi/Arc 116+、Opera 102+、Firefox 151+（2026 年才加）**，
  **Safari（含 macOS）不支持**。截至 2026-08 全球覆盖率约 **26%**。

> ✅ **唯一能优化的一项**：`requestWindow({ disallowReturnToOpener: true })` 可以把标题栏里的
> **「返回标签页」按钮**藏掉。标题栏本身仍在。**本项目的 demo 已加上这一项。**

**结论：PiP 适合「零安装、凑合能用」，不适合「游戏内陪着练」。** 你的判断是对的 ——
而且现在可以说得更硬：**这不是可以靠 hacks 绕过的实现细节，是浏览器防止钓鱼的强制设计。**
想要「干净的浮窗」，就必须离开浏览器。

---

## 2. 六类实现方案的能力矩阵

| # | 方案 | 系统置顶 | 逐像素透明 | 点击穿透 | 不抢焦点 | 盖住独占全屏 | 全局热键 | 需安装 | 反作弊风险 | 代表 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | **Document PiP** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | 无 | 无 | 我们现在的实现 |
| B | **普通弹窗 / PWA 独立窗** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | 无 | 无 | `window.open` |
| C | **桌面壳置顶窗**<br>WPF / WinForms / Wails / Tauri / Qt | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | exe | 无（不碰游戏） | BongoCat、SnapShelf、**SCO** |
| D | **分层透明点击穿透窗**<br>（C 的 Windows 原生加强版） | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | exe | 无 | 各类 HUD / 字幕工具 |
| E | **进程内注入型 overlay** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 安装平台 | **高（SC2 勿用）** | Overwolf / ow-electron、RTSS、Discord |
| F | **流媒体浏览器源** | 仅直播画面内 | ✅ | — | — | — | — | OBS | 无 | OBS Browser Source、Metal Max |
| G | 第二屏 / 外置设备 | — | — | — | — | — | — | — | 无 | 手机端 companion |

**C/D 是同一族**：D 只是把 C 所需的 ex-style 讲清楚。**C/D 不需要注入、不读游戏内存，因此对 Warden 完全透明** —— 这才是 SC2 场景唯一可行的「游戏内浮层」。

E 类里 **Overwolf 明确不能在独占全屏之外的地方帮我们**：它是注入型（D3D11/D3D12 走 GPU 共享纹理、D3D9/OpenGL/Vulkan 走 CPU 拷贝），支持游戏是白名单制（LoL / Valorant / WoW / ARK …），**SC2 不在其中**，且需要游戏方做 SDK 集成。**放弃 E。**

F 类值得作为**第二条发布渠道**：SCO 与 Metal Max 都提供「同一份 HTML 也能丢进 OBS 当浏览器源」，主播零成本复用。我们也可以。

---

## 3. 关键技术机制（Windows）

### 3.1 三件套扩展样式

```c
LONG ex = GetWindowLongPtr(hwnd, GWL_EXSTYLE);
SetWindowLongPtr(hwnd, GWL_EXSTYLE, ex
    | WS_EX_LAYERED       // 0x00080000  允许透明/分层
    | WS_EX_TRANSPARENT   // 0x00000020  鼠标穿透到下层窗口
    | WS_EX_NOACTIVATE    // 0x08000000  永不成为前台窗口（否则点一下就丢游戏输入）
    | WS_EX_TOOLWINDOW);  // 0x00000080  不进任务栏、不进 Alt+Tab
```

- `WS_EX_TRANSPARENT` **必须与 `WS_EX_LAYERED` 同用**才生效 —— 这条在 Microsoft 的专利文档里写得很直白（引 §10-1）。这是「点击穿透」的官方口径。
- `WS_EX_NOACTIVATE` 是**最容易被漏掉、后果最严重**的一条。它解决的是「点一下悬浮窗 → 游戏失去焦点 → 你十分钟没操作」。
  - 配套：显示时用 `ShowWindow(hwnd, SW_SHOWNOACTIVATE)`，`SetWindowPos` 带 `SWP_NOACTIVATE`。
- 需要「部分区域可点、透明区域穿透」时，**不要用全局 `WS_EX_TRANSPARENT`**：改成逐像素 alpha + 自己做 alpha 命中测试（见 §3.3）。

### 3.2 置顶，以及「置顶为什么会丢」

```c
SetWindowPos(hwnd, HWND_TOPMOST, 0,0,0,0,
             SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE|SWP_ASYNCWINDOWPOS);
```

`HWND_TOPMOST` 只保证在「普通窗口」之上，**不保证永远最上**。会丢的情况：别的 topmost 窗口出现、UAC 提权提示、全屏应用切换、显示模式/分辨率变化。

处理原则（来自 Microsoft 指引 + 实作经验）：

- **不要定时轮询强抢 topmost**。那会与系统/驱动的全屏状态互相打架，典型症状是游戏闪一下或窗口闪烁（OBS 论坛早年那条「用 timer 强置顶导致游戏窗口出问题」就是这个）。✅ 有实证
- 正确做法：监听事件，按需重夺：
  - `SetWinEventHook(EVENT_SYSTEM_FOREGROUND, ...)` —— 前台窗口变了
  - `EVENT_OBJECT_LOCATIONCHANGE` —— 目标窗口移动/改尺寸时同步悬浮窗位置
  - `WM_DISPLAYCHANGE` / `WM_DPICHANGED` —— 分辨率、DPI 变化时重建分层位图
- 也可以拦 `WM_WINDOWPOSCHANGING` 做防御性回夺（进阶，非必需）。

### 3.3 透明度：两种做法

| 做法 | API | 特点 |
| --- | --- | --- |
| 色键 + 整体 alpha | `SetLayeredWindowAttributes(hwnd, colorKey, alpha, LWA_COLORKEY\|LWA_ALPHA)` | 简单。**边缘有锯齿**，色键会误伤同色像素 |
| **逐像素 alpha** | `UpdateLayeredWindow()` | 平滑、可圆角、可阴影。**推荐**；代价是要自己管位图与重绘 |

现代做法（**推荐给我们的场景**）：不要手撸 Win32 绘制。用 **WebView2 承载 HTML**，让 CSS 负责视觉：

- Tauri：`transparent: true` + `decorations: false` + `alwaysOnTop: true` + `skipTaskbar: true`
- Wails v2：`Frameless: true` + `AlwaysOnTop: true` + `windows.Options{ WebviewIsTransparent: true, WindowIsTranslucent: true }`
- Qt（SCO 用的就是这个）：`Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.WindowTransparentForInput | Qt.Tool`

好处：**UI 用我们已经在用的 HTML/CSS 写，视觉 100% 一致**，不用学两套排版。

⚠️ 实战坑（Tauri 社区实作记录，可迁移）：
- **`hide()` 会杀掉 Acrylic/亚克力背景效果**，`show()` 回来效果就没了 → 用「移出屏幕外」代替 `hide()`。
- **WebView2 只在窗口被 DWM 合成过之后才注册 OLE 拖放目标**。若首次 `show()` 发生在拖拽进行中，drop 事件永远不来 → 开局就 `visible:true` 但把窗口停到 `x:-10000`。
- `transparent: true` 是亚克力/毛玻璃的前提，二者不能分开。

### 3.4 只在「该显示的时候」显示

悬浮窗跟着桌面显示，切到浏览器/IDE 还杵在那儿就很烦。做法：

```c
// 1) 监听前台窗口变化
SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, NULL, cb, 0, 0,
                WINEVENT_OUTOFCONTEXT);

// 2) 回调里比对前台窗口属于哪个进程
HWND fg = GetForegroundWindow();
DWORD pid; GetWindowThreadProcessId(fg, &pid);
// 等价可读名字：QueryFullProcessImageName / GetProcessImageFileName
if (imageName == L"SC2_x64.exe") { ShowWindow(hwnd, SW_SHOWNOACTIVATE); syncRect(fg); }
else                              { ShowWindow(hwnd, SW_HIDE); }
```

比定时轮询高效得多，且能实时感知焦点切换。（`psutil` 做同样的事 —— SCO 就依赖它。）

### 3.5 独占全屏 vs 窗口化全屏（**这条决定生死**）

- **独占全屏**：游戏直接接管显示设备，DWM 合成被绕过，**所有 `WS_EX_LAYERED` 窗口不渲染**。第三方窗口不可能稳定显示，除非注入（E 类）。
- **窗口化全屏 / Borderless**：走 DWM 合成，置顶窗口正常工作。

SC2 客户端里就叫「**全屏（窗口化）/ Fullscreen (Windowed)**」。这是**唯一需要用户配合的一步设置**，所以组件里应该主动检测并在 UI 上提示。

旁证：
- SCO README 明写「In StarCraft II set display mode to Windowed fullscreen (borderless)」（§10-4）
- OBS 论坛：SC2 全屏模式下只捕获到黑屏，**只有 windowed / fullscreen windowed 能捕获**（§10-5）
- 通用结论：「无法在不与游戏协作的前提下，把普通顶层窗口稳定压在独占全屏的游戏之上」——只有进程内渲染或注入/驱动级手段可行（§10-2）

### 3.6 全局热键（为什么必须放在 exe 里）

`Alt+↑/↓/←/→` 现在绑在 `window` 上（`voice_reader.js` 里 `handleVoiceKeys`）。**游戏有焦点时这些键根本到不了浏览器。** 必须由进程调：

```c
RegisterHotKey(hwnd, HOTKEY_PLAY, MOD_ALT|MOD_NOREPEAT, VK_UP);
// 热键回调走 WM_HOTKEY，不依赖焦点
```

SCO 的依赖清单里有 `keyboard==0.13.5`（一个全局键盘钩子库），做的正是这件事。

### 3.7 高 DPI 与多显示器

- 必须声明 **Per-Monitor DPI Awareness v2**，否则在多屏不同缩放下悬浮窗位置会偏移。
  症状：**位置差 ~50px**，根因是 `SetWindowPos` 传的是逻辑坐标而不是物理像素；用 `GetDpiForWindow()` 核对。
- 用 `GetWindowRect(fg)` 拿游戏窗口矩形再 `SetWindowPos` 同步 —— 注意用**同一坐标系**。

### 3.8 两个「专业性」细节

- **不要出现在直播/录屏里** → `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)`（Win10 2004+）
- **要出现在直播里**（主播场景）→ 反过来，并考虑 OBS 浏览器源方案

### 3.9 工程杂项

单实例锁（自定义协议每次都会起新进程）、托盘图标 + 退出、开机自启、配置持久化（位置/透明度/字号/热键）。

---

## 4. 浏览器 ↔ 本地程序 的通道

### 4.1 四种通道

| 通道 | 网页能发 | 原生能推 | 说明 |
| --- | --- | --- | --- |
| **localhost HTTP + WebSocket** | ✅ | ✅ | **主力**。双向、实时、可传 JSON |
| **自定义 URI Scheme** | ✅（单向，仅唤起） | ❌ | 适合「启动组件 / 传一个小 payload」，不适合传 666 条建造顺序 |
| **命名管道 / 共享内存** | ❌ | ❌ | **沙箱内的网页完全没有文件系统/管道 API**，这条路对纯网页不存在 |
| **宿主进程内 WebView** | — | — | 组件自己渲染页面 ⇒ **零 IPC**。最稳，但页面就只在组件里能看 |

> ⚠️ 「网页直接读写命名管道」这个方案不成立，不要在设计里写。浏览器沙箱不暴露这类能力；能用的只有网络与自定义协议。

### 4.2 【2026 新政策】Chrome 的 Local Network Access（LNA）

**这是本次调研中最重要、最容易踩的一条。**

**是什么**：限制网页向「本地网络 / 环回」地址发请求，需用户显式授权。基于 [WICG/local-network-access](https://github.com/WICG/local-network-access) 规范。

**地址空间划分**：

| 空间 | 例子 | 公网页面访问时 |
| --- | --- | --- |
| Loopback | `127.0.0.0/8`（含 `127.0.0.1`）、`::1/128` | **触发 LNA 权限** |
| Local | `192.168.x.x`、`10.x.x.x`、`172.16-31.x.x`、`169.254/16`、`fc00::/7`、`fe80::/10`、`.local`、`100.64.0.0/10` | **触发 LNA 权限** |
| Public | 其余 | 不受限 |

**时间线**：

| 版本 | 时间 | 覆盖范围 | 来源强度 |
| --- | --- | --- | --- |
| Chrome 138 | 2025 | 初始版本，需开 `chrome://flags/#local-network-access-check` | 官方博客 |
| **Chrome 142** | **2025-10** | **正式 rollout**：`fetch` / XHR / 子资源 / 子框架导航 | **官方博客** |
| Chrome 147 | 2026-04 | 扩展到 **WebSocket** | ⚠️ 二手来源，**未经官方文档确认，建议实测** |

**为什么会踩**：公网 HTTPS 站点 → `ws://127.0.0.1:18760`。LNA 覆盖 WebSocket 之后，**用户拒绝或忽略提示，请求会静默失败** —— 抓不到可靠的 console 错误，也拿不到预期的 reject。这是最难 debug 的一种失败。

> **⚠️ 2026-09-23 实测勘误**：`targetAddressSpace: 'local'` 对 `127.0.0.1` 目标会被新版
> Edge/Chrome 拒绝（声明 'local' 与资源实际所在 'loopback' 空间不匹配 → CORS block，
> 连请求都不发出）。环境回环页面无需声明；公网页面应声明 `'loopback'`。
> 实测现象与修复见 `docs/MAINTENANCE.md` 悬浮组件一节。

**正确的应对（按优先级）**：

1. **让页面本身就来自环回地址**（组件托管页面）。`http://127.0.0.1:PORT` → `http://127.0.0.1:PORT` 是**同源**，LNA 管的是「public → local」，同源根本不跨空间。**这是唯一能绕开整类问题的做法。**
2. 保留公网站点时：**先用一次 `fetch()` 主动触发权限提示，拿到授权后再开 WebSocket**。LNA 权限是 per-origin 持久化的，用户授权一次即可。
   ```js
   // 1) 显式声明目标是本地网络 → 同时解决两件事：
   //    ① 触发 LNA 权限提示；② 豁免混合内容检查（否则 HTTPS 页面打 HTTP 会被拦）
   await fetch("http://127.0.0.1:18760/health", {
     targetAddressSpace: "local",
   });

   // 2) 授权拿到后再开长连接
   const ws = new WebSocket("ws://127.0.0.1:18760/live");
   ```
3. 查权限状态：`navigator.permissions.query({ name: "local-network-access" })`
4. 企业环境：`LocalNetworkAccessAllowedForUrls` / `LocalNetworkAccessBlockedForUrls` 策略；临时逃生阀 `LocalNetworkAccessRestrictionsTemporaryOptOut` **在 M152 之后移除**。

> 细节：`targetAddressSpace: "local"` 是 Chrome 扩展的 fetch 选项；在别的浏览器上被忽略（不会报错）。**但在 HTTPS 页面上打 HTTP 环回时，它是混合内容豁免的必要条件** —— 这一条官方博客写得很明确。

**降级设计**：权限被拒时，页面不能装作没事。必须显式提示「本地悬浮不可用，已退回浏览器画中画」。

### 4.3 自定义 URI Scheme（唤起用）

注册表：

```reg
[HKEY_CLASSES_ROOT\sc2overlay]
"URL Protocol"=""
[HKEY_CLASSES_ROOT\sc2overlay\shell\open\command]
@="\"C:\\Path\\To\\overlay.exe\" \"%1\""
```

要点：

- 弹「是否允许打开此应用」确认框，**页面代码无法绕过**；但 Chromium 84+（Edge 84+）恢复了「**始终允许**」复选框，且**按「站点 + 协议」分别记忆**，仅对安全来源（HTTPS / HTTP-to-localhost / file）可用 → 用户点一次就不会再烦。
- Firefox 默认不放行，需要 `network.protocol-handler.external.<scheme>`；会更明显地弹权限询问。
- Edge 85+ 有 `AutoLaunchProtocolsFromOrigins` 组策略；Edge 96+ 内置 `AutoLaunchProtocolsComponent` 白名单。
- **每次唤起都会起一个新进程** → 组件必须做**单实例**，第二个实例把 URL 转交给第一个再退出。
- 参数要 `encodeURIComponent`；`command` 里的 `%1` 必须带引号（路径含空格会废）。
- 未签名的自编译 exe 容易被杀软拦 → **要发出去就得代码签名**。
- 方案名别用 `myapp`，用 `com.xxx.sc2overlay` 这类不通用的名字，降低被恶意页面探测利用的面。

### 4.4 端口的那些事

- 只绑 `127.0.0.1`，**绝不 `0.0.0.0`**。
- 首次监听端口可能触发 Windows 防火墙弹窗（绑 127.0.0.1 通常不会，但仍要预期）。
- 端口被占：优先固定端口 + 失败时把实际端口写进一个约定文件/自定义协议带参启动；或直接固定并要求用户关掉占用者。
- **CORS**：独立模式（公网站点）下必须给原生 `Access-Control-Allow-Origin` 白名单；托管模式同源，不需要。
- **来源校验**：即便同源也要校验 `Origin` / `Sec-Fetch-Site`，并加一次性 token，防止本地其他网页乱调。

### 4.5 【重要】通道要按**数据量**分级，不能只用一个

2026-09-22 补。原始设想是「浏览器拉起 exe 时把数据一起传过去」。这个思路方向对，但要拆成两段，
因为**自定义协议的 URL 塞不下我们的量**：

| 量级 | 载体 | 说明 |
| --- | --- | --- |
| **握手（几十字节）** | 自定义协议 `sc2overlay://show?token=…` | 只负责「把 exe 叫起来 / 唤醒已有实例」 |
| **脚本（几 KB ~ 几十 KB）** | **本地 HTTP `POST /overlay/load`** | 666 条建造顺序 ≈ 9~16 KB（含转义/编码膨胀）。**URL 是单向、一次性、且不可靠的载体** |
| 状态回推（持续） | 本地 WebSocket `/live` | 热键改了状态要让网页跟着变 |

**为什么 URL 不行**：

- Windows 的进程命令行上限是 **32,767 字符**（`CreateProcess` 的硬限制），这是**理论天花板**；
  实际还要经过注册表、浏览器、shell 多层处理，并且 URL 里塞 JSON 会被 `encodeURIComponent` 膨胀
  （中文一个字变 9 个字符）。**666 条项一次塞进去是在赌运气。**
- 更关键的是语义不对：URL 是**一次性、不可流式、失败不可知**的。而播报脚本会有「用户改了筛选 / 拖了时间轴 /
  换了播报对象」这些**增量更新**，URL 每改一次都要重新唤起一次 + 重新弹确认框。

**所以推荐的组合是**：

```
① 网页点「悬浮到桌面」
② 若已探测到组件 → 直接 POST /overlay/load（走已授权的本地 HTTP）
③ 若没探测到   → 用自定义协议唤起 exe（这一次会弹「是否允许打开」）
   └─ exe 启动后自己起本地服务
   └─ 网页轮询/重试探测，连上后回到 ②
④ 之后所有增量更新都走 ②/WS，不再碰协议
```

**零网络的备选通道**（当 LNA 被拒且用户不想授权时）：

| 方案 | 可行性 | 代价 |
| --- | --- | --- |
| **File System Access API**：网页写一个文件到用户选的目录，exe 用 `ReadDirectoryChangesW` 监听 | ✅ 真的可行，**零网络、零 LNA、零端口** | 首次要用户选一次目录（或文件）；句柄可存 IndexedDB 复用，但**每次会话仍需一次用户手势重新授权** |
| 剪贴板（网页 `navigator.clipboard.writeText`，exe 读剪贴板） | ✅ 可行 | 污染用户剪贴板；无回执；观感差 |
| 命名管道 / 共享内存 | ❌ **浏览器沙箱不暴露** | 纯网页无解 |

> 结论：**主通道 = 本地 HTTP（一次 LNA 授权换长期顺畅）；备通道 = 文件监听。**
> 如果组件自己托管页面（§4.4 的托管模式），连这一次授权都不需要 —— 这才是最顺的体验。

---

## 5. 先例拆解

### 5.1 ★ SC2_Coop_Overlay（SCO）—— 最贴近的先例

一个开源 SC2 合作模式 overlay，把「解析录像 → 屏幕浮层展示」跑通了，而且**架构几乎就是我们要的东西**。

`requirements.txt` 原文（15 条）：

```
altgraph==0.17          certifi==2020.6.20      chardet==3.0.4
future==0.18.2          idna==2.10              keyboard==0.13.5
mpyq==0.2.5             pefile==2019.4.18       psutil==5.7.3
PyQt5==5.15.1           PyQt5-sip==12.8.1       PyQtWebEngine==5.15.1
requests==2.25.0        s2protocol==5.0.4.82457.0   urllib3==1.26.2
websockets==8.1
```

对应关系（**这份清单本身就是一张架构图**）：

| 依赖 | 干什么 | 我们的对应物 |
| --- | --- | --- |
| `PyQt5` + `PyQtWebEngine` | 无边框窗口 + 内嵌 Chromium 渲染 HTML 浮层 | Wails/WebView2，或 Tauri |
| `websockets` | **本地 WS 服务**，Python ↔ HTML 浮层的通道 | §4.1 的 localhost WS |
| `keyboard` | **全局热键**（游戏有焦点也能收） | `RegisterHotKey` |
| `psutil` | **检测 SC2 进程**，决定浮层显示/隐藏 | `SetWinEventHook` + 进程名比对 |
| `mpyq` + `s2protocol` | 解析 MPQ 容器 + 官方协议 | **我们已经有了**（Rust/WASM 版） |

其它可借鉴点：

- README 明写 **「In StarCraft II set display mode to Windowed fullscreen (borderless)」** —— 与 §3.5 完全一致。
- **同一份 HTML 也能丢进 OBS 浏览器源**（`Layouts/` 目录，用户可改 `custom.css` / `custom.js`，升级不覆盖）→ **第二个发布渠道**。
- 自述合规理由：**「The app is not in conflict with Blizzard's Terms of Service. It uses official Blizzard's library (s2protocol) to parse replays, and what information StarCraft II provides while running.」** —— 与我们的定位一致（不读内存、不注入）。
- 反例警告：README 明说要给 `SCO.exe` 加杀软白名单（「Some anti-virus programs are very sensitive to packaged python apps」）→ 印证 §4.3 的签名/误报问题。

### 5.2 Overwolf / ow-electron（**不适用**）

- 注入型：overlay 作为一层画在游戏画面之上，**D3D11/D3D12 可走 GPU 共享纹理**（`useSharedTexture`），D3D9/OpenGL/Vulkan 走 CPU 拷贝。
- 支持游戏是**白名单 + 发行商集成**（LoL、Valorant、WoW、ARK…），**SC2 不在其中**。
- 成本：常驻后台 200–400MB 内存；且要求用户安装**两个**东西（平台 + App）。
- ⇒ 对我们**没有价值**：进不了 SC2，还要背一个平台依赖。

### 5.3 OBS Browser Source（第二条渠道）

- 静态 HTML/CSS/JS 直接作为浏览器源，主播侧零改造。
- 代表：Metal Max（SC2 流媒体覆盖层，纯静态前端工程）、SCO（可选）。
- 缺点：只进直播画面，**不解决「自己看着练」**。所以是补充，不是替代。

### 5.4 BongoCat / SnapShelf（置顶透明窗的现成范式）

- BongoCat：`tauri.conf.json` 里 `{"shadow":false,"alwaysOnTop":true,"transparent":true,"decorations":false,"skipTaskbar":true,"acceptFirstMouse":true}` —— **一份配置就是完整的浮窗规格**。
- SnapShelf：Windows 透明置顶「收纳架」，记录了 §3.3 里那两条 WebView2/亚克力的实战坑。

### 5.5 ★ 「媒体控制条」那种观感怎么做（2026-09-22 补）

目标观感：**深色圆角一条、左侧封面位、中间标题+副标题+进度、右侧传输控件**。
这是 Windows 上很成熟的一类浮窗，有两条完全不同的实现路径，**别混淆**：

| 路径 | 做法 | 能拿到什么 | 拿不到什么 |
| --- | --- | --- | --- |
| **① 自绘浮窗**（推荐） | 自己的无边框置顶窗（WebView2 载 HTML，或 Pygame/Qt 直接画），UI 自己排版 | **外观 100% 可控**，圆角/透明/动效/中文字体都随意 | 不会出现在系统媒体面板；媒体键要自己 `RegisterHotKey` |
| **② 注册 SMTC** | 调 WinRT `Windows.Media.SystemMediaTransportControls` 把自己注册成一个媒体会话 | 出现在 **Windows 媒体面板 / 音量面板**；**媒体键（播放暂停、上一曲、下一曲）直接可用**；锁屏可控 | **面板由系统绘制，样式不可改**。你只能提供封面/标题/副标题/播放状态/时间线/可用按钮 |

**现成先例**（证明这条路可行，且社区真的在做）：

- **`Better-Windows-Media-Controller`** —— 无边框、置顶、自带 AOT 开关与进度条的媒体控制器，
  Python + Pygame 自绘 UI，数据从 SMTC 读。**它展示的就是「自绘外观 + SMTC 数据」的组合。**
- **ModernFlyouts / FluentFlyout / MediaFlyout** —— 直接**替换**掉 Windows 原生媒体飞窗，
  提供 Mica/Acrylic 背景与更丰富的信息。它们的设置里普遍有一个 **「独占全屏时抑制显示」** 开关 ——
  反过来印证了 §3.5 那条限制是行业共识，标准缓解手段就是「检测全屏 → 自己躲开」。

**落到我们身上，最佳组合是 ①+②**：

- **① 决定长什么样** —— 我们已经在做（见 §8 的 `overlay-exe.html` 规格稿），
  而且它是 exe 里 WebView2 真正加载的那张页面，**视觉与站点共用一套 CSS 体系**。
- **② 顺带注册一个 SMTC 会话** —— 我们的语音播报**本质就是个播放器**（播放/暂停/上一步/下一步）。
  注册 SMTC 之后：
  - **媒体键直接可用**，不必去抢 `Alt+↑/↓`（也避免和 SC2 自己的热键冲突）；
  - 出现在系统媒体面板，用户能一眼看到「现在在读哪一局」；
  - 封面位可以放种族徽标 / 地图缩略图。

  ⚠️ 代价与摩擦（**未实测，置信度中**）：SMTC 是 WinRT API，从 **Go（Wails）** 调需要 `go-ole` /
  WinRT 绑定或 CGO，比 C#/C++ 麻烦；`Better-Windows-Media-Controller` 用的是 Python `winsdk`。
  **如果最终选 Wails，②这一项建议放到 M3 之后，别卡住主线。**

**一句话**：参考图里那种观感 = **自绘浮窗**（路径①），不是 SMTC；
SMTC 是**顺带白拿的系统集成**，不是外观方案。

> ⚠️ **但我们的悬浮窗不打算照搬媒体控制条那套视觉**（2026-09-22 定调）。
> 我们的目标是「**呈现建造轴上的操作 + 最小占位**」，见 §8.1。
> SMTC 对本项目的价值**只剩「媒体键白拿」这一条**，与长什么样无关。

---

## 6. 反作弊与合规（必须写清）

**Warden 的实际情况**（社区共识，非官方）：

- Warden 是 Blizzard 的反作弊客户端，随 Battle.net 客户端加载，会扫描文件/进程的哈希与内存特征。
- **`.dll` 注入 = 改变游戏进程内存映像 = 高危**；即便宣称「反侦测」，每次 Warden 更新都会有一波封号。
- 不注入的作弊（如读内存画个圆圈）也**会被 exe 签名扫描命中**。
- Blizzard 官方表态：「using hacks or modifications in any form」可导致**战网永久封禁**；「Playing StarCraft II legitimately means playing with an unaltered game client.」

**我们的定位（写进产品说明里）**：

1. **不注入、不读游戏内存、不修改任何游戏文件** —— 只是一个显示**我们自己数据**的置顶窗口。
2. **不需要 SC2 在运行**。事实上它的主用法是复盘：打开录像、放语音、对着看。SC2 是否在前台，只影响「浮层显示/隐藏」这一个策略（§3.4）。
3. 与 SCO 同一套合规理由：数据来自官方 `s2protocol`/我们自己的解析器 + 玩家自己的录像。

**但有一条我不想含糊**：

> 把「实时建造提示」类浮层用到**天梯实战**里，在社区视角下有争议（可能被认为提供了不公平信息优势），而且**技术上也走不通**（§3.5 独占全屏限制 + 实战不产生录像文件流）。
> **建议把产品定位明确写成「练习与复盘工具」**，并在浮层文档里直接说明「请在窗口化全屏下使用；对局录像请赛后分析」。这既是诚实的风险披露，也让产品边界更清楚。

---

## 7. 推荐架构

### 7.1 分层

```
┌──────────────────────────── 浏览器（分析站） ────────────────────────────┐
│  解析 / 28 张指标图 / 建造顺序 / 语音播报队列 / 悬浮控制                  │
│  ── 只有「播报脚本 + 设置」需要跨进程，几十 KB，一次性下发 ──               │
└───────────────┬──────────────────────────────────────────┬───────────────┘
                │ ① 托管模式：页面本身就从这个端口来（同源，最稳）
                │ ② 独立模式：公网站点 → localhost（LNA 授权 + CORS 白名单）
                ▼
┌──────────────────── 外置组件 sc2-overlay.exe（Windows） ──────────────────┐
│  HTTP/WS 服务 (127.0.0.1:PORT)   ← 唯一跨进程入口                          │
│  ┌───────────────────────────────────────────────────────────────────┐   │
│  │ 置顶透明窗：WS_EX_LAYERED|TRANSPARENT|NOACTIVATE|TOOLWINDOW        │   │
│  │            + SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE)            │   │
│  │ 渲染层：WebView2 承载 HTML（复用站点同一套 CSS）                     │   │
│  │ 全局热键：RegisterHotKey（Alt+↑/↓/←/→）                             │   │
│  │ 前台检测：SetWinEventHook(EVENT_SYSTEM_FOREGROUND) → SC2_x64.exe    │   │
│  │ 仅在该显示时显示；位置随游戏窗口；高 DPI 感知；托盘 + 单实例           │   │
│  └───────────────────────────────────────────────────────────────────┘   │
│  自带计时器：收到脚本后自己走时间轴（网页关了也不停）                       │
└──────────────────────────────────────────────────────────────────────────┘
```

**分工原则**：网页负责「算」，组件负责「显示 + 走时钟」。**播报脚本一次性下发后，组件独立运行** —— 网页被关掉、切到别的 tab、浏览器崩溃，浮层都照常。这一点比现在的实现好：现在 `voice_reader.js` 的计时器跑在 `pipWindow` 或主窗口里（`voiceTimerTargetWindow()`），窗口一关就停。

### 7.2 IPC 消息表（草案）

**HTTP**

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 探测。返回 `{name, version, pid, capabilities[]}`。**网页侧首调用它触发 LNA 授权** |
| `POST` | `/overlay/load` | 下发播报脚本（见下） |
| `POST` | `/overlay/control` | `{action: "play"\|"pause"\|"reset"\|"seek", t?: number}` |
| `POST` | `/overlay/style` | `{opacity, fontScale, x, y, showContext, excludeFromCapture}` |
| `DELETE` | `/overlay` | 卸载脚本、隐藏浮层 |

**WebSocket `/live`**（组件 → 网页，状态回推）

| 事件 | 载荷 |
| --- | --- |
| `ready` | 组件能力：能否点击穿透、是否检测到 SC2、当前 DPI |
| `state` | `{playing, t, idx, step}` —— 玩家用全局热键操作时，网页要跟着同步 |
| `game` | `{foreground: "sc2"\|"other"}` —— 让网页能提示「离开游戏，浮层已隐藏」 |
| `error` | 权限/绘制失败原因 |

**`/overlay/load` 载荷**

```json
{
  "player": "Percival",
  "race": "T",
  "duration": 1026.0,
  "rate": 2.0,
  "lang": "zh-CN",
  "speed": 1.0,
  "excludeFromCapture": true,
  "steps": [
    { "t": 1.0,  "text": "SCV" },
    { "t": 24.0, "text": "补给站" },
    { "t": 56.0, "text": "兵营" }
  ]
}
```

### 7.3 技术选型建议

| 选项 | 理由 | 代价 |
| --- | --- | --- |
| **Wails v2（Go）** ⭐ | 你已经在 Quill 用 Wails，**同一套工具链、同一套 Go 构建**；`Frameless` / `AlwaysOnTop` / `WebviewIsTransparent` 都有 | ① `AssetServer` 的**特性矩阵里 WebSocket 是 ❌**（Win/Mac/Linux 全不支持）→ WS 必须自己 `net.Listen` 另起；② 没有 ex-style 接口，`WS_EX_NOACTIVATE` 要自己 `syscall` 调 `SetWindowLongPtr`；③ `RegisterHotKey` / `SetWinEventHook` 要自己写（或找现成 Go 包） |
| **Tauri v2（Rust）** | 已有 SnapShelf / BongoCat 等成熟浮窗先例；窗口选项最全；Rust 你也不陌生（本项目 wasm 侧就是 Rust） | WebView2 那两条坑要提前规避 |
| **Qt (PyQt5 + QWebEngineView)** | SCO 已验证可行，`WindowTransparentForInput` 一个 flag 就搞定穿透 | 引入 Python 运行时 —— 本项目刚把 Python 清干净，**不建议** |

**倾向：Wails v2**（工具链复用）+ 单独的 `net/http` 服务，或者纯 Go + `webview/webview` 更轻。最终选型建议在你确认后再定。

### 7.4 exe **必须是可选的**：装与不装各拿到什么

这是 2026-09-22 明确的产品约束（「用户可以选择要不要下载一个 exe 扩展悬浮框」）。
设计上意味着：**网页端任何时刻都必须是完整可用的**，exe 只做加法，不做前提。

| 能力 | 纯网页（不装） | 装了 exe |
| --- | --- | --- |
| 解析录像 / 28 张图 / 建造顺序 / 采样表 / CSV 导出 | ✅ | ✅ |
| 语音播报（页面内播放） | ✅ | ✅ |
| 播报队列可视化 | ✅ 页面内 | ✅ 页面内 + 桌面浮层 |
| **置顶浮层** | ⚠️ 仅 Document PiP：**带浏览器标题栏与 origin**、无透明、无点击穿透、会抢焦点 | ✅ 无边框 + 逐像素透明 + 点击穿透 + 不抢焦点 |
| **游戏在前台时可见** | ❌ | ✅（需窗口化全屏） |
| **全局热键 / 媒体键** | ❌（只在本标签页有焦点时有效） | ✅ `RegisterHotKey`，或 SMTC 白拿媒体键 |
| 跟随游戏窗口 / 只在 SC2 前台时显示 | ❌ | ✅ |
| 浮层独立走时钟（关掉网页也不停） | ❌（PiP 关闭即停、页面刷新即断） | ✅ |
| 安装成本 | 0 | 一个 exe（**需代码签名**，否则杀软误报） |
| 浏览器侧权限 | 无 | 首次一次本地网络授权（托管模式则不需要） |

**引导文案建议**（避免「不装是不是就残废」的误解）：

> 悬浮窗需要一个可选的小组件（约 xx MB）。不装也能用全部分析功能与语音播报，
> 只是悬浮窗会以浏览器画中画的形式出现 —— 顶部会带浏览器的地址栏标题、不能透明。
> 装了之后是干净的无边框浮层，可以用全局热键控制。

---

## 8. 本项目已落地的部分（本次改动）

在 `prototype/data-lab.html` 里把「悬浮」做成了**通道 + 降级**的真实实现，而不是占位符：

| 实现 | 内容 |
| --- | --- |
| 真实探测 | `ovProbe()` 打 `GET http://127.0.0.1:18760/health`，带 `targetAddressSpace:'local'`（§4.2 的正确姿势），1.5s 超时 |
| 真实推送 | `ovPush()` → `POST /overlay`（§7.2 的载荷） |
| 真实降级 | 探测失败 → `openPip()` 打开 Document 画中画（即线上现有实现），并在状态区**如实写出当前走的是哪条路** |
| 状态可见 | 右下角红/黄/绿圆点 + 文案，用户永远知道现在是什么状态 |

**实测结果**（headless Chromium，组件故意不存在）：

```
⑨ 悬浮探测结果: {"dot":"ovdot bad","txt":"未检测到本地悬浮组件（18760 端口无响应）","hasDocPip":true}
⑩ 点按悬浮后:  {"dot":"ovdot wait","txt":"已降级为浏览器内 Document 画中画（非置顶透明窗口）","pipOpen":true}
```

即：**探测失败被正确识别、降级路径被真正走通**。剩下的只是把 `127.0.0.1:18760` 后面那个 exe 写出来。

补充三项：

- 降级用的 PiP 已加 **`disallowReturnToOpener: true`**（§1 里唯一可优化项），把「返回标签页」按钮藏掉。
- **新增 `prototype/overlay-exe.html` —— 悬浮窗的视觉规格稿**，也就是将来 exe 里 **WebView2 真正加载的那张页面**。

### 8.1 悬浮窗的设计目标（2026-09-22 重新定调）

项目方明确了两条，其余都是次要的：

| # | 目标 | 落实方式 |
| --- | --- | --- |
| ① | **呈现建造轴上的操作** | 轴条版式：游标在轴上的位置 + 刻度 = 每一步建造项 + 右侧固定槽位写「下一步 05:41 攻城坦克 +20s」 |
| ② | **占屏尽可能小** | 默认轴条 **36px** 高；贴满屏宽（1920×1080）占 **3.33%**；收窄到 620px 时只占 **1.08%** |

> 明确一点：**不要照搬「媒体控制条」那种观感**（那是另一类产品的视觉语言），
> 我们要的是「建造轴 + 最小占位」。§5.5 里 SMTC 的价值**只剩媒体键**，与外观无关。

### 8.2 四种版式（都往扁里做）

| 版式 | 高 / 宽 | 占屏（1920×1080，贴满屏宽） | 适合 |
| --- | --- | --- | --- |
| **`axis` 轴条**（默认） | 36px × 全宽 | **3.33%** | 贴屏幕顶部/底部；一眼看到「整局轴上的位置 + 还有多久到下一步」 |
| `ticker` 单行 | 30px × 全宽 | 2.78% | 最省；只看「当前 + 之后 3 项」 |
| `stack` 双行 | 54px × 全宽 | 5.00% | 要更大字号时 |
| `rail` 竖向贴边 | 168px 宽 × 208px | 1.68% | 贴左/右侧；纵向列下一步，占宽不占高 |

**轴上的颜色是信息不是装饰**：灰 = 建筑、蓝 = 单位、紫 = 科技；游标前为暗、游标后为亮；
下一项刻度加粗加光晕；左侧色条跟着当前项类别走（实测 `rgb(74,155,245)` = 单位蓝）。

### 8.3 工程要点

| 特性 | 实现 |
| --- | --- |
| 单文件、零依赖、零网络请求 | ✅ 与站点其余部分同一套做法 |
| **`?embed=1`** | 去掉预览外壳、`html/body` 背景透明 → **直接丢给 WebView2** |
| **`?v=axis\|ticker\|stack\|rail`** | 锁定版式，exe 里就写死这个 URL |
| 预览外壳隔离 | 用 `preview-only` 类，`embed` 时 `display:none` |
| 演示可跑 | 播放/暂停真的推进游标；`?embed=1` 下照常工作 |

⚠️ **`embed` 模式的两条硬不变式**（都是先写错、被验收抓出来的）：

1. **页面必须填满窗口**，不能自己定宽。早期版本在 `render()` 里写死了宽度，
   结果窗口比卡片窄时，`place-items:center` 把卡片居中推到 **x = −140**。
   现在 embed 下 `#overlay` 强制 `width:100%`。
2. **固定高版式的窗口高度必须等于卡片高度**（36/30/54），否则出现滚动条或裁切。
   验收脚本现在断言：贴 (0,0)、卡片宽 = 窗口宽、无横向滚动、无内容裁切、高度符合规格。

验收：`node prototype/shot-overlay.mjs` —— 真实 Chromium，**零错误**，13 张截图在 `prototype/shots-overlay/`。

这样分工就很干净：**exe 只管窗口（Win32 那套），这份 HTML 只管外观**，两边可以并行推进、互不阻塞。

---

## 9. 未确认项与风险（对照清单）

| # | 事项 | 状态 | 置信度 |
| --- | --- | --- | --- |
| 1 | Chrome 147 起 WebSocket 受 LNA 限制 | 仅二手来源，官方博客只说「计划支持 WebSocket/WebTransport/WebRTC」 | **中，建议实测** |
| 2 | 「Win11 22H2+ DWM Topmost Override 限制未签名进程穿透桌面层」 | 来自单篇 CSDN 回答，**未找到官方依据** | **低，不要写进设计** |
| 3 | SC2 在 Windows 上「窗口化全屏 + 第三方置顶窗」的实际表现 | 多来源一致指向可行，但**本机是 macOS，未实测** | 中高 |
| 4 | Document PiP 窗口在 Windows 上是否真置顶 / 是否带「返回标签页」按钮 | 本次未实测 | 未验证 |
| 5 | 独占全屏下窗口不可见 | 通用结论，多来源一致；未在 SC2 实测 | 高（通用）/ 未验证（SC2） |
| 6 | Wails v2 `AssetServer` 不支持 WebSocket | 官方文档特性矩阵明示 ❌ | 高 |
| 7 | `RegisterHotKey` 与 SC2 是否冲突（SC2 自己占用的键） | 未调研 | 未验证 |
| 8 | macOS 侧无对应机制（`WS_EX_*` 是 Windows 专有） | 是。macOS 可考虑 `NSWindowCollectionBehaviorCanJoinAllSpaces` + `ignoresMouseEvents`，但**本产品应 Windows 优先**，macOS 退 Document PiP | 高 |
| 9 | **http:// 的环回地址在地址栏仍显示「不安全」** | ✅ **已由项目方实测确认**：`http://127.0.0.1:60966` 在 Chrome 里显示「不安全」气泡 + 站点信息面板。→ 托管模式想彻底去掉它，得配**本地受信证书**（mkcert 一类需装根证书），成本不低 | 高（实拍） |
| 10 | 从 **Go / Wails** 调 SMTC 的摩擦有多大 | 只知道 Python（`winsdk`）有现成先例；Go 侧需 `go-ole`/WinRT 绑定或 CGO，未验证 | **低，未验证** |
| 11 | Firefox 151+（2026）已支持 Document PiP | 二手来源（rabbitpair FAQ），**未在 Firefox 实测**。但无关紧要：我们的降级路径本来就只在 Chromium 系上验证 | 中 |
| 12 | Document PiP 窗口在 Windows 上是否硬置顶（盖住普通窗口） | 规范只说「floats on top of other windows」；本机 macOS 上打开成功但未验证置顶行为 | 中 |

**明确不建议**：把「注入游戏进程」写进任何方案分支。SC2 的 Warden + Blizzard EULA 决定了这条路的风险收益比是负的。

---

## 10. 来源

1. **Microsoft 专利 US2006/0061597** —— `WS_EX_LAYERED + WS_EX_TRANSPARENT + WS_EX_NOACTIVATE` 三件套与 `SetWindowPos(HWND_TOPMOST)` 的官方口径
   <https://www.freepatentsonline.com/y2006/0061597.html>
2. **daniweb / gamedev 讨论**（含 Microsoft 指引转述）—— 独占全屏下第三方窗口不可用的边界、`UpdateLayeredWindow` 为逐像素 alpha 推荐 API、避免轮询强置顶
   <https://www.daniweb.com/programming/game-development/threads/41281/in-game-chat-window>
3. **火山引擎社区** —— 用 `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)` + `EVENT_OBJECT_LOCATIONCHANGE` 控制浮层显隐与位置同步（实作经验）
   <https://www.volcengine.com/article/275>
4. **SC2_Coop_overlay（SCO）** —— SC2 生态最贴近的先例；技术栈、窗口化全屏要求、OBS 浏览器源、ToS 自述
   <https://github.com/daydreamofscience/SC2_Coop_overlay>
5. **OBS 论坛** —— SC2 全屏模式下捕获黑屏，仅 windowed / fullscreen windowed 可用
   <https://obsproject.com/forum/threads/game-capture-issue-sc2.4193/>
6. **Chrome for Developers 官方博客：Local Network Access** —— 地址空间定义、Chrome 138/142 时间线、`targetAddressSpace` 与混合内容豁免
   <https://developer.chrome.com/blog/local-network-access>
7. **Localtonet 技术指南**（含 WebSocket 覆盖时点，二手）
   <https://www.localtonet.com/blog/chrome-local-network-access-apis-websockets>
8. **稀土掘金**（中文实作记录：`ensureLoopbackPermission()`、Chrome 142+/Edge 142+ 现状）
   <https://juejin.cn/post/7644085410189180938>
9. **textslashplain（Eric Lawrence）** —— 自定义协议提示框的历史、Chromium 84+ 恢复「始终允许」、Edge 96+ AutoLaunchProtocolsComponent
   <https://textslashplain.com/2020/02/20/bypassing-appprotocol-prompts/>
10. **Wails 官方文档 Options** —— `AlwaysOnTop` / `Frameless` / `windows.Options{WebviewIsTransparent, WindowIsTranslucent}`；AssetServer 特性矩阵（WebSockets ❌）
    <https://wails.io/docs/reference/options>
11. **Tauri 社区实作** —— SnapShelf（透明置顶 + WebView2 拖放/亚克力坑）、BongoCat（浮窗配置范式）
    <https://dev.to/devrayat000/building-a-transparent-drag-and-drop-shelf-for-windows-with-tauri-the-engineering-war-stories-3c8c>
12. **Overwolf 开发者文档** —— ow-electron overlay、共享纹理渲染、支持游戏白名单（无 SC2）
    <https://dev.overwolf.com/ow-electron/reference/examples/overlay/shared-texture-rendering>
13. **TeamLiquid** / **Game Developer** —— Warden 机制与 Blizzard 对作弊/修改客户端的封禁立场
    <https://tl.net/forum/starcraft-2/313447-hacking-in-starcraft-2>
    <https://www.gamedeveloper.com/game-platforms/blizzard-to-ban-i-starcraft-ii-i-cheats-in-the-near-future->

### 2026-09-22 补充来源

14. **WICG Document Picture-in-Picture 规范** —— §3.2.2 Origin Visibility（标题栏强制）、
    §3.2.1 Positioning（禁用 moveTo）、§3.2.3 Maximum size、§3.2.4 Fullscreen（禁用）；
    以及正文里「只有一个 PiP 窗口」「PiP 不会比 opener 活得久」
    <https://wicg.github.io/document-picture-in-picture/>
15. **Chrome for Developers：Document Picture-in-Picture** —— `disallowReturnToOpener` /
    `preferInitialWindowPlacement` 语义；浏览器支持 116+
    <https://developer.chrome.com/docs/web-platform/document-picture-in-picture>
16. **Document PiP 浏览器支持与限制汇总**（含 Safari 不支持、Firefox 151+、焦点抢占 issue #146）
    <https://www.rabbitpair.com/en/products/dualpip/faqs/document-pip-browser-limits>
17. **`Better-Windows-Media-Controller`** —— 无边框置顶媒体控制器，Python + Pygame **自绘 UI** + 读 SMTC；
    「自绘外观 + SMTC 数据」这条组合的现成先例
    <https://github.com/rgbeans/Better-WIndows-Media-Controller>
18. **ModernFlyouts / FluentFlyout / MediaFlyout** —— 替换 Windows 原生媒体飞窗；
    普遍提供「**独占全屏时抑制显示**」开关（印证 §3.5 是行业共识）
    <https://windowsforum.com/news/elevate-windows-11-media-control-with-fluentflyout-and-mediaflyout.393981/>
19. **系统媒体控件（SMTC / GSMTC）兼容性与接入说明**（`SystemMediaTransportControls` 位于
    `Windows.Media` 命名空间；各播放器支持矩阵）
    <https://blog.csdn.net/gitblog_00132/article/details/160178352>
