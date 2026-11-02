package handler_test

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"testing"

	"github.com/heyman123123/designkit-commerce/apps/api/internal/service"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/storage"
)

// TestVersionChain 覆盖：多版本生成 → 审核通过自动设当前版本 → 手工回滚 → 导出只含当前版本。
func TestVersionChain(t *testing.T) {
	e := newEnv(t)
	s := register(t, e, "version@example.com", "Version Lab")

	code, out := e.do(t, http.MethodGet, "/v1/w/"+s.Slug+"/projects", s.Access, nil)
	if code != http.StatusOK {
		t.Fatalf("projects: %d %v", code, out)
	}
	projects := out["items"].([]any)
	pid := fmt.Sprint(projects[0].(map[string]any)["id"])

	code, out = e.do(t, http.MethodPost, "/v1/w/"+s.Slug+"/skus", s.Access, map[string]any{
		"project_id": pid, "code": "VER-1", "title": "Version Test",
	})
	if code != http.StatusCreated {
		t.Fatalf("create sku: %d %v", code, out)
	}
	skuID := fmt.Sprint(out["id"])

	var jobIDs []string
	for i := 0; i < 2; i++ {
		code, out = e.do(t, http.MethodPost, "/v1/w/"+s.Slug+"/jobs", s.Access, map[string]any{
			"sku_id": skuID, "template": "main", "idempotency_key": fmt.Sprintf("ver-%d", i),
		})
		if code != http.StatusCreated {
			t.Fatalf("create job %d: %d %v", i, code, out)
		}
		jobIDs = append(jobIDs, fmt.Sprint(out["id"]))
	}

	store, err := storage.NewLocal(e.cfg.StorageDir)
	if err != nil {
		t.Fatalf("storage: %v", err)
	}
	runner := &service.Runner{DB: e.db, Store: store, Provider: service.MockProvider{}}
	for i := 0; i < 2; i++ {
		ok, err := runner.ProcessOne(context.Background())
		if err != nil || !ok {
			t.Fatalf("process one: ok=%v err=%v", ok, err)
		}
	}

	// 依次通过审核，后通过的成为当前版本。
	for _, id := range jobIDs {
		code, out = e.do(t, http.MethodPost, "/v1/w/"+s.Slug+"/jobs/"+id+"/review", s.Access, map[string]any{"status": "approved"})
		if code != http.StatusOK {
			t.Fatalf("approve %s: %d %v", id, code, out)
		}
	}

	code, out = e.do(t, http.MethodGet, "/v1/w/"+s.Slug+"/skus/"+skuID+"/versions", s.Access, nil)
	if code != http.StatusOK {
		t.Fatalf("versions: %d %v", code, out)
	}
	items := out["items"].([]any)
	if len(items) != 2 {
		t.Fatalf("want 2 versions, got %d", len(items))
	}
	current := ""
	for _, it := range items {
		m := it.(map[string]any)
		if m["is_current"] == true {
			current = fmt.Sprint(m["job_id"])
		}
	}
	if current != jobIDs[1] {
		t.Fatalf("current version = %q, want newest %q", current, jobIDs[1])
	}

	// 回滚到第一版
	code, out = e.do(t, http.MethodPost, "/v1/w/"+s.Slug+"/skus/"+skuID+"/versions/"+jobIDs[0]+"/current", s.Access, map[string]any{})
	if code != http.StatusOK {
		t.Fatalf("promote: %d %v", code, out)
	}
	code, out = e.do(t, http.MethodGet, "/v1/w/"+s.Slug+"/skus/"+skuID+"/versions", s.Access, nil)
	if code != http.StatusOK {
		t.Fatalf("versions2: %d %v", code, out)
	}
	current = ""
	for _, it := range out["items"].([]any) {
		m := it.(map[string]any)
		if m["is_current"] == true {
			current = fmt.Sprint(m["job_id"])
		}
	}
	if current != jobIDs[0] {
		t.Fatalf("rollback current = %q, want %q", current, jobIDs[0])
	}

	// 导出只包含当前版本（1 个文件）
	req, _ := http.NewRequest(http.MethodGet, e.srv.URL+"/v1/w/"+s.Slug+"/skus/"+skuID+"/export", nil)
	req.Header.Set("Authorization", "Bearer "+s.Access)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("export status %d", res.StatusCode)
	}
	raw, _ := io.ReadAll(res.Body)
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatalf("zip: %v", err)
	}
	if len(zr.File) != 1 {
		t.Fatalf("export should contain only current version, got %d files", len(zr.File))
	}
}
