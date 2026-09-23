package main

import (
	_ "embed"
	"fmt"
	"log"
	"os"
	"os/exec"

	"github.com/energye/systray"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed app.ico
var trayICO []byte

// runTray：托盘在自己的锁定线程上建窗口循环，与 Wails 主循环互不干扰（Windows）。
func (a *App) runTray() {
	go systray.Run(a.onTrayReady, func() {})
}

func (a *App) onTrayReady() {
	systray.SetIcon(trayICO)
	systray.SetTooltip("sc2-overlay · SC2 建造顺序悬浮窗")

	a.mVis = systray.AddMenuItem("显示 / 隐藏", "切换悬浮窗可见性")
	a.mToggle = systray.AddMenuItem("播放 / 暂停", "全局热键 Alt+↑")
	systray.AddSeparator()
	a.mCT = systray.AddMenuItemCheckbox("鼠标穿透（拖动需关闭）", "", a.clickThrough)
	a.mFollow = systray.AddMenuItemCheckbox("跟随游戏窗口", "", a.followGame)
	a.mOnly = systray.AddMenuItemCheckbox("仅游戏内显示", "", a.onlyWhenGame)
	systray.AddSeparator()
	// 外观与起表方式 —— 2026-09-23 从网页左栏搬进托盘（网页不再提供这三个下拉）。
	// 理由：它们是**悬浮窗自己的显示属性**，设一次就该一直生效；网页那三个下拉每次推送都要重选。
	// systray 没有 radiogroup，只能逐个切勾选态，所以按下标把子项存起来。
	a.mLayout = systray.AddMenuItem("版式", "悬浮窗形态：条形 / 双行 / 侧边")
	for _, o := range []struct{ v, label string }{
		{"bar", "条形"}, {"stack", "双行"}, {"rail", "侧边"},
	} {
		it := a.mLayout.AddSubMenuItemCheckbox(o.label, "", a.layout == o.v)
		v := o.v
		it.Click(func() { a.setLayoutMode(v) })
		a.mLayoutItems[v] = it
	}
	a.mPlate = systray.AddMenuItem("底板", "实底卡片 / 纯文字覆盖")
	for _, o := range []struct{ v, label string }{
		{"card", "实底卡片"}, {"plain", "纯文字覆盖"},
	} {
		it := a.mPlate.AddSubMenuItemCheckbox(o.label, "", a.plate == o.v)
		v := o.v
		it.Click(func() { a.setPlateMode(v) })
		a.mPlateItems[v] = it
	}
	a.mStart = systray.AddMenuItem("开始方式", "推送脚本后如何起表（下次推送生效）")
	for _, o := range []struct{ v, label string }{
		{"now", "立即开始"}, {"foreground", "进游戏自动起表"},
	} {
		it := a.mStart.AddSubMenuItemCheckbox(o.label, "", a.autostart == o.v)
		v := o.v
		it.Click(func() { a.setAutostartMode(v) })
		a.mStartItems[v] = it
	}
	systray.AddSeparator()
	a.mReset = systray.AddMenuItem("重置位置", "回到默认右上角锚定")
	a.mReg = systray.AddMenuItem("注册 sc2overlay:// 协议", "支持从浏览器一键唤起")
	systray.AddSeparator()
	mQuit := systray.AddMenuItem("退出", "")

	a.mVis.Click(func() { a.toggleVisible() })
	a.mToggle.Click(func() { a.dispatch("toggle", 0) })
	a.mCT.Click(func() { a.setClickThroughMode(!a.clickThrough) })
	a.mFollow.Click(func() { a.setFollowMode(!a.followGame) })
	a.mOnly.Click(func() { a.setOnlyMode(!a.onlyWhenGame) })
	a.mReset.Click(func() { a.resetPosition() })
	a.mReg.Click(func() { a.registerProtocol() })
	mQuit.Click(func() {
		log.Printf("[overlay] 托盘退出")
		a.shutdown(a.ctx)
		systray.Quit()
		runtime.Quit(a.ctx)
	})

	a.trayReady = true
	a.syncTrayChecks()
	log.Printf("[overlay] 托盘就绪")
}

// syncTrayChecks：模式开关变化后同步托盘勾选态（HTTP/热键/托盘三个入口共用）。
func (a *App) syncTrayChecks() {
	if !a.trayReady {
		return
	}
	if a.clickThrough {
		a.mCT.Check()
	} else {
		a.mCT.Uncheck()
	}
	if a.followGame {
		a.mFollow.Check()
	} else {
		a.mFollow.Uncheck()
	}
	if a.onlyWhenGame {
		a.mOnly.Check()
	} else {
		a.mOnly.Uncheck()
	}
	for v, it := range a.mLayoutItems {
		if v == a.layout {
			it.Check()
		} else {
			it.Uncheck()
		}
	}
	for v, it := range a.mPlateItems {
		if v == a.plate {
			it.Check()
		} else {
			it.Uncheck()
		}
	}
	for v, it := range a.mStartItems {
		if v == a.autostart {
			it.Check()
		} else {
			it.Uncheck()
		}
	}
}

// ---- 外观与起表方式（托盘设置，2026-09-23 从网页左栏搬来） ----

func (a *App) setLayoutMode(v string) {
	if _, ok := layoutSizes[v]; !ok {
		return
	}
	a.layout = v
	a.exec(fmt.Sprintf("window.__overlay.setLayout(%q)", v)) // 页面会回 notifyLayout → 窗口尺寸随之调整
	a.syncTrayChecks()
	a.persistCfg(a.lastX, a.lastY)
	log.Printf("[overlay] layout = %s", v)
}

func (a *App) setPlateMode(v string) {
	if v != "card" && v != "plain" {
		return
	}
	a.plate = v
	a.exec(fmt.Sprintf("window.__overlay.setPlate(%q)", v))
	a.syncTrayChecks()
	a.persistCfg(a.lastX, a.lastY)
	log.Printf("[overlay] plate = %s", v)
}

// setAutostartMode：只影响**下一次**推送 —— 脚本到手时才决定「立即走表」还是「等 SC2 进前台」。
func (a *App) setAutostartMode(v string) {
	if v != "now" && v != "foreground" {
		return
	}
	a.autostart = v
	a.syncTrayChecks()
	a.persistCfg(a.lastX, a.lastY)
	log.Printf("[overlay] autostart = %s（下次推送生效）", v)
}

func (a *App) toggleVisible() {
	h := findOverlayWindow()
	if h == 0 {
		return
	}
	if isWindowVisible(h) {
		runtime.WindowHide(a.ctx)
	} else {
		runtime.WindowShow(a.ctx)
	}
}

func (a *App) setClickThroughMode(on bool) {
	a.clickThrough = on
	if h := findOverlayWindow(); h != 0 {
		setClickThrough(h, on)
	}
	a.syncTrayChecks()
	a.broadcast(map[string]any{"type": "mode", "clickThrough": on})
	a.persistCfg(a.lastX, a.lastY)
	log.Printf("[overlay] clickThrough = %v", on)
}

func (a *App) setFollowMode(on bool) {
	a.followGame = on
	a.syncTrayChecks()
	a.broadcast(map[string]any{"type": "mode", "followGame": on})
	a.tickModes()
	a.persistCfg(a.lastX, a.lastY)
	log.Printf("[overlay] followGame = %v", on)
}

func (a *App) setOnlyMode(on bool) {
	a.onlyWhenGame = on
	if !on {
		runtime.WindowShow(a.ctx) // 关掉「仅游戏内」时确保可见
	}
	a.syncTrayChecks()
	a.broadcast(map[string]any{"type": "mode", "onlyWhenGame": on})
	a.tickModes()
	a.persistCfg(a.lastX, a.lastY)
	log.Printf("[overlay] onlyWhenGame = %v", on)
}

func (a *App) resetPosition() {
	a.userMoved = false
	a.followGapSet = false
	a.deleteCfg()
	a.placeWindow()
	a.tickModes()
}

// registerProtocol：把 sc2overlay:// 写进 HKCU（无需管理员），浏览器可一键唤起。
// 协议链接由新进程转发给已有实例（见 main.go），调研稿 §4.3。
func (a *App) registerProtocol() {
	exe, err := os.Executable()
	if err != nil {
		log.Printf("[overlay] 注册协议失败：无法定位 exe: %v", err)
		return
	}
	key := `HKCU\Software\Classes\sc2overlay`
	cmds := [][]string{
		{"add", key, "/ve", "/d", "URL:sc2overlay Protocol", "/f"},
		{"add", key, "/v", "URL Protocol", "/f"},
		{"add", key + `\shell\open\command`, "/ve", "/d", `"` + exe + `" "%1"`, "/f"},
	}
	for _, args := range cmds {
		if out, err := exec.Command("reg", args...).CombinedOutput(); err != nil {
			log.Printf("[overlay] 注册协议失败: %s", out)
			runtime.MessageDialog(a.ctx, runtime.MessageDialogOptions{
				Type: runtime.ErrorDialog, Title: "sc2-overlay",
				Message: "注册 sc2overlay:// 协议失败：" + string(out),
			})
			return
		}
	}
	runtime.MessageDialog(a.ctx, runtime.MessageDialogOptions{
		Type: runtime.InfoDialog, Title: "sc2-overlay",
		Message: "sc2overlay:// 协议已注册。浏览器访问含 sc2overlay://show 的链接即可唤起悬浮窗。",
	})
}
