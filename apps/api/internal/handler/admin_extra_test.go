package handler_test

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/heyman123123/designkit-commerce/apps/api/internal/model"
)

// TestAdminAuditFiltersAndMembers 校验审计筛选分页与租户成员接口。
func TestAdminAuditFiltersAndMembers(t *testing.T) {
	e := newEnv(t)
	s := register(t, e, "audit@example.com", "Audit Lab")
	tok := adminToken(t, e)

	var ws model.Workspace
	e.db.First(&ws, "id = ?", s.WSID)

	// 触发一条后台审计记录。
	code, out := e.do(t, http.MethodPatch, "/v1/admin/tenants/"+ws.ID.String(), tok, map[string]any{
		"name": "Audit Lab Renamed",
	})
	if code != http.StatusOK {
		t.Fatalf("patch tenant: %d %v", code, out)
	}

	code, page := e.do(t, http.MethodGet,
		"/v1/admin/audit?action=admin.tenant.update&page=1&size=1", tok, nil)
	if code != http.StatusOK {
		t.Fatalf("audit filtered: %d %v", code, page)
	}
	if total := int(page["total"].(float64)); total < 1 {
		t.Fatalf("filtered audit total = %d, want >= 1", total)
	}
	if got := len(page["items"].([]any)); got > 1 {
		t.Fatalf("size=1 returned %d items", got)
	}

	// 未过滤接口仍返回 items/total，兼容旧前端。
	code, all := e.do(t, http.MethodGet, "/v1/admin/audit?size=5", tok, nil)
	if code != http.StatusOK || all["items"] == nil || all["total"] == nil {
		t.Fatalf("audit all: %d %v", code, all)
	}

	code, mem := e.do(t, http.MethodGet, "/v1/admin/tenants/"+ws.ID.String()+"/members", tok, nil)
	if code != http.StatusOK {
		t.Fatalf("members: %d %v", code, mem)
	}
	items := mem["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("members = %d, want 1", len(items))
	}
	owner := items[0].(map[string]any)
	if owner["email"] != "audit@example.com" || owner["role"] != "owner" {
		t.Fatalf("owner row = %v", owner)
	}

	// 租户令牌不能访问后台成员接口。
	code, _ = e.do(t, http.MethodGet, "/v1/admin/tenants/"+ws.ID.String()+"/members", s.Access, nil)
	if code != http.StatusUnauthorized && code != http.StatusForbidden {
		t.Fatalf("tenant token on admin endpoint = %d", code)
	}
}

// TestAdminTenantsPagination 租户列表支持分页并返回真实总数。
func TestAdminTenantsPagination(t *testing.T) {
	e := newEnv(t)
	tok := adminToken(t, e)
	for i := 0; i < 3; i++ {
		register(t, e, fmt.Sprintf("page%d@example.com", i), fmt.Sprintf("Page Lab %d", i))
	}

	code, out := e.do(t, http.MethodGet, "/v1/admin/tenants?page=1&size=2", tok, nil)
	if code != http.StatusOK {
		t.Fatalf("page1: %d %v", code, out)
	}
	if total := int(out["total"].(float64)); total < 3 {
		t.Fatalf("total = %d, want >= 3", total)
	}
	if got := len(out["items"].([]any)); got != 2 {
		t.Fatalf("page1 items = %d, want 2", got)
	}

	code, out = e.do(t, http.MethodGet, "/v1/admin/tenants?page=2&size=2", tok, nil)
	if code != http.StatusOK {
		t.Fatalf("page2: %d %v", code, out)
	}
	if got := len(out["items"].([]any)); got < 1 {
		t.Fatalf("page2 items = %d, want >= 1", got)
	}

	// 状态筛选仍生效。
	code, out = e.do(t, http.MethodGet, "/v1/admin/tenants?status=suspended&size=5", tok, nil)
	if code != http.StatusOK || len(out["items"].([]any)) != 0 {
		t.Fatalf("suspended filter: %d %v", code, out)
	}
}
