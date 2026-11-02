package service

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"strings"
)

type Analysis struct {
	Labels     []string          `json:"labels"`
	Attributes map[string]string `json:"attributes"`
	OCR        string            `json:"ocr"`
	Risks      []string          `json:"risks"`
	Summary    string            `json:"summary"`
}

type GenerateRequest struct {
	Template    string
	SKUCode     string
	SourceBytes []byte
	SourceMime  string
	Width       int
	Height      int
}

type Generated struct {
	Bytes     []byte
	Mime      string
	Width     int
	Height    int
	CostCents int
}

// Provider 抽象视觉分析与图片生成，便于替换模型供应商。
type Provider interface {
	Name() string
	Analyze(ctx context.Context, data []byte, mime string) (Analysis, error)
	Generate(ctx context.Context, req GenerateRequest) (Generated, error)
}

// MockProvider 生成可用的占位图，保证端到端流程在无外部模型时也能跑通。
type MockProvider struct{}

func (MockProvider) Name() string { return "mock" }

func (MockProvider) Analyze(_ context.Context, data []byte, mime string) (Analysis, error) {
	if mime != "" && !strings.HasPrefix(mime, "image/") {
		return Analysis{}, fmt.Errorf("unsupported mime %q", mime)
	}
	return Analysis{
		Labels:     []string{"product", "unknown-category"},
		Attributes: map[string]string{"source_bytes": fmt.Sprint(len(data)), "mime": mime},
		Risks:      []string{},
		Summary:    "占位分析结果：接入真实视觉模型后替换",
	}, nil
}

var templateTint = map[string]color.RGBA{
	"main":          {R: 245, G: 247, B: 250, A: 255},
	"scene":         {R: 228, G: 238, B: 232, A: 255},
	"selling_point": {R: 236, G: 238, B: 246, A: 255},
}

func (MockProvider) Generate(_ context.Context, req GenerateRequest) (Generated, error) {
	w, h := req.Width, req.Height
	if w <= 0 {
		w = 1000
	}
	if h <= 0 {
		h = 1000
	}
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	bg, ok := templateTint[req.Template]
	if !ok {
		bg = templateTint["main"]
	}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, bg)
		}
	}
	// 中央画一个代表商品主体的方块，便于人眼确认链路生效
	padX, padY := w/4, h/4
	body := color.RGBA{R: 96, G: 128, B: 160, A: 255}
	for y := padY; y < h-padY; y++ {
		for x := padX; x < w-padX; x++ {
			img.Set(x, y, body)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return Generated{}, err
	}
	return Generated{Bytes: buf.Bytes(), Mime: "image/png", Width: w, Height: h, CostCents: 2}, nil
}
