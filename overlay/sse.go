package main

import (
	"encoding/json"
	"net/http"
	"sync"
)

// /live —— SSE 状态回推（调研稿 §7.2 的「WebSocket /live」以 SSE 等价实现：
// 场景是 exe → 网页的单向推送，SSE 零依赖、过代理/杀软更友好；
// 网页 → exe 的反向指令已有 /overlay/control 与 /overlay/style 覆盖）。
// 事件：ready（连接时应） / control（热键·托盘·HTTP 触发的播放控制回声） /
//       mode（三开关变化） / game（SC2 前台进出） / script（收到新播报脚本）。

type sseHub struct {
	mu      sync.Mutex
	clients map[chan []byte]bool
}

func newSseHub() *sseHub {
	return &sseHub{clients: make(map[chan []byte]bool)}
}

func (a *App) broadcast(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	a.sse.mu.Lock()
	defer a.sse.mu.Unlock()
	for ch := range a.sse.clients {
		select {
		case ch <- b:
		default: // 慢消费者丢帧，保服务端不阻塞
		}
	}
}

func (a *App) handleLive(w http.ResponseWriter, r *http.Request) {
	cors(w, r)
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")

	ch := make(chan []byte, 64)
	a.sse.mu.Lock()
	a.sse.clients[ch] = true
	n := len(a.sse.clients)
	a.sse.mu.Unlock()
	defer func() {
		a.sse.mu.Lock()
		delete(a.sse.clients, ch)
		a.sse.mu.Unlock()
	}()

	_, _ = w.Write([]byte("retry: 2000\n\n"))
	ready, _ := json.Marshal(map[string]any{
		"type": "ready", "name": ovName, "version": ovVersion,
		"clients": n, "clickThrough": a.clickThrough,
		"followGame": a.followGame, "onlyWhenGame": a.onlyWhenGame,
	})
	_, _ = w.Write([]byte("data: " + string(ready) + "\n\n"))
	fl.Flush()

	for {
		select {
		case b := <-ch:
			if _, err := w.Write(append(append([]byte("data: "), b...), '\n', '\n')); err != nil {
				return
			}
			fl.Flush()
		case <-r.Context().Done():
			return
		}
	}
}
