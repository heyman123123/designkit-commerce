package handler_test

import (
	"net/http"
	"testing"

	"github.com/heyman123123/designkit-commerce/apps/api/internal/auth"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/handler"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/model"
)

func adminToken(t *testing.T, e *env) string {
	t.Helper()
	hash, err := auth.HashPassword("adminpass123")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	admin := model.User{Email: "ops@example.com", PasswordHash: hash, Name: "Ops", IsPlatformAdmin: true}
	if err := e.db.Create(&admin).Error; err != nil {
		t.Fatalf("create admin: %v", err)
	}
	if err := handler.SeedPlatform(e.db); err != nil {
		t.Fatalf("seed platform: %v", err)
	}
	code, out := e.do(t, http.MethodPost, "/v1/admin/auth/login", "", map[string]any{
		"email": "ops@example.com", "password": "adminpass123",
	})
	if code != http.StatusOK {
		t.Fatalf("admin login: %d %v", code, out)
	}
	return out["access_token"].(string)
}

// TestAdminPlatformOps 覆盖：套餐种子、开通订单、套用配额、风控冻结、成本看板与配置开关。
func TestAdminPlatformOps(t *testing.T) {
	e := newEnv(t)
	tok := adminToken(t, e)

	code, out := e.do(t, http.MethodGet, "/v1/admin/plans", tok, nil)
	if code != http.StatusOK {
		t.Fatalf("plans: %d %v", code, out)
	}
	if len(out["items"].([]any)) < 4 {
		t.Fatalf("expected seeded plans, got %v", out["items"])
	}

	shop := register(t, e, "shop@example.com", "Ops Shop")

	code, out = e.do(t, http.MethodPost, "/v1/admin/orders", tok, map[string]any{
		"workspace_id": shop.WSID, "plan_code": "starter", "amount_cents": 2900,
	})
	if code != http.StatusCreated {
		t.Fatalf("create order: %d %v", code, out)
	}

	code, out = e.do(t, http.MethodGet, "/v1/admin/tenants/"+shop.WSID, tok, nil)
	if code != http.StatusOK {
		t.Fatalf("tenant: %d %v", code, out)
	}
	ws := out["workspace"].(map[string]any)
	if ws["plan"] != "starter" || int(ws["sku_quota"].(float64)) != 20 {
		t.Fatalf("plan not applied: %v", ws)
	}

	code, out = e.do(t, http.MethodPost, "/v1/admin/risk", tok, map[string]any{
		"workspace_id": shop.WSID, "kind": "complaint", "severity": "high", "detail": "买家投诉图片与实物差异大",
	})
	if code != http.StatusCreated {
		t.Fatalf("risk create: %d %v", code, out)
	}
	riskID := out["id"].(string)

	code, out = e.do(t, http.MethodPost, "/v1/admin/risk/"+riskID+"/resolve", tok, map[string]any{
		"resolution": "已核实并下架素材", "freeze": true,
	})
	if code != http.StatusOK {
		t.Fatalf("risk resolve: %d %v", code, out)
	}
	code, out = e.do(t, http.MethodGet, "/v1/admin/tenants/"+shop.WSID, tok, nil)
	if ws := out["workspace"].(map[string]any); ws["status"] != "suspended" {
		t.Fatalf("tenant should be suspended, got %v", ws["status"])
	}

	code, out = e.do(t, http.MethodPost, "/v1/admin/coupons", tok, map[string]any{
		"code": "launch10", "percent_off": 10, "max_redemptions": 50,
	})
	if code != http.StatusOK {
		t.Fatalf("coupon: %d %v", code, out)
	}

	code, out = e.do(t, http.MethodPatch, "/v1/admin/config/flags/auto_qc", tok, map[string]any{"enabled": false})
	if code != http.StatusOK {
		t.Fatalf("flag: %d %v", code, out)
	}
	code, out = e.do(t, http.MethodGet, "/v1/admin/config/flags", tok, nil)
	flags := out["items"].([]any)
	found := false
	for _, f := range flags {
		m := f.(map[string]any)
		if m["key"] == "auto_qc" {
			found = true
			if m["enabled"] != false {
				t.Fatalf("flag should be disabled: %v", m)
			}
		}
	}
	if !found {
		t.Fatalf("auto_qc flag missing")
	}

	code, out = e.do(t, http.MethodPatch, "/v1/admin/config/templates/main", tok, map[string]any{"name": "主图 A"})
	if code != http.StatusOK {
		t.Fatalf("template: %d %v", code, out)
	}

	code, out = e.do(t, http.MethodGet, "/v1/admin/costs?days=7", tok, nil)
	if code != http.StatusOK {
		t.Fatalf("costs: %d %v", code, out)
	}
	if _, ok := out["by_day"]; !ok {
		t.Fatalf("costs missing by_day: %v", out)
	}

	code, out = e.do(t, http.MethodGet, "/v1/admin/overview", tok, nil)
	if code != http.StatusOK {
		t.Fatalf("overview: %d %v", code, out)
	}
	if out["tenants"] == nil {
		t.Fatalf("overview missing tenants: %v", out)
	}
}
