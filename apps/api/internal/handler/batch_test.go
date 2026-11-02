package handler_test

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/heyman123123/designkit-commerce/apps/api/internal/model"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/service"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/storage"
)

// pngBytes 生成一张纯色 PNG，用于上传与直传登记测试。
func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for x := 0; x < w; x++ {
		for y := 0; y < h; y++ {
			img.Set(x, y, color.RGBA{R: 250, G: 250, B: 250, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}

// batchFixture 建好租户、项目、两个 SKU 并各跑一个完成的任务。
func batchFixture(t *testing.T) (*env, session, []string, []string) {
	t.Helper()
	e := newEnv(t)
	s := register(t, e, "batch@example.com", "Batch Lab")
	// 放宽 SKU 配额以便一次建两个 SKU。
	if err := e.db.Model(&model.Workspace{}).Where("id = ?", s.WSID).
		Updates(map[string]any{"sku_quota": 10, "export_quota": 20}).Error; err != nil {
		t.Fatalf("raise quota: %v", err)
	}
	code, out := e.do(t, http.MethodGet, "/v1/w/"+s.Slug+"/projects", s.Access, nil)
	if code != http.StatusOK {
		t.Fatalf("projects: %d %v", code, out)
	}
	pid := fmt.Sprint(out["items"].([]any)[0].(map[string]any)["id"])

	var skuIDs, jobIDs []string
	for i, code := range []string{"BAT-1", "BAT-2"} {
		status, body := e.do(t, http.MethodPost, "/v1/w/"+s.Slug+"/skus", s.Access, map[string]any{
			"project_id": pid, "code": code, "title": code,
		})
		if status != http.StatusCreated {
			t.Fatalf("create sku %s: %d %v", code, status, body)
		}
		skuID := fmt.Sprint(body["id"])
		skuIDs = append(skuIDs, skuID)
		status, body = e.do(t, http.MethodPost, "/v1/w/"+s.Slug+"/jobs", s.Access, map[string]any{
			"sku_id": skuID, "template": "main", "idempotency_key": fmt.Sprintf("batch-%d", i),
		})
		if status != http.StatusCreated {
			t.Fatalf("create job %d: %d %v", i, status, body)
		}
		jobIDs = append(jobIDs, fmt.Sprint(body["id"]))
	}

	store, err := storage.NewLocal(e.cfg.StorageDir)
	if err != nil {
		t.Fatalf("storage: %v", err)
	}
	runner := &service.Runner{DB: e.db, Store: store, Provider: service.MockProvider{}}
	for range jobIDs {
		if ok, err := runner.ProcessOne(context.Background()); err != nil || !ok {
			t.Fatalf("process: ok=%v err=%v", ok, err)
		}
	}
	return e, s, skuIDs, jobIDs
}

// TestBatchReview 批量审核：全部通过后各自成为当前版本，非法 ID 逐条报错不影响整体。
func TestBatchReview(t *testing.T) {
	e, s, _, jobIDs := batchFixture(t)

	code, out := e.do(t, http.MethodPost, "/v1/w/"+s.Slug+"/jobs/review-batch", s.Access, map[string]any{
		"ids":    append(jobIDs, "00000000-0000-0000-0000-000000000000"),
		"status": "approved",
	})
	if code != http.StatusOK {
		t.Fatalf("batch review: %d %v", code, out)
	}
	if got := fmt.Sprint(out["success"]); got != "2" {
		t.Fatalf("success = %s, want 2 (%v)", got, out)
	}
	for _, id := range jobIDs {
		var job model.GenerationJob
		if err := e.db.First(&job, "id = ?", id).Error; err != nil {
			t.Fatalf("job %s: %v", id, err)
		}
		if job.ReviewStatus != "approved" {
			t.Fatalf("job %s review = %s", id, job.ReviewStatus)
		}
	}
	var current int64
	e.db.Model(&model.VersionMark{}).Where("workspace_id = ? AND is_current = ?", s.WSID, true).Count(&current)
	if current != 2 {
		t.Fatalf("current versions = %d, want 2", current)
	}

	// 驳回缺原因必须整体 400。
	code, _ = e.do(t, http.MethodPost, "/v1/w/"+s.Slug+"/jobs/review-batch", s.Access, map[string]any{
		"ids": jobIDs, "status": "rejected",
	})
	if code != http.StatusBadRequest {
		t.Fatalf("reject without reason should 400, got %d", code)
	}
}

// TestBatchExport 批量导出：ZIP 同时包含两个 SKU 的当前版本，按 SKU 数扣额度。
func TestBatchExport(t *testing.T) {
	e, s, skuIDs, jobIDs := batchFixture(t)
	code, out := e.do(t, http.MethodPost, "/v1/w/"+s.Slug+"/jobs/review-batch", s.Access, map[string]any{
		"ids": jobIDs, "status": "approved",
	})
	if code != http.StatusOK {
		t.Fatalf("approve: %d %v", code, out)
	}

	req, _ := http.NewRequest(http.MethodPost, e.srv.URL+"/v1/w/"+s.Slug+"/exports/batch",
		strings.NewReader(fmt.Sprintf(`{"sku_ids":["%s","%s"]}`, skuIDs[0], skuIDs[1])))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+s.Access)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(res.Body)
		t.Fatalf("batch export status %d: %s", res.StatusCode, body)
	}
	data, _ := io.ReadAll(res.Body)
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("zip: %v", err)
	}
	dirs := map[string]int{}
	for _, f := range zr.File {
		dirs[strings.SplitN(f.Name, "/", 2)[0]]++
	}
	if len(dirs) != 2 {
		t.Fatalf("zip should contain 2 sku dirs, got %v", dirs)
	}
	var ws model.Workspace
	e.db.First(&ws, "id = ?", s.WSID)
	if ws.ExportUsed != 2 {
		t.Fatalf("export_used = %d, want 2", ws.ExportUsed)
	}
}

// TestCompareVersions 版本对比接口返回两侧任务与素材元数据。
func TestCompareVersions(t *testing.T) {
	e, s, skuIDs, jobIDs := batchFixture(t)
	code, out := e.do(t, http.MethodGet,
		"/v1/w/"+s.Slug+"/skus/"+skuIDs[0]+"/compare?left="+jobIDs[0]+"&right="+jobIDs[1], s.Access, nil)
	if code != http.StatusNotFound {
		t.Fatalf("cross-sku compare should 404, got %d %v", code, out)
	}

	// 同一 SKU 再跑一个任务，取两个版本对比。
	code, out = e.do(t, http.MethodPost, "/v1/w/"+s.Slug+"/jobs", s.Access, map[string]any{
		"sku_id": skuIDs[0], "template": "main", "idempotency_key": "cmp-2",
	})
	if code != http.StatusCreated {
		t.Fatalf("create job: %d %v", code, out)
	}
	third := fmt.Sprint(out["id"])
	store, _ := storage.NewLocal(e.cfg.StorageDir)
	runner := &service.Runner{DB: e.db, Store: store, Provider: service.MockProvider{}}
	if ok, err := runner.ProcessOne(context.Background()); err != nil || !ok {
		t.Fatalf("process: ok=%v err=%v", ok, err)
	}
	code, out = e.do(t, http.MethodGet,
		"/v1/w/"+s.Slug+"/skus/"+skuIDs[0]+"/compare?left="+jobIDs[0]+"&right="+third, s.Access, nil)
	if code != http.StatusOK {
		t.Fatalf("compare: %d %v", code, out)
	}
	left, _ := out["left"].(map[string]any)
	right, _ := out["right"].(map[string]any)
	if left["asset"] == nil || right["asset"] == nil {
		t.Fatalf("both sides need asset metadata: %v", out)
	}
}

// TestPresignAndComplete 本地存储下预签名退化为服务端上传，直传登记后可读回素材。
func TestPresignAndComplete(t *testing.T) {
	e, s, skuIDs, _ := batchFixture(t)

	code, out := e.do(t, http.MethodGet, "/v1/w/"+s.Slug+"/skus/"+skuIDs[0]+"/presign", s.Access, nil)
	if code != http.StatusOK {
		t.Fatalf("presign: %d %v", code, out)
	}
	if out["direct"] != false {
		t.Fatalf("local storage should not offer direct upload: %v", out)
	}

	// 模拟客户端已把对象放进存储，再登记。
	var sku model.SKU
	e.db.First(&sku, "id = ? AND workspace_id = ?", skuIDs[0], s.WSID)
	store, _ := storage.NewLocal(e.cfg.StorageDir)
	key := fmt.Sprintf("ws/%s/sku/%s/src/direct-test.png", s.WSID, sku.Code)
	if _, err := store.Save(context.Background(), key, bytes.NewReader(pngBytes(t, 40, 30))); err != nil {
		t.Fatalf("seed object: %v", err)
	}
	code, out = e.do(t, http.MethodPost,
		"/v1/w/"+s.Slug+"/skus/"+skuIDs[0]+"/assets/complete", s.Access, map[string]any{"key": key})
	if code != http.StatusCreated {
		t.Fatalf("complete: %d %v", code, out)
	}
	if fmt.Sprint(out["width"]) != "40" || fmt.Sprint(out["height"]) != "30" {
		t.Fatalf("asset size wrong: %v", out)
	}
	if out["hash"] == "" || out["hash"] == nil {
		t.Fatalf("hash should be computed: %v", out)
	}

	// 越权路径（别的租户前缀）必须 400。
	code, _ = e.do(t, http.MethodPost,
		"/v1/w/"+s.Slug+"/skus/"+skuIDs[0]+"/assets/complete", s.Access,
		map[string]any{"key": "ws/other/sku/BAT-1/src/x.png"})
	if code != http.StatusBadRequest {
		t.Fatalf("foreign key should 400, got %d", code)
	}
}
