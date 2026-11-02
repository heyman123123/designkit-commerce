package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"testing"
)

func tinyPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{255, 255, 255, 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("png: %v", err)
	}
	return buf.Bytes()
}

func TestOpenAIGenerate(t *testing.T) {
	pngBytes := tinyPNG(t, 64, 64)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/images/generations" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Errorf("missing auth header")
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["model"] != "img-model" {
			t.Errorf("model not passed: %v", body["model"])
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{{"b64_json": base64.StdEncoding.EncodeToString(pngBytes)}},
		})
	}))
	defer srv.Close()

	p := NewOpenAIProvider(srv.URL, "test-key", "img-model", "chat-model", 7, 1)
	got, err := p.Generate(context.Background(), GenerateRequest{Template: "main", SKUCode: "A-1", Width: 1024, Height: 1024})
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if got.Width != 64 || got.Height != 64 {
		t.Fatalf("unexpected size %dx%d", got.Width, got.Height)
	}
	if got.CostCents != 7 {
		t.Fatalf("cost = %d, want 7", got.CostCents)
	}
	if got.Mime != "image/png" {
		t.Fatalf("mime = %s", got.Mime)
	}
}

func TestOpenAIRetryOn500(t *testing.T) {
	pngBytes := tinyPNG(t, 32, 32)
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			http.Error(w, `{"error":{"message":"upstream boom"}}`, http.StatusBadGateway)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{{"b64_json": base64.StdEncoding.EncodeToString(pngBytes)}},
		})
	}))
	defer srv.Close()

	p := NewOpenAIProvider(srv.URL, "k", "m", "c", 1, 1)
	if _, err := p.Generate(context.Background(), GenerateRequest{Template: "scene", Width: 512, Height: 512}); err != nil {
		t.Fatalf("retry generate: %v", err)
	}
	if calls < 2 {
		t.Fatalf("expected retry, calls=%d", calls)
	}
}

func TestOpenAIAnalyzeFallback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]any{"content": "这不是 JSON"}}},
		})
	}))
	defer srv.Close()

	p := NewOpenAIProvider(srv.URL, "k", "m", "c", 1, 1)
	a, err := p.Analyze(context.Background(), tinyPNG(t, 8, 8), "image/png")
	if err != nil {
		t.Fatalf("analyze should not error on malformed JSON: %v", err)
	}
	if len(a.Labels) == 0 {
		t.Fatalf("expected heuristic labels, got %+v", a)
	}
}

func TestOpenAIAnalyzeParsesJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		content := "```json\n{\"labels\":[\"charger\"],\"attributes\":{\"color\":\"black\"},\"ocr\":\"\",\"risks\":[],\"summary\":\"快充头\"}\n```"
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]any{"content": content}}},
		})
	}))
	defer srv.Close()

	p := NewOpenAIProvider(srv.URL, "k", "m", "c", 1, 1)
	a, err := p.Analyze(context.Background(), tinyPNG(t, 8, 8), "image/png")
	if err != nil {
		t.Fatalf("analyze: %v", err)
	}
	if len(a.Labels) != 1 || a.Labels[0] != "charger" {
		t.Fatalf("labels = %v", a.Labels)
	}
	if a.Attributes["color"] != "black" {
		t.Fatalf("attributes = %v", a.Attributes)
	}
}
