package service

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"testing"
	"time"
)

func makePNG(t *testing.T, w, h int, bg color.RGBA) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, bg)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}

func TestAssessWhiteMain(t *testing.T) {
	data := makePNG(t, 1000, 1000, color.RGBA{255, 255, 255, 255})
	res := Assess(data, "image/png", "main")
	if !res.Passed {
		t.Fatalf("white 1000x1000 should pass, got %+v", res)
	}
	if res.Score < 90 {
		t.Fatalf("expected high score, got %d", res.Score)
	}
}

func TestAssessLowResolution(t *testing.T) {
	data := makePNG(t, 400, 400, color.RGBA{255, 255, 255, 255})
	res := Assess(data, "image/png", "main")
	if res.Passed {
		t.Fatalf("400x400 should fail resolution check: %+v", res)
	}
	found := false
	for _, i := range res.Issues {
		if i.Code == "low_resolution" {
			found = true
		}
	}
	if !found {
		t.Fatalf("missing low_resolution issue: %+v", res.Issues)
	}
}

func TestAssessAspectRatioWarn(t *testing.T) {
	data := makePNG(t, 1200, 800, color.RGBA{255, 255, 255, 255})
	res := Assess(data, "image/png", "scene")
	if !res.Passed {
		t.Fatalf("aspect ratio should be warn not fail: %+v", res)
	}
	found := false
	for _, i := range res.Issues {
		if i.Code == "aspect_ratio" && i.Severity == "warn" {
			found = true
		}
	}
	if !found {
		t.Fatalf("missing aspect_ratio warn: %+v", res.Issues)
	}
}

func TestAssessGarbage(t *testing.T) {
	res := Assess([]byte("not an image at all, definitely broken"), "image/png", "main")
	if res.Passed {
		t.Fatalf("garbage should fail: %+v", res)
	}
	if res.Score != 0 {
		t.Fatalf("expected 0 score, got %d", res.Score)
	}
}

func TestEligibleBackoff(t *testing.T) {
	now := time.Now()
	if !eligible(0, now, now) {
		t.Fatal("fresh job should be eligible")
	}
	if eligible(2, now, now) {
		t.Fatal("second retry should wait")
	}
	if !eligible(2, now.Add(-30*time.Second), now) {
		t.Fatal("job older than backoff should be eligible")
	}
}
