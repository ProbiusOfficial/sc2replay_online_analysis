// sc2-overlay —— SC2 录像分析站的桌面悬浮组件（可选，Windows）。
//
// 调研文档：docs/RESEARCH-ALWAYS-ON-TOP-OVERLAY.md（架构 §7，视觉规格 prototype/overlay-exe.html）。
// 职责边界：exe 只管窗口与自走时钟；分析网页负责解析并一次性下发播报脚本。
// M1 范围：置顶无边框透明窗 + 本地服务（/health、POST /overlay）+ 播报脚本渲染与推进。
package main

import (
	"embed"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed all:frontend/dist
var assets embed.FS

// forwardShow：把「显示」指令转发给已运行的实例（127.0.0.1:18760）。
func forwardShow() bool {
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Post("http://127.0.0.1:18760/overlay/control",
		"application/json", strings.NewReader(`{"action":"show"}`))
	if err != nil {
		log.Printf("[overlay] 转发失败（无运行实例？）: %v", err)
		return false
	}
	resp.Body.Close()
	return true
}

// anotherInstanceRunning：命名互斥锁检测单实例。
func anotherInstanceRunning() bool {
	m, exists := createMutex(`Local\sc2-overlay-singleton`)
	if exists {
		return true
	}
	keepMutexHandle = m // 保活句柄，防止 GC 释放锁
	return false
}

var keepMutexHandle uintptr

func main() {
	// sc2overlay:// 唤起：已有实例在跑就转发显示指令后退出，否则继续正常启动
	if len(os.Args) > 1 && strings.HasPrefix(os.Args[1], "sc2overlay://") {
		if forwardShow() {
			return
		}
	}
	// 单实例锁：第二次启动（双击 exe）转发显示指令后退出（调研 §3.9）
	if anotherInstanceRunning() {
		forwardShow()
		return
	}

	app := NewApp()

	err := wails.Run(&options.App{
		Title:         "sc2-overlay",
		Width:         1180,
		Height:        36,
		DisableResize: true,
		Frameless:     true,
		AlwaysOnTop:   true,
		// 必须显式声明最小尺寸：Wails 只有在 MinWidth/MinHeight > 0 时才在
		// WM_GETMINMAXINFO 里接管 PtMinTrackSize，否则系统默认最小轨迹
		// （~36 逻辑像素高 / ~135 宽）会钳制 ticker(30) 等小尺寸版式。
		MinWidth:    120,
		MinHeight:   10,
		AssetServer: &assetserver.Options{Assets: assets},
		OnStartup:   app.startup,
		OnShutdown:  app.shutdown,
		Bind:        []interface{}{app},
		Windows: &windows.Options{
			// 逐像素透明的前提：webview 背景透明 + 窗口分层（调研 §3.3）
			WebviewIsTransparent: true,
			WindowIsTranslucent:  true,
			DisableWindowIcon:    true,
		},
	})
	if err != nil {
		log.Fatal(err)
	}
}
