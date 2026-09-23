package main

import (
	"context"
	"encoding/json"
	"fmt"
	"image"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"
	"unicode/utf8"
	"unsafe"

	"github.com/energye/systray"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	ovPort    = 18760
	ovName    = "sc2-overlay"
	ovVersion = "0.1.0"
)

// PushPayload 与网页侧 ovPush() 的载荷逐字段对应（prototype/data-lab.template.html 悬浮通道段）。
type PushPayload struct {
	Player    string  `json:"player"`
	Race      string  `json:"race"`
	Who       int     `json:"who"`
	Duration  float64 `json:"duration"`
	File      string  `json:"file"`
	Rate      float64 `json:"rate"`
	Lang      string  `json:"lang"`
	Speed     float64 `json:"speed"`
	Layout    string  `json:"layout,omitempty"`    // bar|stack|rail，缺省保持当前版式
	Plate     string  `json:"plate,omitempty"`     // card|plain（纯文字覆盖），缺省保持当前底板
	Autostart string  `json:"autostart,omitempty"` // now（默认，立即走表）| foreground（SC2 进前台起表）
	Steps     []Step  `json:"steps"`
}

type Step struct {
	T    float64 `json:"t"`
	Text string  `json:"text"`
	Icon string  `json:"icon,omitempty"` // assets/units/ 图标名（不含扩展名），缺省不显示图标
}

type App struct {
	ctx          context.Context
	srv          *http.Server
	lastPush     *PushPayload
	screenPhysW  int  // 主屏物理宽，startup 时缓存（全宽版式用，避免读回漂移）
	userMoved    bool // 用户手动拖过位置 → 版式切换不再自动锚定
	lastX, lastY int  // 最近一次已知的窗口位置（程序设置或用户拖动后），用于识别手动拖动
	cfgX, cfgY   int  // 配置文件里保存的位置
	hasCfg       bool
	// M2 模式开关（/overlay/style 设置，配置持久化）
	clickThrough bool // 鼠标穿透（拖动需先关掉）
	followGame   bool // 跟随 SC2 窗口位置
	onlyWhenGame bool // 仅 SC2 在前台时显示，切走自动隐藏
	// 外观与起表方式 —— 2026-09-23 从网页左栏搬进托盘。
	// 网页推送时这三项可以留空，留空就用这里的值（所以旧网页不带字段也能正常工作）。
	layout    string // bar | stack | rail
	plate     string // card | plain
	autostart string // now | foreground（推送脚本时决定「立即走表」还是「等 SC2 进前台」）
	mLayout   *systray.MenuItem
	mPlate    *systray.MenuItem
	mStart    *systray.MenuItem
	// 子项按值索引，切换时逐个对勾选态（systray 没有 radiogroup）
	mLayoutItems map[string]*systray.MenuItem
	mPlateItems  map[string]*systray.MenuItem
	mStartItems  map[string]*systray.MenuItem
	// 跟随细节：相对游戏右缘/上缘的偏移（物理像素）。拖动优先 —— 手动拖动会重捕获偏移。
	followGapRight, followGapTop    int
	followGapSet, followGapApplied  bool
	lastGameL, lastGameT, lastGameR int
	lastFG                          bool // 上一tick SC2 是否前台（进/出前台的边沿广播用）
	// 读游戏时钟（clock.go）：最近一次定位到的时钟区域与其中的墨迹像素数，供调试端点回读。
	lastClockBand   image.Rectangle
	lastClockPixels int
	// 时钟区域（窗口比例）。0 值表示用 clock.go 里的默认值；可在 config.json 里覆盖 ——
	// 不同分辨率 / UI 缩放下这个区域会有偏移，留个后门免得改代码。
	clockX0, clockX1, clockY0, clockY1 float64
	// M3：SSE 状态回推 + 托盘
	sse       *sseHub
	trayReady bool
	mVis      *systray.MenuItem
	mToggle   *systray.MenuItem
	mCT       *systray.MenuItem
	mFollow   *systray.MenuItem
	mOnly     *systray.MenuItem
	mReset    *systray.MenuItem
	mReg      *systray.MenuItem
}

func NewApp() *App {
	return &App{
		sse:    newSseHub(),
		layout: "bar", plate: "card", autostart: "key", // 默认「等快捷键」—— 自动起表实测时机不可控
		mLayoutItems: map[string]*systray.MenuItem{},
		mPlateItems:  map[string]*systray.MenuItem{},
		mStartItems:  map[string]*systray.MenuItem{},
	}
}

// dispatch：播放控制统一入口（HTTP control / 全局热键 / 托盘共用），
// 执行后向 /live 订阅者广播回声 —— 分析页据此镜像悬浮窗的播放状态。
func (a *App) dispatch(action string, t float64) {
	if action == "show" {
		runtime.WindowShow(a.ctx)
		return
	}
	var js string
	switch action {
	case "play":
		js = "window.__overlay.play()"
	case "pause":
		js = "window.__overlay.pause()"
	case "toggle":
		js = "window.__overlay.toggle()"
	case "reset":
		js = "window.__overlay.reset()"
	case "seek":
		js = fmt.Sprintf("window.__overlay.seek(%v)", t)
	case "seekBy":
		js = fmt.Sprintf("window.__overlay.seekBy(%v)", t)
	default:
		return
	}
	a.exec(js)
	payload := map[string]any{"type": "control", "action": action}
	if t != 0 {
		payload["t"] = t
	}
	a.broadcast(payload)
	log.Printf("[overlay] control %s (%v)", action, t)
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.loadCfg()
	a.placeWindow()
	if h := findOverlayWindow(); h != 0 {
		applyNoActivate(h)
		applyToolWindow(h) // 不进任务栏、不进 Alt+Tab（调研 §3.1）
		setClickThrough(h, a.clickThrough)
	}
	// 启动早期窗口可能尚未就绪，延迟再断言一次尺寸（幂等）
	go func() {
		time.Sleep(800 * time.Millisecond)
		a.placeWindow()
	}()
	// 位置/模式看护：识别手动拖动并持久化 + 执行跟随/显隐模式。
	// 低频轮询（2s）只为记忆位置与模式同步；不做 topmost 强夺 —— 调研 §3.2 明确反对轮询强置顶。
	// 例外：`autostart=foreground` 武装待命期间改用高频轮询 —— 起表靠「SC2 进前台」的边沿，
	// 2s 周期会让起表最多晚 2 秒，悬浮窗与游戏时钟从此整体错位（起表时刻无法事后补回）。
	go func() {
		for {
			time.Sleep(2 * time.Second)
			a.tickModes()
		}
	}()
	// M3：全局热键 + 托盘
	go a.hotkeyLoop()
	a.runTray()

	addr := fmt.Sprintf("127.0.0.1:%d", ovPort)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Printf("[overlay] 监听 %s 失败（端口被占用？）: %v", addr, err)
		runtime.MessageDialog(a.ctx, runtime.MessageDialogOptions{
			Type: runtime.ErrorDialog, Title: ovName,
			Message: "本地端口 18760 被占用，悬浮组件无法启动服务。请关闭占用该端口的程序后重试。",
		})
		return
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", a.handleHealth)
	// 网页侧实际 POST 的是 /overlay；/overlay/load 是调研稿 §7.2 的草案路径，同语义兼收。
	mux.HandleFunc("/overlay", a.handleOverlay)
	mux.HandleFunc("/overlay/load", a.handleOverlay)
	mux.HandleFunc("/overlay/control", a.handleControl)
	mux.HandleFunc("/overlay/style", a.handleStyle)
	mux.HandleFunc("/live", a.handleLive)
	mux.HandleFunc("/debug/place", a.handleDebugPlace)
	mux.HandleFunc("/debug/rect", a.handleDebugRect)
	mux.HandleFunc("/debug/fg", a.handleDebugFG)
	// 读游戏时钟（clock.go）：/clock/read 读一次、/clock/learn 喂模板、/clock/debug 落调试图
	mux.HandleFunc("/clock/read", a.handleClockRead)
	mux.HandleFunc("/clock/learn", a.handleClockLearn)
	mux.HandleFunc("/clock/debug", a.handleClockDebug)
	// 不依赖 GUI 的退出通道（sc2-overlay.exe --quit 会转发到这里）
	mux.HandleFunc("/quit", a.handleQuit)

	a.srv = &http.Server{Handler: mux, ReadHeaderTimeout: 3 * time.Second}
	go func() {
		if err := a.srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("[overlay] http: %v", err)
		}
	}()
	log.Printf("[overlay] 服务已就绪 %s (pid %d)", addr, os.Getpid())
}

func (a *App) shutdown(ctx context.Context) {
	if a.srv != nil {
		_ = a.srv.Shutdown(context.Background())
	}
}

// handleQuit：退出进程。给「托盘点不开」留一条不依赖 GUI 的退路 ——
// 先把响应发出去，再延迟一点收摊，免得 curl 那边看到 connection reset。
func (a *App) handleQuit(w http.ResponseWriter, r *http.Request) {
	cors(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, map[string]any{"ok": true, "pid": os.Getpid()})
	log.Printf("[overlay] 收到 /quit，正在退出（pid %d）", os.Getpid())
	go func() {
		time.Sleep(200 * time.Millisecond)
		systray.Quit()
		runtime.Quit(a.ctx)
	}()
}

// placeWindow：默认 bar 版式 = 紧凑宽（620 逻辑像素）贴主屏右上角（规格 v2）。
// 实测：OnStartup 早期走 Wails WindowSetSize（逻辑像素）会被钳制到 ~135×36，
// 因此这里按物理像素直接 SetWindowPos，并由 startup 里延迟再断言一次。
func (a *App) placeWindow() {
	screens, err := runtime.ScreenGetAll(a.ctx)
	if err != nil {
		log.Printf("[overlay] 获取屏幕信息失败: %v", err)
		return
	}
	for _, s := range screens {
		log.Printf("[overlay] screen: primary=%v logical=%dx%d physical=%dx%d",
			s.IsPrimary, s.Size.Width, s.Size.Height, s.PhysicalSize.Width, s.PhysicalSize.Height)
		if !s.IsPrimary {
			continue
		}
		a.screenPhysW = s.PhysicalSize.Width
		scale := float64(s.PhysicalSize.Width) / float64(s.Size.Width)
		wPhys := int(620*scale + 0.5)
		hPhys := int(32*scale + 0.5) // bar 版式默认高
		// 默认贴主屏右上角；配置文件里有手动保存的位置则优先（multi-monitor 换屏时做边界校验）
		x := s.PhysicalSize.Width - wPhys
		y := 0
		if a.hasCfg &&
			a.cfgX > -wPhys && a.cfgX < s.PhysicalSize.Width-100 &&
			a.cfgY >= 0 && a.cfgY <= s.PhysicalSize.Height-100 {
			x, y = a.cfgX, a.cfgY
			a.userMoved = true
		}
		h := findOverlayWindow()
		log.Printf("[overlay] 设置前 %s", rectString(h))
		setWindowPosPhysical(h, x, y, wPhys, hPhys)
		a.lastX, a.lastY = x, y
		log.Printf("[overlay] 设置后 %s (期望 %dx%d)", rectString(h), wPhys, hPhys)
		return
	}
	log.Printf("[overlay] 未找到主显示器（共 %d 块）", len(screens))
}

// ---- HTTP ----

// 独立模式（公网分析页 → 环回组件）需要 CORS；托管/同源场景不受影响。
func cors(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	// Chrome/Edge 私有网络预检（PNA）：公网页面 → 环回的请求会带
	// Access-Control-Request-Private-Network 预检，需要显式应答 true
	w.Header().Set("Access-Control-Allow-Private-Network", "true")
}

func (a *App) handleHealth(w http.ResponseWriter, r *http.Request) {
	cors(w, r)
	log.Printf("[overlay] GET /health from %s", r.RemoteAddr)
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, map[string]any{
		"name":         ovName,
		"version":      ovVersion,
		"pid":          os.Getpid(),
		"capabilities": []string{"overlay", "control"},
	})
}

func (a *App) handleOverlay(w http.ResponseWriter, r *http.Request) {
	cors(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method == http.MethodDelete {
		a.handleUnload(w, r)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var p PushPayload
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		http.Error(w, "read body: "+err.Error(), http.StatusBadRequest)
		return
	}
	if !utf8.Valid(body) {
		http.Error(w, "body is not valid UTF-8（中文 Windows 的命令行管道可能把 UTF-8 转成了 GBK，请以 UTF-8 文件方式提交）", http.StatusBadRequest)
		return
	}
	if err := json.Unmarshal(body, &p); err != nil {
		http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if len(p.Steps) == 0 {
		http.Error(w, "empty steps", http.StatusBadRequest)
		return
	}
	if p.Speed <= 0 {
		p.Speed = 1
	}
	// 外观与起表方式现在归托盘管（2026-09-23 从网页左栏搬走）：网页可以完全不传这三项。
	if p.Layout == "" {
		p.Layout = a.layout
	}
	if p.Plate == "" {
		p.Plate = a.plate
	}
	if p.Autostart == "" {
		p.Autostart = a.autostart
	}
	a.lastPush = &p
	raw, err := json.Marshal(p)
	if err != nil {
		http.Error(w, "encode: "+err.Error(), http.StatusInternalServerError)
		return
	}
	a.exec("window.__overlay.load(" + string(raw) + ")")
	// 「仅游戏内显示」模式下，SC2 不在前台就不主动亮出（看护协程会在进游戏时显示）
	if !a.onlyWhenGame || foregroundIsSC2() {
		runtime.WindowShow(a.ctx)
	}
	log.Printf("[overlay] 收到播报脚本：%s（%s）%d 步", p.Player, p.Race, len(p.Steps))
	a.broadcast(map[string]any{
		"type": "script", "player": p.Player, "race": p.Race,
		"steps": len(p.Steps), "duration": p.Duration, "layout": p.Layout, "plate": p.Plate,
	})
	writeJSON(w, map[string]any{"ok": true, "steps": len(p.Steps)})
}

type ctlReq struct {
	Action string  `json:"action"`
	T      float64 `json:"t"`
}

func (a *App) handleControl(w http.ResponseWriter, r *http.Request) {
	cors(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var c ctlReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&c); err != nil {
		http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if c.Action == "resetpos" {
		// 恢复默认锚定（清除手动拖动位置与配置文件；跟随偏移也重新捕获）
		a.resetPosition()
		writeJSON(w, map[string]any{"ok": true, "rect": rectString(findOverlayWindow())})
		return
	}
	switch c.Action {
	case "play", "pause", "toggle", "reset", "show":
		a.dispatch(c.Action, 0)
	case "seek":
		a.dispatch("seek", c.T)
	case "seekBy":
		a.dispatch("seekBy", c.T)
	default:
		http.Error(w, "unknown action", http.StatusBadRequest)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// DELETE /overlay：卸载脚本并隐藏浮层（调研稿 §7.2）。
func (a *App) handleUnload(w http.ResponseWriter, r *http.Request) {
	cors(w, r)
	if r.Method != http.MethodDelete {
		http.Error(w, "DELETE only", http.StatusMethodNotAllowed)
		return
	}
	a.lastPush = nil
	a.exec("window.__overlay.reset()")
	runtime.WindowHide(a.ctx)
	writeJSON(w, map[string]any{"ok": true})
}

// ---- Go → 悬浮页 ----

// 版式 → 窗口尺寸（逻辑像素）。宽 0 = 全宽。规格 v2：bar 条形紧凑宽（620）
// 贴游戏右上角；stack 双行全宽×54；rail 竖向贴边 168×208 贴右。
var layoutSizes = map[string][2]int{
	"bar": {620, 32}, "stack": {0, 54}, "rail": {168, 208},
}

// NotifyLayout：悬浮页切换版式后上报，exe 按规格调整窗口尺寸（硬不变式 2：
// 固定高版式的窗口高度必须等于卡片高度）。w/h 为页面自报 CSS 视口，用于和
// Win32 矩形对账 —— 排查「WebView2 内容不跟随外部 SetWindowPos」。
//
// 原先还有个 NotifyAutostart：「SC2 进前台即自动起表」。实测起表时机太不可控
// （回放还在加载就开始跑），2026-09-23 弃用，改由用户按 Alt+↑ 手动起表。

func (a *App) NotifyLayout(v string, cssW, cssH int) {
	dim, ok := layoutSizes[v]
	if !ok || a.ctx == nil {
		return
	}
	hwnd := findOverlayWindow()
	if hwnd == 0 {
		return
	}
	scale := float64(getDpiForWindow(hwnd)) / 96.0
	l, t, _, _ := getWindowRect(hwnd)
	// 注意单位：版式尺寸是逻辑像素，乘 scale 得物理像素；全宽版式用主屏物理宽。
	// 宽度永远跟版式走；锚定位置才区分「默认右上角」和「用户拖过的当前位置」。
	wPhys := a.screenPhysW
	if wPhys == 0 {
		_, _, r, _ := getWindowRect(hwnd)
		wPhys = r
	}
	if dim[0] != 0 {
		wPhys = int(float64(dim[0])*scale + 0.5)
	}
	hPhys := int(float64(dim[1])*scale + 0.5)
	// 锚定优先级：followGame 开启时位置归跟随逻辑管；用户拖过则保持当前位置；
	// 都没有才用默认锚定（bar/rail 贴右上角、stack 全宽贴顶）。
	// 全宽版式横向恒铺满屏幕（不吃拖动偏移，否则右侧被裁出屏）；纵向尊重拖动位置。
	x := 0
	if dim[0] != 0 {
		wPhys = int(float64(dim[0])*scale + 0.5)
		if a.userMoved || a.followGame {
			x = l
		} else {
			x = a.screenPhysW - wPhys
		}
	}
	y := t
	if !a.userMoved && !a.followGame {
		y = 0
	}
	setWindowPosPhysical(hwnd, x, y, wPhys, hPhys)
	a.lastX, a.lastY = x, y
	log.Printf("[overlay] NotifyLayout(%s) css=%dx%d → %s", v, cssW, cssH, rectString(hwnd))
}

func (a *App) handleDebugPlace(w http.ResponseWriter, r *http.Request) {
	cors(w, r)
	a.placeWindow()
	writeJSON(w, map[string]any{"ok": true, "rect": rectString(findOverlayWindow())})
}

func (a *App) handleDebugFG(w http.ResponseWriter, r *http.Request) {
	cors(w, r)
	h := findGameWindow()
	var g string
	if h != 0 {
		g = rectString(h)
	}
	fh, _, _ := procGetForegroundWindow.Call()
	var pid uint32
	procGetWindowThreadProcessId.Call(fh, uintptr(unsafe.Pointer(&pid)))
	writeJSON(w, map[string]any{
		"fgSC2":      foregroundIsSC2(),
		"fgPID":      pid,
		"fgImage":    processImageName(pid),
		"lastFG":     a.lastFG,
		"gameWindow": g,
	})
}

func (a *App) handleDebugRect(w http.ResponseWriter, r *http.Request) {
	cors(w, r)
	writeJSON(w, map[string]any{
		"rect":      rectString(findOverlayWindow()),
		"userMoved": a.userMoved,
		"visible":   isWindowVisible(findOverlayWindow()),
	})
}

// ---- M2：跟随游戏窗口 + 仅游戏内显示（调研 §3.4）----

// tickModes：看护协程每 2s 执行一次；模式开关变化后也会立即调用一次。
func (a *App) tickModes() {
	h := findOverlayWindow()
	if h == 0 {
		return
	}
	l, t, r, b := getWindowRect(h)
	followOwned := false

	// 1) 跟随 SC2 窗口。拖动优先：手动拖动会以新位置重新捕获相对偏移
	//    （相对游戏右缘/上缘），之后只有游戏窗口变化才吸附，不再抢用户摆放。
	if a.followGame {
		if g := findGameWindow(); g != 0 {
			followOwned = true
			gl, gt, gr, _ := getWindowRect(g)
			gameMoved := gl != a.lastGameL || gt != a.lastGameT || gr != a.lastGameR
			overlayMoved := l != a.lastX || t != a.lastY
			if !a.followGapSet {
				// 首次启用：默认吸附游戏右上角，留 8 物理像素边距
				a.followGapRight, a.followGapTop = (r-l)+8, 8
				a.followGapSet, a.followGapApplied = true, false
			} else if overlayMoved && !gameMoved {
				a.followGapRight, a.followGapTop = gr-l, t-gt
				log.Printf("[overlay] 手动拖动 → 跟随偏移更新：右缘 %d / 顶缘 %d", a.followGapRight, a.followGapTop)
			}
			if gameMoved || overlayMoved || !a.followGapApplied {
				x, y := gr-a.followGapRight, gt+a.followGapTop
				if x < 0 {
					x = 0
				}
				if y < 0 {
					y = 0
				}
				if l != x || t != y {
					setWindowPosPhysical(h, x, y, r-l, b-t)
				}
				l, t = x, y
				a.followGapApplied = true
				a.lastGameL, a.lastGameT, a.lastGameR = gl, gt, gr
			}
			a.lastX, a.lastY = l, t
			if overlayMoved || gameMoved {
				a.persistCfg(l, t)
			}
		}
	}

	// 2) 手动拖动识别 → 持久化位置（follow 拥有位置权时跳过，避免双重记账）
	if !followOwned && (l != a.lastX || t != a.lastY) {
		a.lastX, a.lastY = l, t
		if !a.userMoved {
			a.userMoved = true
			log.Printf("[overlay] 检测到手动移动 → (%d,%d)，后续版式切换保持该位置", l, t)
		}
		a.persistCfg(l, t)
	}

	// 2.5) 只记录 SC2 的前台边沿。原先这里还负责「进前台 → 自动起表」，
	// 但实测时机不可控（回放还在加载就跑起来了），已改为用户按 Alt+↑ 手动起表。
	a.lastFG = foregroundIsSC2()

	// 3) 仅游戏内显示：SC2 不在前台就整条隐藏（调研 §3.4）
	if a.onlyWhenGame {
		fg := foregroundIsSC2()
		vis := isWindowVisible(h)
		if fg && !vis {
			runtime.WindowShow(a.ctx)
			a.broadcast(map[string]any{"type": "game", "foreground": true})
			log.Printf("[overlay] SC2 进前台 → 显示")
		} else if !fg && vis {
			runtime.WindowHide(a.ctx)
			a.broadcast(map[string]any{"type": "game", "foreground": false})
			log.Printf("[overlay] SC2 离开前台 → 隐藏")
		}
	}
}

func (a *App) currentLayout() string {
	if a.lastPush != nil && a.lastPush.Layout != "" {
		return a.lastPush.Layout
	}
	return "bar"
}

// ---- M2：/overlay/style —— 模式开关（调研稿 §7.2 草案端点的可执行子集）----

type styleReq struct {
	Opacity      *float64 `json:"opacity"`
	Speed        *float64 `json:"speed"`
	ClickThrough *bool    `json:"clickThrough"`
	FollowGame   *bool    `json:"followGame"`
	OnlyWhenGame *bool    `json:"onlyWhenGame"`
}

func (a *App) handleStyle(w http.ResponseWriter, r *http.Request) {
	cors(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method == http.MethodGet {
		a.writeState(w)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var s styleReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&s); err != nil {
		http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if s.Opacity != nil {
		a.exec(fmt.Sprintf("window.__overlay.setOpacity(%v)", *s.Opacity))
	}
	if s.Speed != nil {
		a.exec(fmt.Sprintf("window.__overlay.setSpeed(%v)", *s.Speed))
	}
	if s.ClickThrough != nil {
		a.setClickThroughMode(*s.ClickThrough)
	}
	if s.FollowGame != nil {
		a.setFollowMode(*s.FollowGame)
	}
	if s.OnlyWhenGame != nil {
		a.setOnlyMode(*s.OnlyWhenGame)
	}
	l, t, _, _ := getWindowRect(findOverlayWindow())
	a.persistCfg(l, t)
	a.writeState(w)
}

func (a *App) writeState(w http.ResponseWriter) {
	h := findOverlayWindow()
	var rect string
	if h != 0 {
		rect = rectString(h)
	}
	writeJSON(w, map[string]any{
		"clickThrough": a.clickThrough,
		"followGame":   a.followGame,
		"onlyWhenGame": a.onlyWhenGame,
		"userMoved":    a.userMoved,
		"gameFound":    findGameWindow() != 0,
		"rect":         rect,
	})
}

// ---- 位置持久化：%APPDATA%/sc2-overlay/config.json（调研 §3.9 配置持久化） ----

type posCfg struct {
	X              int  `json:"x"`
	Y              int  `json:"y"`
	FollowGapRight int  `json:"followGapRight,omitempty"`
	FollowGapTop   int  `json:"followGapTop,omitempty"`
	ClickThrough   bool `json:"clickThrough,omitempty"`
	FollowGame     bool `json:"followGame,omitempty"`
	OnlyWhenGame   bool `json:"onlyWhenGame,omitempty"`
	// 外观与起表方式（托盘设置）
	Layout    string `json:"layout,omitempty"`
	Plate     string `json:"plate,omitempty"`
	Autostart string `json:"autostart,omitempty"`
}

func (a *App) cfgPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "sc2-overlay", "config.json")
}

func (a *App) loadCfg() {
	a.hasCfg = false
	p := a.cfgPath()
	if p == "" {
		return
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return
	}
	var c posCfg
	if json.Unmarshal(b, &c) != nil {
		return
	}
	a.cfgX, a.cfgY, a.hasCfg = c.X, c.Y, true
	a.clickThrough, a.followGame, a.onlyWhenGame = c.ClickThrough, c.FollowGame, c.OnlyWhenGame
	if c.Layout != "" {
		a.layout = c.Layout
	}
	if c.Plate != "" {
		a.plate = c.Plate
	}
	if c.Autostart != "" {
		a.autostart = c.Autostart
	}
	a.followGapRight, a.followGapTop, a.followGapSet = c.FollowGapRight, c.FollowGapTop, c.FollowGapRight > 0
	log.Printf("[overlay] 已读取配置：位置 (%d,%d) clickThrough=%v followGame=%v onlyWhenGame=%v",
		c.X, c.Y, c.ClickThrough, c.FollowGame, c.OnlyWhenGame)
}

func (a *App) persistCfg(x, y int) {
	p := a.cfgPath()
	if p == "" {
		return
	}
	_ = os.MkdirAll(filepath.Dir(p), 0o755)
	b, _ := json.Marshal(posCfg{
		X: x, Y: y,
		FollowGapRight: a.followGapRight, FollowGapTop: a.followGapTop,
		ClickThrough: a.clickThrough,
		FollowGame:   a.followGame,
		OnlyWhenGame: a.onlyWhenGame,
		Layout:       a.layout,
		Plate:        a.plate,
		Autostart:    a.autostart,
	})
	_ = os.WriteFile(p, b, 0o644)
}

func (a *App) deleteCfg() {
	if p := a.cfgPath(); p != "" {
		_ = os.Remove(p)
	}
	a.hasCfg = false
}

func (a *App) exec(js string) {
	if a.ctx == nil {
		log.Printf("[overlay] 窗口未就绪，丢弃: %.60s", js)
		return
	}
	runtime.WindowExecJS(a.ctx, js)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
