package service

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
)

// QCIssue 是质检发现的一个问题项。
type QCIssue struct {
	Code     string `json:"code"`
	Message  string `json:"message"`
	Severity string `json:"severity"` // fail|warn
}

// QCResult 是一次生成结果的质检结论。
type QCResult struct {
	Score  int       `json:"score"`
	Passed bool      `json:"passed"`
	Issues []QCIssue `json:"issues"`
}

// JSON 返回入库用的紧凑 JSON；空问题返回 []。
func (r QCResult) JSON() string {
	if r.Issues == nil {
		r.Issues = []QCIssue{}
	}
	b, err := json.Marshal(r.Issues)
	if err != nil {
		return "[]"
	}
	return string(b)
}

// Assess 对生成图做基础质检：分辨率、长宽比、透明通道、文件体积、主图白底。
// 规则刻意保守：只拦明显不可用的图，审美与合规问题留给人工审核。
func Assess(data []byte, mime, template string) QCResult {
	res := QCResult{Score: 100, Passed: true, Issues: []QCIssue{}}
	add := func(code, msg, severity string, penalty int) {
		res.Issues = append(res.Issues, QCIssue{Code: code, Message: msg, Severity: severity})
		res.Score -= penalty
		if severity == "fail" {
			res.Passed = false
		}
	}

	if len(data) == 0 {
		add("empty_file", "生成结果为空文件", "fail", 100)
		res.Score = 0
		return res
	}
	// 纯白/纯色图压缩后可能只有几 KB，体积只作为提示，不作为拦截条件。
	if len(data) < 2*1024 {
		add("tiny_file", fmt.Sprintf("文件仅 %d 字节，可能生成失败或内容缺失", len(data)), "warn", 15)
	}

	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		add("decode_failed", "图片无法解码，可能格式损坏", "fail", 60)
		res.Score = 0
		return res
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w < 800 || h < 800 {
		add("low_resolution", fmt.Sprintf("分辨率 %d×%d 低于 800×800，不符合平台主图要求", w, h), "fail", 35)
	}
	if h > 0 {
		ratio := float64(w) / float64(h)
		if ratio < 0.95 || ratio > 1.05 {
			add("aspect_ratio", fmt.Sprintf("长宽比 %.2f 偏离 1:1，导出后可能被平台裁切", ratio), "warn", 10)
		}
	}
	if hasAlpha(img) {
		add("has_alpha", "图片带透明通道，部分平台会转为黑底", "warn", 8)
	}
	if template == "main" {
		if bright, uniform := cornerBackground(img); !bright {
			add("background_not_white", "四角背景不是白底，主图可能不符合平台要求", "warn", 12)
		} else if !uniform {
			add("background_uneven", "背景亮度不均，可能出现灰边", "warn", 6)
		}
	}
	res.Score = clamp(res.Score, 0, 100)
	return res
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// hasAlpha 采样像素判断是否真的存在半透明，避免把带 alpha 通道但全不透明的 PNG 误报。
func hasAlpha(img image.Image) bool {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w == 0 || h == 0 {
		return false
	}
	stepX, stepY := w/100, h/100
	if stepX < 1 {
		stepX = 1
	}
	if stepY < 1 {
		stepY = 1
	}
	for y := b.Min.Y; y < b.Max.Y; y += stepY {
		for x := b.Min.X; x < b.Max.X; x += stepX {
			c := color.NRGBAModel.Convert(img.At(x, y)).(color.NRGBA)
			if c.A < 250 {
				return true
			}
		}
	}
	return false
}

// cornerBackground 采样四角 5% 内缩区域，判断是否白底且亮度均匀。
func cornerBackground(img image.Image) (bright bool, uniform bool) {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w < 40 || h < 40 {
		return false, false
	}
	insetX := w / 20
	insetY := h / 20
	pts := [][2]int{
		{b.Min.X + insetX, b.Min.Y + insetY},
		{b.Max.X - 1 - insetX, b.Min.Y + insetY},
		{b.Min.X + insetX, b.Max.Y - 1 - insetY},
		{b.Max.X - 1 - insetX, b.Max.Y - 1 - insetY},
	}
	minL, maxL := 255, 0
	for _, p := range pts {
		g := color.GrayModel.Convert(img.At(p[0], p[1])).(color.Gray)
		l := int(g.Y)
		if l < minL {
			minL = l
		}
		if l > maxL {
			maxL = l
		}
	}
	return minL >= 225, maxL-minL <= 18
}
