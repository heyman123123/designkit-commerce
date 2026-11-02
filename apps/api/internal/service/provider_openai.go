package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// OpenAIProvider 通过 OpenAI 兼容接口完成视觉分析与图片生成。
// 兼容 OpenAI、Azure OpenAI 网关、以及多数国内代理服务。
type OpenAIProvider struct {
	BaseURL           string
	APIKey            string
	ImageModel        string
	ChatModel         string
	HTTP              *http.Client
	CostImageCents    int
	CostAnalysisCents int
}

func NewOpenAIProvider(baseURL, apiKey, imageModel, chatModel string, costImage, costAnalysis int) *OpenAIProvider {
	if baseURL == "" {
		baseURL = "https://api.openai.com/v1"
	}
	if imageModel == "" {
		imageModel = "gpt-image-1"
	}
	if chatModel == "" {
		chatModel = "gpt-4o-mini"
	}
	if costImage <= 0 {
		costImage = 4
	}
	if costAnalysis <= 0 {
		costAnalysis = 1
	}
	return &OpenAIProvider{
		BaseURL: strings.TrimRight(baseURL, "/"), APIKey: apiKey,
		ImageModel: imageModel, ChatModel: chatModel,
		HTTP:              &http.Client{Timeout: 120 * time.Second},
		CostImageCents:    costImage,
		CostAnalysisCents: costAnalysis,
	}
}

func (p *OpenAIProvider) Name() string { return "openai" }

/* ---------------- 视觉分析 ---------------- */

type chatMessage struct {
	Role    string `json:"role"`
	Content any    `json:"content"`
}

type chatRequest struct {
	Model       string        `json:"model"`
	Messages    []chatMessage `json:"messages"`
	Temperature float64       `json:"temperature"`
}

type chatResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
}

// Analyze 让视觉模型描述商品与风险；失败时降级为本地启发式，避免阻断生成。
func (p *OpenAIProvider) Analyze(ctx context.Context, data []byte, mime string) (Analysis, error) {
	if len(data) == 0 {
		return heuristicAnalysis(data, mime), nil
	}
	if mime == "" {
		mime = "image/png"
	}
	dataURL := "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data)
	prompt := `分析这张电商商品图，只返回 JSON：
{"labels":["品类/材质/颜色等标签"],"attributes":{"key":"value"},"ocr":"图中可见文字","risks":["可能的版权/商标/夸大宣传风险"],"summary":"一句话卖点摘要"}
不要编造图中不存在的元素；不确定就留空。`

	body := chatRequest{
		Model: p.ChatModel,
		Messages: []chatMessage{
			{Role: "system", Content: "你是电商视觉分析助手，只输出 JSON。"},
			{Role: "user", Content: []map[string]any{
				{"type": "text", "text": prompt},
				{"type": "image_url", "image_url": map[string]string{"url": dataURL}},
			}},
		},
		Temperature: 0.2,
	}
	raw, err := p.postJSON(ctx, "/chat/completions", body)
	if err != nil {
		return heuristicAnalysis(data, mime), nil
	}
	var resp chatResponse
	if err := json.Unmarshal(raw, &resp); err != nil || len(resp.Choices) == 0 {
		return heuristicAnalysis(data, mime), nil
	}
	parsed, err := parseAnalysisJSON(resp.Choices[0].Message.Content)
	if err != nil {
		return heuristicAnalysis(data, mime), nil
	}
	return parsed, nil
}

func parseAnalysisJSON(text string) (Analysis, error) {
	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start < 0 || end <= start {
		return Analysis{}, errors.New("模型未返回 JSON")
	}
	var a Analysis
	if err := json.Unmarshal([]byte(text[start:end+1]), &a); err != nil {
		return Analysis{}, err
	}
	if a.Labels == nil {
		a.Labels = []string{}
	}
	if a.Risks == nil {
		a.Risks = []string{}
	}
	if a.Attributes == nil {
		a.Attributes = map[string]string{}
	}
	return a, nil
}

func heuristicAnalysis(data []byte, mime string) Analysis {
	labels := []string{"product"}
	if strings.HasSuffix(strings.ToLower(mime), "png") {
		labels = append(labels, "png")
	}
	return Analysis{
		Labels:     labels,
		Attributes: map[string]string{"source_bytes": fmt.Sprint(len(data)), "mime": mime},
		Risks:      []string{},
		Summary:    "未启用视觉模型或分析失败，使用本地占位分析",
	}
}

/* ---------------- 图片生成 ---------------- */

type imageRequest struct {
	Model          string `json:"model"`
	Prompt         string `json:"prompt"`
	Size           string `json:"size"`
	N              int    `json:"n"`
	ResponseFormat string `json:"response_format"`
}

type imageResponse struct {
	Data []struct {
		B64JSON string `json:"b64_json"`
		URL     string `json:"url"`
	} `json:"data"`
}

func (p *OpenAIProvider) Generate(ctx context.Context, req GenerateRequest) (Generated, error) {
	prompt := buildPrompt(req.Template, req.SKUCode, req.Width, req.Height)
	body := imageRequest{
		Model: p.ImageModel, Prompt: prompt, Size: pickSize(req.Width, req.Height),
		N: 1, ResponseFormat: "b64_json",
	}
	raw, err := p.postJSON(ctx, "/images/generations", body)
	if err != nil {
		return Generated{}, err
	}
	var resp imageResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return Generated{}, fmt.Errorf("解析生成接口响应失败")
	}
	if len(resp.Data) == 0 {
		return Generated{}, fmt.Errorf("生成接口未返回图片")
	}
	var bytesOut []byte
	if resp.Data[0].B64JSON != "" {
		bytesOut, err = base64.StdEncoding.DecodeString(resp.Data[0].B64JSON)
		if err != nil {
			return Generated{}, fmt.Errorf("生成图片解码失败")
		}
	} else if resp.Data[0].URL != "" {
		bytesOut, err = p.download(ctx, resp.Data[0].URL)
		if err != nil {
			return Generated{}, err
		}
	} else {
		return Generated{}, fmt.Errorf("生成结果既无 b64 也无链接")
	}

	cfg, _, err := image.DecodeConfig(bytes.NewReader(bytesOut))
	if err != nil {
		return Generated{}, fmt.Errorf("生成图片无法识别")
	}
	mime := "image/png"
	if len(bytesOut) > 3 && bytesOut[0] == 0xFF && bytesOut[1] == 0xD8 {
		mime = "image/jpeg"
	}
	return Generated{
		Bytes: bytesOut, Mime: mime, Width: cfg.Width, Height: cfg.Height,
		CostCents: p.CostImageCents,
	}, nil
}

func (p *OpenAIProvider) download(ctx context.Context, url string) ([]byte, error) {
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("下载生成图片失败")
	}
	res, err := p.HTTP.Do(r)
	if err != nil {
		return nil, fmt.Errorf("下载生成图片失败：网络错误")
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("下载生成图片失败：HTTP %d", res.StatusCode)
	}
	return io.ReadAll(io.LimitReader(res.Body, 32<<20))
}

// postJSON 带 2 次重试（仅 5xx 与网络错误），错误信息不含密钥。
func (p *OpenAIProvider) postJSON(ctx context.Context, path string, payload any) ([]byte, error) {
	if p.APIKey == "" {
		return nil, fmt.Errorf("未配置 OPENAI_API_KEY，无法调用视觉模型")
	}
	buf, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(time.Duration(attempt) * 2 * time.Second):
			}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.BaseURL+path, bytes.NewReader(buf))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+p.APIKey)
		res, err := p.HTTP.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("模型服务网络错误")
			continue
		}
		out, readErr := io.ReadAll(io.LimitReader(res.Body, 32<<20))
		res.Body.Close()
		if readErr != nil {
			lastErr = fmt.Errorf("读取模型响应失败")
			continue
		}
		if res.StatusCode >= 200 && res.StatusCode < 300 {
			return out, nil
		}
		lastErr = fmt.Errorf("模型服务返回 HTTP %d：%s", res.StatusCode, truncate(sanitize(string(out)), 180))
		if res.StatusCode < 500 {
			return nil, lastErr
		}
	}
	return nil, lastErr
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// sanitize 防止把密钥片段带进错误信息与日志。
func sanitize(s string) string {
	if len(s) > 400 {
		s = s[:400]
	}
	return strings.ReplaceAll(strings.ReplaceAll(s, "\n", " "), "\r", " ")
}

func pickSize(w, h int) string {
	if w <= 0 || h <= 0 {
		return "1024x1024"
	}
	if h > w {
		return "1024x1536"
	}
	return "1024x1024"
}

func buildPrompt(template, skuCode string, w, h int) string {
	base := "电商商品图，产品主体清晰、边缘干净、比例真实，无文字水印，无品牌 logo，无夸大宣传"
	switch template {
	case "scene":
		return fmt.Sprintf("%s；真实生活场景，自然光与柔和阴影，商品为视觉主体，背景简洁不抢镜，SKU %s，输出 %d×%d", base, skuCode, w, h)
	case "selling_point":
		return fmt.Sprintf("%s；突出 2-3 个核心卖点，构图留出文字排版空间，配色克制，SKU %s，输出 %d×%d", base, skuCode, w, h)
	default:
		return fmt.Sprintf("%s；纯白或极浅灰背景，商品居中占画面 70%%，顶部留白，适用于平台主图，SKU %s，输出 %d×%d", base, skuCode, w, h)
	}
}

/* ---------------- 工厂 ---------------- */

// NewProvider 依据环境变量选择供应商；未配置时退回 mock，保证链路可跑。
func NewProvider() Provider {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("PROVIDER"))) {
	case "openai", "openai-compatible", "compatible":
		return NewOpenAIProvider(
			os.Getenv("OPENAI_BASE_URL"),
			os.Getenv("OPENAI_API_KEY"),
			os.Getenv("OPENAI_IMAGE_MODEL"),
			os.Getenv("OPENAI_CHAT_MODEL"),
			envCents("COST_PER_IMAGE_CENTS", 4),
			envCents("COST_PER_ANALYSIS_CENTS", 1),
		)
	default:
		return MockProvider{}
	}
}

func envCents(key string, fallback int) int {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			return n
		}
	}
	return fallback
}
