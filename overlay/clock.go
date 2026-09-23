// clock.go —— 把 SC2 的 HUD 时钟从屏幕上读出来。
//
// 为什么要读它：SC2 不提供任何外部读时钟的接口，悬浮窗只能按「录像速度推算的倍率」走表，
// 起点对不对齐没人知道（实测见过差 1 分 43 秒：画面 11:20、悬浮条 13:03）。
// 唯一可靠的办法就是把 HUD 上的时钟读出来 —— 截屏 + 识别 + 多次采样算流速。
//
// 链路：
//
//	grabGameWindow   截 SC2 窗口（按窗口矩形从屏幕抓，抓到的就是玩家看到的样子）
//	findClockBand    在左下角搜索区里按「近白像素」的行列投影找出时钟那一行
//	splitDigits      按列投影把一行数字切成单个字符的方框（等宽字体，间隙即分隔）
//	识别（下一步）    模板匹配：SC2 时钟是固定像素字，10 个模板就够
//
// 本文件只做前两步 + 落盘调试图，识别单独接。
package main

import (
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

// 时钟区域（相对 SC2 窗口的比例）。默认值是从一张 1920×1200 实机截图上量出来的：
// 时钟「11:20」落在 x 295~360、y 865~900，即 x 15.4%~18.8%、y 72.1%~75.0%，这里再留点余量。
//
// ⚠️ 为什么不做「在大范围里自动搜白字」（第一版就是这么写的，失败了）：
// 实测时钟文字是**淡紫**而不是纯白 —— 最亮像素 rgb(234,226,207)、均值约 222；
// 而 HUD 的金色边框和一条装饰线比它更亮、像素更密集。按「白」或「亮度」去搜，
// 会**稳定地命中装饰线**，压根到不了时钟。既然 HUD 布局本身固定，用固定区域最可靠；
// 区域可被 config.json 覆盖（见 App.clockX0..Y1 的读取），偏了能自己调。
const (
	defaultClockX0 = 0.168
	defaultClockX1 = 0.200
	defaultClockY0 = 0.712
	defaultClockY1 = 0.756
)

// 时钟文字的亮度阈值。淡紫字均值 ~222，深色底板 ~60，阈值取中间偏上。
const clockLumCut = 150

// isClockInk：时钟字形是「比较亮」的像素（不要求纯白 —— 它是淡紫的）。
func isClockInk(c color.RGBA) bool {
	return (int(c.R)+int(c.G)+int(c.B))/3 >= clockLumCut
}

// clockSearchArea：时钟区域在窗口内的像素矩形。
func (a *App) clockSearchArea(w, h int) image.Rectangle {
	x0, x1, y0, y1 := a.clockX0, a.clockX1, a.clockY0, a.clockY1
	if x1 <= x0 || y1 <= y0 {
		x0, x1, y0, y1 = defaultClockX0, defaultClockX1, defaultClockY0, defaultClockY1
	}
	return image.Rect(int(float64(w)*x0), int(float64(h)*y0),
		int(float64(w)*x1), int(float64(h)*y1))
}

// findClockBand：时钟区域就是行带 —— 直接用整个区域高度。
// 保留这个函数名是为了让调用点和调试图的语义统一；裁掉上下边缘各 1px 的抗锯齿。
func (a *App) findClockBand(img *image.RGBA) (image.Rectangle, int) {
	b := img.Bounds()
	band := a.clockSearchArea(b.Dx(), b.Dy()).Intersect(b)
	if band.Empty() {
		return image.Rectangle{}, 0
	}
	// 在区域内按行统计墨迹像素，掐掉两边不到 2 个像素的空行（抗锯齿/边框），
	// 但**不做「找最密行」** —— 那会被 HUD 装饰线骗走。
	ink := 0
	for y := band.Min.Y; y < band.Max.Y; y++ {
		for x := band.Min.X; x < band.Max.X; x++ {
			if isClockInk(img.RGBAAt(x, y)) {
				ink++
			}
		}
	}
	return band, ink
}

// grabGameWindow：按 SC2 窗口矩形从屏幕抓图。
// 不做 PrintWindow —— 我们要的就是**玩家屏幕上此刻显示的样子**：窗口被遮挡时抓到遮挡物，
// 那本来就该判为「读不到」，而不是从后台缓冲区里读出一份和玩家所见不符的画面。
func grabGameWindow() (*image.RGBA, error) {
	h := findGameWindow()
	if h == 0 {
		return nil, fmt.Errorf("没找到 SC2 窗口")
	}
	l, t, r, b := getWindowRect(h)
	if r-l <= 0 || b-t <= 0 {
		return nil, fmt.Errorf("SC2 窗口矩形异常: (%d,%d)-(%d,%d)", l, t, r, b)
	}
	return grabRect(l, t, r-l, b-t)
}

// densestRun：在一维密度数组里找「和最大」的连续区间（允许中间有最小宽度的空隙）。
// 返回 [start, end) 的下标；全为 0 时返回 (-1, -1)。
//
// 现在用不上了（时钟改成固定区域定位），留着是因为切分/识别阶段可能还要挑「最长的一串字符」。
func densestRun(v []int, minGap int) (int, int) {
	bestS, bestE, bestSum := -1, -1, 0
	for s := 0; s < len(v); {
		if v[s] == 0 {
			s++
			continue
		}
		// 从 s 开始扩展，空隙 <= minGap 就继续
		sum, e, gap := 0, s, 0
		for e < len(v) {
			if v[e] == 0 {
				gap++
				if gap > minGap {
					break
				}
			} else {
				gap = 0
			}
			sum += v[e]
			e++
		}
		end := e - gap
		if sum > bestSum {
			bestS, bestE, bestSum = s, end, sum
		}
		s = e
	}
	return bestS, bestE
}

// dumpClockDebug：把「窗口截图 + 搜索区框 + 时钟候选框」拼一张调试图落盘，供人工核对。
//
// ⚠️ 落盘用**手写 24 位 BMP**，不用 image/png：实测引入 png 编码链（image/png + draw + zlib）
// 会让二进制涨 **808 KB**（1,856,512 vs 空 main 1,029,120），而 UPX 对已压缩数据几乎无效 ——
// 那 800 KB 会原样带到 8MB 的发布体积里。调试图只是一次性产物，压缩率无所谓，BMP 30 行就够。
func (a *App) dumpClockDebug(dir string) (string, error) {
	img, err := grabGameWindow()
	if err != nil {
		return "", err
	}
	band, total := a.findClockBand(img)
	a.lastClockBand = band
	a.lastClockPixels = total

	vis := image.NewRGBA(img.Bounds())
	copy(vis.Pix, img.Pix)
	drawRectOutline(vis, a.clockSearchArea(img.Bounds().Dx(), img.Bounds().Dy()), color.RGBA{255, 0, 0, 255})
	if !band.Empty() {
		drawRectOutline(vis, band, color.RGBA{0, 255, 0, 255})
		drawRectOutline(vis, band.Inset(-1), color.RGBA{0, 255, 0, 255})
	}
	if dir == "" {
		dir = os.TempDir()
	}
	_ = os.MkdirAll(dir, 0o755)
	out := filepath.Join(dir, "sc2-clock-debug.bmp")

	// 只留左下角那块，别把整窗写出去
	b := img.Bounds()
	crop := image.Rect(0, b.Dy()/2, b.Dx()/2, b.Dy())
	sub := image.NewRGBA(image.Rect(0, 0, crop.Dx(), crop.Dy()))
	for y := 0; y < crop.Dy(); y++ {
		copy(sub.Pix[y*sub.Stride:(y+1)*sub.Stride], vis.Pix[(crop.Min.Y+y)*vis.Stride+crop.Min.X*4:])
	}
	return out, writeBMP24(out, sub)
}

// writeBMP24：手写 24 位 BMP（自下而上、BGR、每行 4 字节对齐）。
func writeBMP24(path string, img image.Image) error {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	rowSize := (w*3 + 3) &^ 3
	dataSize := rowSize * h
	buf := make([]byte, 54+dataSize)

	buf[0], buf[1] = 'B', 'M'
	putU32(buf[2:], uint32(54+dataSize))
	putU32(buf[10:], 54)
	putU32(buf[14:], 40)
	putI32(buf[18:], int32(w))
	putI32(buf[22:], int32(h)) // 正高 = 自下而上
	buf[26], buf[27] = 1, 0
	buf[28], buf[29] = 24, 0
	putU32(buf[34:], uint32(dataSize))

	for y := 0; y < h; y++ {
		srcY := b.Max.Y - 1 - y
		off := 54 + y*rowSize
		for x := 0; x < w; x++ {
			r, g, bl, _ := img.At(b.Min.X+x, srcY).RGBA()
			buf[off+x*3+0] = byte(bl >> 8)
			buf[off+x*3+1] = byte(g >> 8)
			buf[off+x*3+2] = byte(r >> 8)
		}
	}
	return os.WriteFile(path, buf, 0o644)
}

func putU32(b []byte, v uint32) {
	b[0], b[1], b[2], b[3] = byte(v), byte(v>>8), byte(v>>16), byte(v>>24)
}

func putI32(b []byte, v int32) {
	putU32(b, uint32(v))
}

// ---- 切分 ----

// splitDigits：把时钟那一行切成单个字符的方框。
//
// SC2 时钟是等宽像素字，字符之间必有空白列 → **列投影**就能切干净；冒号也有墨迹，
// 会被当成一个「字符」返回（识别阶段再判它）。
//
// 顺手做宽度过滤：时钟区左边紧邻 HUD 的蓝色花边（实测宽 45px）会被切出一个超宽块，
// 而数字最宽也就 15px 上下 —— 超出 28px 的一律当装饰丢掉；宽 1px 的是描边碎屑，也丢。
func (a *App) splitDigits(img *image.RGBA, band image.Rectangle) []image.Rectangle {
	if band.Empty() {
		return nil
	}
	cols := make([]int, band.Dx())
	for x := band.Min.X; x < band.Max.X; x++ {
		n := 0
		for y := band.Min.Y; y < band.Max.Y; y++ {
			if isClockInk(img.RGBAAt(x, y)) {
				n++
			}
		}
		cols[x-band.Min.X] = n
	}
	var raw []image.Rectangle
	start := -1
	for i := 0; i <= len(cols); i++ {
		on := i < len(cols) && cols[i] > 0
		if on && start < 0 {
			start = i
		} else if !on && start >= 0 {
			raw = append(raw, image.Rect(band.Min.X+start, band.Min.Y, band.Min.X+i, band.Max.Y))
			start = -1
		}
	}
	kept := make([]image.Rectangle, 0, len(raw))
	for _, r := range raw {
		if w := r.Dx(); w >= 2 && w <= 28 {
			kept = append(kept, r)
		}
	}
	return kept
}

// ---- 识别（模板匹配）----

// clockTemplate：一个字符的位图模板。存成「每像素 1 bit」的字符串（'1'/'0'），
// 理由：SC2 时钟是固定字号的像素字，同字符每次渲染完全一致，模板可以很小、比得很准。
type clockTemplate struct {
	Char string `json:"char"`
	W    int    `json:"w"`
	H    int    `json:"h"`
	Bits string `json:"bits"` // 长度 W*H，'1' = 近白
}

// clockTplPath：模板落在用户配置目录，跟着 config.json 一起。
func clockTplPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "sc2-overlay", "clock-templates.json")
}

// bitmapOf：把某个字符方框二值化成模板格式。
func bitmapOf(img *image.RGBA, r image.Rectangle) clockTemplate {
	var sb strings.Builder
	sb.Grow(r.Dx() * r.Dy())
	for y := r.Min.Y; y < r.Max.Y; y++ {
		for x := r.Min.X; x < r.Max.X; x++ {
			if isClockInk(img.RGBAAt(x, y)) {
				sb.WriteByte('1')
			} else {
				sb.WriteByte('0')
			}
		}
	}
	return clockTemplate{W: r.Dx(), H: r.Dy(), Bits: sb.String()}
}

// distance：两个模板的差异像素数；尺寸不同则直接返回一个很大的值。
func (t clockTemplate) distance(o clockTemplate) int {
	if t.W != o.W || t.H != o.H {
		return 1 << 30
	}
	d := 0
	for i := 0; i < len(t.Bits) && i < len(o.Bits); i++ {
		if t.Bits[i] != o.Bits[i] {
			d++
		}
	}
	return d
}

// bestMatch：在模板库里找和给定位图最像的字符；差异超过总像素 25% 就认为「不认识」。
func bestMatch(tpls []clockTemplate, sample clockTemplate) (string, bool) {
	best, bestD := "", 1<<30
	for _, t := range tpls {
		if d := t.distance(sample); d < bestD {
			best, bestD = t.Char, d
		}
	}
	if best == "" {
		return "", false
	}
	if bestD*4 > len(sample.Bits) {
		return "", false
	}
	return best, true
}

// readClock：截图 → 定位 → 切分 → 逐个匹配。返回识别到的文本（如 "11:20"）与诊断信息。
// ok=false 时 text 里带上原因，前端据此退回手动输入。
func (a *App) readClock() (text string, ok bool, detail string) {
	tpls := a.loadClockTemplates()
	if len(tpls) == 0 {
		return "", false, "还没有数字模板可比对（先用一次手动对齐来喂模板）"
	}
	img, err := grabGameWindow()
	if err != nil {
		return "", false, err.Error()
	}
	band, total := a.findClockBand(img)
	a.lastClockBand, a.lastClockPixels = band, total
	if band.Empty() || total < 6 {
		return "", false, "没在 HUD 区域里找到时钟数字（UI 是不是按 Tab 隐藏了？）"
	}
	boxes := a.splitDigits(img, band)
	var sb strings.Builder
	for _, b := range boxes {
		ch, hit := bestMatch(tpls, bitmapOf(img, b))
		if !hit {
			sb.WriteByte('?')
			continue
		}
		sb.WriteString(ch)
	}
	s := sb.String()
	if strings.ContainsRune(s, '?') {
		return s, false, "有认不出的字符（模板库里还没见过）"
	}
	return s, true, ""
}

// learnClock：用一次**人工确认过的读数**给当前画面上的字符打标签，把新字形收进模板库。
// 这是让模板「自己长齐」的机制：用户每次手动对齐输对一个值，就把当帧的陌生字形补上，
// 认过几次之后 0-9 就齐了，之后就能全自动读。
func (a *App) learnClock(text string) int {
	img, err := grabGameWindow()
	if err != nil {
		return 0
	}
	band, _ := a.findClockBand(img)
	boxes := a.splitDigits(img, band)
	var raw []rune
	for _, r := range text {
		raw = append(raw, r)
	}
	if len(boxes) != len(raw) {
		return 0 // 切出来的字符数和读数对不上，宁可不学，别污染模板
	}
	tpls := a.loadClockTemplates()
	added := 0
	for i, b := range boxes {
		sample := bitmapOf(img, b)
		sample.Char = string(raw[i])
		known := false
		for _, t := range tpls {
			if t.Char == sample.Char && t.W == sample.W && t.H == sample.H {
				known = true
				break
			}
		}
		if !known {
			tpls = append(tpls, sample)
			added++
		}
	}
	if added > 0 {
		a.saveClockTemplates(tpls)
	}
	log.Printf("[clock] 学习：读数 %q → 新增 %d 个字形（模板库共 %d）", text, added, len(tpls))
	return added
}

func (a *App) loadClockTemplates() []clockTemplate {
	p := clockTplPath()
	if p == "" {
		return nil
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil
	}
	var t []clockTemplate
	if json.Unmarshal(b, &t) != nil {
		return nil
	}
	return t
}

func (a *App) saveClockTemplates(t []clockTemplate) {
	p := clockTplPath()
	if p == "" {
		return
	}
	_ = os.MkdirAll(filepath.Dir(p), 0o755)
	b, err := json.Marshal(t)
	if err != nil {
		return
	}
	_ = os.WriteFile(p, b, 0o644)
}

// ---- HTTP 端点 ----
//
// GET  /clock/read   读一次游戏时钟（截图 → 定位 → 切分 → 模板匹配）
// POST /clock/learn  用人工确认过的读数喂模板（{"text":"11:20"}）
// GET  /clock/debug  落一张调试图（搜索区红框 / 命中区绿框）并返回路径，用来核对定位

func (a *App) handleClockRead(w http.ResponseWriter, r *http.Request) {
	cors(w, r)
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	text, ok, detail := a.readClock()
	log.Printf("[clock] read ok=%v text=%q detail=%q band=%v px=%d",
		ok, text, detail, a.lastClockBand, a.lastClockPixels)
	writeJSON(w, map[string]any{
		"ok": ok, "text": text, "detail": detail,
		"band": a.lastClockBand.String(), "px": a.lastClockPixels,
		"templates": len(a.loadClockTemplates()),
	})
}

type learnReq struct {
	Text string `json:"text"`
}

func (a *App) handleClockLearn(w http.ResponseWriter, r *http.Request) {
	cors(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var q learnReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<12)).Decode(&q); err != nil {
		http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if !strings.Contains(q.Text, ":") {
		http.Error(w, "text 应当形如 11:20", http.StatusBadRequest)
		return
	}
	added := a.learnClock(q.Text)
	writeJSON(w, map[string]any{"ok": true, "added": added, "templates": len(a.loadClockTemplates())})
}

func (a *App) handleClockDebug(w http.ResponseWriter, r *http.Request) {
	cors(w, r)
	p, err := a.dumpClockDebug("")
	if err != nil {
		log.Printf("[clock] debug 失败: %v", err)
		writeJSON(w, map[string]any{"ok": false, "detail": err.Error()})
		return
	}
	log.Printf("[clock] 调试图: %s（band=%v px=%d）", p, a.lastClockBand, a.lastClockPixels)
	writeJSON(w, map[string]any{"ok": true, "file": p, "band": a.lastClockBand.String(), "px": a.lastClockPixels})
}

func drawRectOutline(img *image.RGBA, r image.Rectangle, c color.RGBA) {
	r = r.Intersect(img.Bounds())
	if r.Empty() {
		return
	}
	for x := r.Min.X; x < r.Max.X; x++ {
		img.SetRGBA(x, r.Min.Y, c)
		img.SetRGBA(x, r.Max.Y-1, c)
	}
	for y := r.Min.Y; y < r.Max.Y; y++ {
		img.SetRGBA(r.Min.X, y, c)
		img.SetRGBA(r.Max.X-1, y, c)
	}
}

// ---- GDI 抓屏（32 位 DIB，自上而下）----

var (
	gdi32                      = syscall.NewLazyDLL("gdi32.dll")
	procGetDC                  = user32.NewProc("GetDC")
	procReleaseDC              = user32.NewProc("ReleaseDC")
	procGetSystemMetrics       = user32.NewProc("GetSystemMetrics")
	procCreateCompatibleDC     = gdi32.NewProc("CreateCompatibleDC")
	procCreateCompatibleBitmap = gdi32.NewProc("CreateCompatibleBitmap")
	procSelectObjectGDI        = gdi32.NewProc("SelectObject")
	procBitBlt                 = gdi32.NewProc("BitBlt")
	procGetDIBits              = gdi32.NewProc("GetDIBits")
	procDeleteDC               = gdi32.NewProc("DeleteDC")
	procDeleteObject           = gdi32.NewProc("DeleteObject")
)

type bmiHeader struct {
	Size          uint32
	Width         int32
	Height        int32
	Planes        uint16
	BitCount      uint16
	Compression   uint32
	SizeImage     uint32
	XPelsPerMeter int32
	YPelsPerMeter int32
	ClrUsed       uint32
	ClrImportant  uint32
}

type bmi struct {
	Header bmiHeader
	Colors [1]uint32
}

const (
	smCxScreen   = 0
	smCyScreen   = 1
	srcCopy      = 0x00CC0020
	dibRGBColors = 0
	biRGB        = 0
)

// grabRect：从屏幕抓指定矩形（屏幕坐标，可为负）。
func grabRect(x, y, w, h int) (*image.RGBA, error) {
	if w <= 0 || h <= 0 {
		return nil, fmt.Errorf("抓屏尺寸非法: %dx%d", w, h)
	}
	hdcScreen, _, _ := procGetDC.Call(0)
	if hdcScreen == 0 {
		return nil, fmt.Errorf("GetDC 失败")
	}
	defer procReleaseDC.Call(0, hdcScreen)

	hdcMem, _, _ := procCreateCompatibleDC.Call(hdcScreen)
	if hdcMem == 0 {
		return nil, fmt.Errorf("CreateCompatibleDC 失败")
	}
	defer procDeleteDC.Call(hdcMem)

	hbm, _, _ := procCreateCompatibleBitmap.Call(hdcScreen, uintptr(w), uintptr(h))
	if hbm == 0 {
		return nil, fmt.Errorf("CreateCompatibleBitmap 失败")
	}
	defer procDeleteObject.Call(hbm)

	old, _, _ := procSelectObjectGDI.Call(hdcMem, hbm)
	defer procSelectObjectGDI.Call(hdcMem, old)

	if r, _, _ := procBitBlt.Call(hdcMem, 0, 0, uintptr(w), uintptr(h),
		hdcScreen, uintptr(x), uintptr(y), srcCopy); r == 0 {
		return nil, fmt.Errorf("BitBlt 失败")
	}

	bi := bmi{}
	bi.Header.Size = uint32(unsafe.Sizeof(bi.Header))
	bi.Header.Width = int32(w)
	bi.Header.Height = -int32(h) // 负高 = 自上而下，省一次翻转
	bi.Header.Planes = 1
	bi.Header.BitCount = 32
	bi.Header.Compression = biRGB

	buf := make([]byte, w*h*4)
	if r, _, _ := procGetDIBits.Call(hdcMem, hbm, 0, uintptr(h),
		uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&bi)), dibRGBColors); r == 0 {
		return nil, fmt.Errorf("GetDIBits 失败")
	}

	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < w*h; i++ {
		img.Pix[i*4+0] = buf[i*4+2] // BGRA → RGBA
		img.Pix[i*4+1] = buf[i*4+1]
		img.Pix[i*4+2] = buf[i*4+0]
		img.Pix[i*4+3] = 255
	}
	return img, nil
}
