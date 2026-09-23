package main

import (
	"fmt"
	"strings"
	"syscall"
	"unsafe"
)

// Win32 直查：Wails 的 WindowGetSize 在启动早期可能返回与 OS 不一致的内部值，
// 调试与后续 M2（ex-style / 前台检测）都需要拿到真实 HWND 与矩形。

var (
	user32                       = syscall.NewLazyDLL("user32.dll")
	procFindWindowW              = user32.NewProc("FindWindowW")
	procGetWindowRect            = user32.NewProc("GetWindowRect")
	procSetWindowPos             = user32.NewProc("SetWindowPos")
	procGetWindowLongPtrW        = user32.NewProc("GetWindowLongPtrW")
	procSetWindowLongPtrW        = user32.NewProc("SetWindowLongPtrW")
	procSetWindowDisplayAffinity = user32.NewProc("SetWindowDisplayAffinity")
	procGetDpiForWindow          = user32.NewProc("GetDpiForWindow")
)

type rect struct {
	Left, Top, Right, Bottom int32
}

func toUTF16(s string) uintptr {
	p, _ := syscall.UTF16PtrFromString(s)
	return uintptr(unsafe.Pointer(p))
}

// FindOverlayWindow：按标题定位 Wails 主窗口（frameless 下标题仍注册在 Win32）。
func findOverlayWindow() uintptr {
	h, _, _ := procFindWindowW.Call(0, toUTF16("sc2-overlay"))
	return h
}

func getWindowRect(h uintptr) (int, int, int, int) {
	var r rect
	procGetWindowRect.Call(h, uintptr(unsafe.Pointer(&r)))
	return int(r.Left), int(r.Top), int(r.Right), int(r.Bottom)
}

func rectString(h uintptr) string {
	if h == 0 {
		return "hwnd=0"
	}
	l, t, r, b := getWindowRect(h)
	return fmt.Sprintf("hwnd=0x%x rect=(%d,%d)-(%d,%d) %dx%d", h, l, t, r, b, r-l, b-t)
}

// setWindowPosPhysical：以物理像素直接设置窗口位置与尺寸（SWP_NOACTIVATE 恒带）。
func setWindowPosPhysical(h uintptr, x, y, w, h2 int) {
	const SWP_NOZORDER = 0x0004
	const SWP_NOACTIVATE = 0x0010
	procSetWindowPos.Call(h, 0, uintptr(x), uintptr(y), uintptr(w), uintptr(h2),
		SWP_NOZORDER|SWP_NOACTIVATE)
}

func getDpiForWindow(h uintptr) int {
	v, _, _ := procGetDpiForWindow.Call(h)
	if v == 0 {
		return 96
	}
	return int(v)
}

// createMutex：命名互斥锁（单实例检测）。exists=true 表示已有同名锁（ERROR_ALREADY_EXISTS=183）。
var procCreateMutexW = kernel32.NewProc("CreateMutexW")

func createMutex(name string) (uintptr, bool) {
	r, _, err := procCreateMutexW.Call(0, 0, toUTF16(name))
	if r == 0 {
		return 0, false
	}
	return r, err == syscall.Errno(183)
}

// GWL_EXSTYLE = -20（以 uintptr 二补数表示）
const gwlpExStyle = ^uintptr(19)

const wsExNoActivate = 0x08000000

// applyNoActivate：加 WS_EX_NOACTIVATE —— 点击/拖动悬浮窗都不抢前台焦点。
// 调研 §3.1：三件套里最容易被漏掉、后果最严重的一条（点一下悬浮窗 → 游戏丢输入）。
func applyNoActivate(h uintptr) {
	setExStyleBits(h, wsExNoActivate, 0)
}

// M2 三件套余下部分：TOOLWINDOW（不进任务栏/Alt+Tab）+ 点击穿透。
// 注意 WS_EX_TRANSPARENT 必须与 WS_EX_LAYERED 同用才生效（调研 §3.1）。
const (
	wsExTransparent = 0x00000020
	wsExToolWindow  = 0x00000080
	wsExLayered     = 0x00080000
)

func setExStyleBits(h, add, clear uintptr) {
	st, _, _ := procGetWindowLongPtrW.Call(h, gwlpExStyle)
	st = (st | add) &^ clear
	procSetWindowLongPtrW.Call(h, gwlpExStyle, st)
}

func applyToolWindow(h uintptr) {
	setExStyleBits(h, wsExToolWindow, 0)
}

func setClickThrough(h uintptr, on bool) {
	if on {
		setExStyleBits(h, wsExLayered|wsExTransparent, 0)
	} else {
		setExStyleBits(h, 0, wsExTransparent)
	}
}

// ---- SC2 进程 / 窗口识别 ----

var (
	kernel32                       = syscall.NewLazyDLL("kernel32.dll")
	procOpenProcess                = kernel32.NewProc("OpenProcess")
	procQueryFullProcessImageNameW = kernel32.NewProc("QueryFullProcessImageNameW")
	procCloseHandle                = kernel32.NewProc("CloseHandle")
	procGetForegroundWindow        = user32.NewProc("GetForegroundWindow")
	procGetWindowThreadProcessId   = user32.NewProc("GetWindowThreadProcessId")
	procEnumWindows                = user32.NewProc("EnumWindows")
	procIsWindowVisible            = user32.NewProc("IsWindowVisible")

	processQueryLimitedInformation = uintptr(0x1000)
)

var sc2ProcessNames = map[string]bool{
	"sc2_x64.exe": true, // 现代客户端
	"sc2.exe":     true, // 32 位旧客户端
}

func isWindowVisible(h uintptr) bool {
	v, _, _ := procIsWindowVisible.Call(h)
	return v != 0
}

func processImageName(pid uint32) string {
	h, _, _ := procOpenProcess.Call(processQueryLimitedInformation, 0, uintptr(pid))
	if h == 0 {
		return ""
	}
	defer procCloseHandle.Call(h)
	buf := make([]uint16, 512)
	n := uint32(len(buf))
	r, _, _ := procQueryFullProcessImageNameW.Call(h, 0,
		uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&n)))
	if r == 0 {
		return ""
	}
	name := syscall.UTF16ToString(buf[:n])
	if i := strings.LastIndexByte(name, '\\'); i >= 0 {
		name = name[i+1:]
	}
	return strings.ToLower(name)
}

func isSC2Process(pid uint32) bool {
	return sc2ProcessNames[processImageName(pid)]
}

// foregroundIsSC2：当前前台窗口是否属于 SC2 进程（「仅游戏内显示」模式的判据，调研 §3.4）
func foregroundIsSC2() bool {
	h, _, _ := procGetForegroundWindow.Call()
	if h == 0 {
		return false
	}
	var pid uint32
	procGetWindowThreadProcessId.Call(h, uintptr(unsafe.Pointer(&pid)))
	return isSC2Process(pid)
}

// findGameWindow：枚举顶层窗口找 SC2 主窗口（按进程名而非窗口标题，语言无关）
var enumGameCB = syscall.NewCallback(func(h, _ uintptr) uintptr {
	if gameHwndFound != 0 {
		return 1
	}
	if !isWindowVisible(h) {
		return 1
	}
	var pid uint32
	procGetWindowThreadProcessId.Call(h, uintptr(unsafe.Pointer(&pid)))
	if isSC2Process(pid) {
		gameHwndFound = h
		return 0
	}
	return 1
})

var gameHwndFound uintptr

func findGameWindow() uintptr {
	gameHwndFound = 0
	procEnumWindows.Call(enumGameCB, 0)
	return gameHwndFound
}
