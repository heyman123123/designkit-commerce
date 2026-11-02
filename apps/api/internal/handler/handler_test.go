package handler_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/heyman123123/designkit-commerce/apps/api/internal/auth"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/config"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/handler"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/model"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/platform"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/service"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/storage"
	"gorm.io/gorm"
)

type env struct {
	srv *httptest.Server
	db  *gorm.DB
	cfg config.Config
	dir string
}

func newEnv(t *testing.T) *env {
	t.Helper()
	return newEnvWith(t, nil)
}

// newEnvWith 在构造路由前允许改写配置，用于需要密钥等配置的用例。
func newEnvWith(t *testing.T, mutate func(*config.Config)) *env {
	t.Helper()
	dsn := fmt.Sprintf("file:test-%s?mode=memory&cache=shared", fmt.Sprint(time.Now().UnixNano()))
	cfg := config.Config{
		Addr:        ":0",
		DBDriver:    "sqlite",
		DSN:         dsn,
		JWTSecret:   "test-secret",
		AccessTTL:   time.Hour,
		RefreshTTL:  time.Hour,
		StorageDir:  t.TempDir(),
		AutoMigrate: true,
		Env:         "test",
		MaxUploadMB: 10,
	}
	if mutate != nil {
		mutate(&cfg)
	}
	db, err := platform.Open(cfg)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	store, err := storage.NewLocal(cfg.StorageDir)
	if err != nil {
		t.Fatalf("storage: %v", err)
	}
	router := handler.NewRouter(handler.Deps{
		DB: db, Cfg: cfg, JWT: auth.NewManager(cfg.JWTSecret, cfg.AccessTTL),
		Store: store, Provider: service.MockProvider{},
	})
	srv := httptest.NewServer(router)
	t.Cleanup(func() {
		srv.Close()
		_ = os.RemoveAll(cfg.StorageDir)
	})
	return &env{srv: srv, db: db, cfg: cfg, dir: cfg.StorageDir}
}

func (e *env) do(t *testing.T, method, path, token string, body any) (int, map[string]any) {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, e.srv.URL+path, rdr)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer res.Body.Close()
	out := map[string]any{}
	if ct := res.Header.Get("Content-Type"); ct == "application/json; charset=utf-8" {
		_ = json.NewDecoder(res.Body).Decode(&out)
	}
	return res.StatusCode, out
}

type session struct {
	Access string
	Slug   string
	WSID   string
}

func register(t *testing.T, e *env, email, wsName string) session {
	t.Helper()
	code, out := e.do(t, http.MethodPost, "/v1/auth/register", "", map[string]any{
		"email": email, "password": "password123", "name": email, "workspace_name": wsName,
	})
	if code != http.StatusOK {
		t.Fatalf("register %s: status %d body %v", email, code, out)
	}
	access, _ := out["access_token"].(string)
	ws, _ := out["workspace"].(map[string]any)
	if access == "" || ws == nil {
		t.Fatalf("register response incomplete: %v", out)
	}
	return session{Access: access, Slug: fmt.Sprint(ws["slug"]), WSID: fmt.Sprint(ws["id"])}
}

func TestCrossTenantIsolation(t *testing.T) {
	e := newEnv(t)
	alice := register(t, e, "alice@example.com", "Acme Home")
	bob := register(t, e, "bob@example.com", "Nordic Pet")

	if alice.Slug == bob.Slug {
		t.Fatalf("workspace slug collision: %s", alice.Slug)
	}

	// Alice 建项目与 SKU
	code, proj := e.do(t, http.MethodPost, "/v1/w/"+alice.Slug+"/projects", alice.Access, map[string]any{
		"name": "Kitchen", "platform": "amazon", "category": "home",
	})
	if code != http.StatusCreated {
		t.Fatalf("create project: %d %v", code, proj)
	}
	projectID := fmt.Sprint(proj["id"])
	code, sku := e.do(t, http.MethodPost, "/v1/w/"+alice.Slug+"/skus", alice.Access, map[string]any{
		"project_id": projectID, "code": "ORG-001", "title": "Organizer",
	})
	if code != http.StatusCreated {
		t.Fatalf("create sku: %d %v", code, sku)
	}

	// Bob 用自己令牌访问 Alice 的租户：必须 404，且不暴露存在性
	for _, path := range []string{"/projects", "/skus", "/jobs", "/assets", "/usage", "/members"} {
		code, body := e.do(t, http.MethodGet, "/v1/w/"+alice.Slug+path, bob.Access, nil)
		if code != http.StatusNotFound {
			t.Fatalf("cross-tenant %s expected 404, got %d %v", path, code, body)
		}
	}

	// Bob 无法切换到 Alice 的工作区
	code, _ = e.do(t, http.MethodPost, "/v1/workspaces/"+alice.WSID+"/switch", bob.Access, nil)
	if code != http.StatusNotFound {
		t.Fatalf("switch into foreign workspace expected 404, got %d", code)
	}

	// Alice 自己访问正常
	code, body := e.do(t, http.MethodGet, "/v1/w/"+alice.Slug+"/projects", alice.Access, nil)
	if code != http.StatusOK {
		t.Fatalf("owner list projects: %d %v", code, body)
	}
	items, _ := body["items"].([]any)
	if len(items) < 2 {
		t.Fatalf("expected default + created project, got %d", len(items))
	}

	// Bob 不能通过 ID 读取 Alice 的资产内容
	var asset model.Asset
	e.db.Where("workspace_id = ?", alice.WSID).First(&asset)
	code, _ = e.do(t, http.MethodGet, "/v1/w/"+bob.Slug+"/assets/"+asset.ID.String()+"/content", bob.Access, nil)
	if code != http.StatusNotFound {
		t.Fatalf("cross-tenant asset read expected 404, got %d", code)
	}
}

func TestQuotaAndIdempotency(t *testing.T) {
	e := newEnv(t)
	alice := register(t, e, "quota@example.com", "Quota Shop")

	_, proj := e.do(t, http.MethodPost, "/v1/w/"+alice.Slug+"/projects", alice.Access, map[string]any{"name": "P1"})
	projectID := fmt.Sprint(proj["id"])

	// Free 配额 1 个 SKU
	code, _ := e.do(t, http.MethodPost, "/v1/w/"+alice.Slug+"/skus", alice.Access, map[string]any{
		"project_id": projectID, "code": "Q-001",
	})
	if code != http.StatusCreated {
		t.Fatalf("first sku should succeed, got %d", code)
	}
	code, body := e.do(t, http.MethodPost, "/v1/w/"+alice.Slug+"/skus", alice.Access, map[string]any{
		"project_id": projectID, "code": "Q-002",
	})
	if code != http.StatusPaymentRequired {
		t.Fatalf("second sku should be blocked by quota, got %d %v", code, body)
	}

	var sku model.SKU
	e.db.Where("workspace_id = ? AND code = ?", alice.WSID, "Q-001").First(&sku)

	// 同幂等键重复提交只产生一个任务
	code, first := e.do(t, http.MethodPost, "/v1/w/"+alice.Slug+"/jobs", alice.Access, map[string]any{
		"sku_id": sku.ID.String(), "template": "main", "idempotency_key": "order-42",
	})
	if code != http.StatusCreated {
		t.Fatalf("create job: %d %v", code, first)
	}
	code, second := e.do(t, http.MethodPost, "/v1/w/"+alice.Slug+"/jobs", alice.Access, map[string]any{
		"sku_id": sku.ID.String(), "template": "main", "idempotency_key": "order-42",
	})
	if code != http.StatusOK {
		t.Fatalf("duplicate should return existing job, got %d %v", code, second)
	}
	if fmt.Sprint(first["id"]) != fmt.Sprint(second["id"]) {
		t.Fatalf("idempotency violated: %v vs %v", first["id"], second["id"])
	}
	var count int64
	e.db.Model(&model.GenerationJob{}).Where("workspace_id = ?", alice.WSID).Count(&count)
	if count != 1 {
		t.Fatalf("expected 1 job, got %d", count)
	}
}

func TestAdminIsolation(t *testing.T) {
	e := newEnv(t)

	// 普通用户不能登录后台
	register(t, e, "user@example.com", "User Shop")
	code, _ := e.do(t, http.MethodPost, "/v1/admin/auth/login", "", map[string]any{
		"email": "user@example.com", "password": "password123",
	})
	if code != http.StatusForbidden {
		t.Fatalf("non-admin admin login expected 403, got %d", code)
	}

	// 建立平台管理员
	hash, err := auth.HashPassword("adminpass123")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	admin := model.User{Email: "admin@example.com", PasswordHash: hash, Name: "Admin", IsPlatformAdmin: true}
	if err := e.db.Create(&admin).Error; err != nil {
		t.Fatalf("create admin: %v", err)
	}

	code, out := e.do(t, http.MethodPost, "/v1/admin/auth/login", "", map[string]any{
		"email": "admin@example.com", "password": "adminpass123",
	})
	if code != http.StatusOK {
		t.Fatalf("admin login: %d %v", code, out)
	}
	adminToken, _ := out["access_token"].(string)

	code, tenants := e.do(t, http.MethodGet, "/v1/admin/tenants", adminToken, nil)
	if code != http.StatusOK {
		t.Fatalf("admin tenants: %d %v", code, tenants)
	}

	// 租户令牌不能访问后台
	user := register(t, e, "user2@example.com", "Other Shop")
	code, _ = e.do(t, http.MethodGet, "/v1/admin/tenants", user.Access, nil)
	if code != http.StatusForbidden && code != http.StatusUnauthorized {
		t.Fatalf("tenant token on admin api expected 401/403, got %d", code)
	}
}
