package main

import (
	"log"
	"runtime"
	"unsafe"
)

// 全局热键：Alt+↑/↓/←/→（与网页端语音播报条一致，调研 §3.6）。
// RegisterHotKey 的 hwnd=0 → WM_HOTKEY 投递到注册线程的消息队列，
// 因此本协程必须 LockOSThread + GetMessage 泵消息，不能只注册不泵。

const (
	wmHotkey    = 0x0312
	modAlt      = 0x0001
	modNoRepeat = 0x4000
	vkLeft      = 0x25
	vkUp        = 0x26
	vkRight     = 0x27
	vkDown      = 0x28
)

type winMsg struct {
	hwnd    uintptr
	message uint32
	_       uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      [2]int32
	_       uint32
}

var (
	procRegisterHotKey = user32.NewProc("RegisterHotKey")
	procGetMessageW    = user32.NewProc("GetMessageW")
)

func (a *App) hotkeyLoop() {
	runtime.LockOSThread()
	hotkeys := []struct {
		id int
		vk uintptr
	}{
		{1, vkUp}, {2, vkDown}, {3, vkLeft}, {4, vkRight},
	}
	for _, hk := range hotkeys {
		if r, _, _ := procRegisterHotKey.Call(0, uintptr(hk.id), uintptr(modAlt|modNoRepeat), hk.vk); r == 0 {
			log.Printf("[overlay] 全局热键 #%d 注册失败（可能被其他程序占用）", hk.id)
		}
	}
	log.Printf("[overlay] 全局热键就绪：Alt+↑ 播放/暂停 · Alt+↓ 重置 · Alt+←/→ ±10s")

	var m winMsg
	for {
		r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if r == 0 || ^r == 0 {
			return
		}
		if m.message != wmHotkey {
			continue
		}
		switch m.wParam {
		case 1:
			a.dispatch("toggle", 0)
		case 2:
			a.dispatch("reset", 0)
		case 3:
			a.dispatch("seekBy", -10)
		case 4:
			a.dispatch("seekBy", 10)
		}
	}
}
