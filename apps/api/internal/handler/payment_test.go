package handler_test

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/heyman123123/designkit-commerce/apps/api/internal/config"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/model"
)

// sign 生成回调签名。
func sign(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// TestPaymentWebhook 支付回调：签名校验、幂等、配额开通。
func TestPaymentWebhook(t *testing.T) {
	env2 := newEnvWith(t, func(cfg *config.Config) {
		cfg.PaymentWebhookSecret = "whsec_test"
	})

	s := register(t, env2, "pay@example.com", "Pay Lab")
	admin := adminToken(t, env2)
	var ws model.Workspace
	env2.db.First(&ws, "id = ?", s.WSID)

	code, order := env2.do(t, http.MethodPost, "/v1/admin/orders", admin, map[string]any{
		"workspace_id": ws.ID.String(), "plan_code": "growth", "amount_cents": 9900, "status": "pending",
	})
	if code != http.StatusCreated {
		t.Fatalf("create pending order: %d %v", code, order)
	}
	orderID := fmt.Sprint(order["id"])

	payload, _ := json.Marshal(map[string]any{
		"order_id": orderID, "status": "paid", "amount_cents": 9900, "provider_txn_id": "pi_123",
	})

	// 无签名：401
	req, _ := http.NewRequest(http.MethodPost, env2.srv.URL+"/v1/webhooks/payments/stripe", bytes.NewReader(payload))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("webhook: %v", err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unsigned webhook = %d, want 401", res.StatusCode)
	}

	post := func(body []byte, secret string) (int, map[string]any) {
		req, _ := http.NewRequest(http.MethodPost, env2.srv.URL+"/v1/webhooks/payments/stripe", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Payment-Signature", sign(secret, body))
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("webhook: %v", err)
		}
		defer res.Body.Close()
		out := map[string]any{}
		_ = json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}

	if code, out := post(payload, "wrong"); code != http.StatusUnauthorized {
		t.Fatalf("bad signature = %d %v", code, out)
	}
	code, out := post(payload, "whsec_test")
	if code != http.StatusOK {
		t.Fatalf("paid webhook = %d %v", code, out)
	}
	var got model.Order
	env2.db.First(&got, "id = ?", orderID)
	if got.Status != "paid" || got.PaidAt == nil {
		t.Fatalf("order not paid: %+v", got)
	}
	var after model.Workspace
	env2.db.First(&after, "id = ?", s.WSID)
	if after.Plan != "growth" || after.SkuQuota != 100 {
		t.Fatalf("plan not applied: plan=%s quota=%d", after.Plan, after.SkuQuota)
	}

	// 重复回调：幂等确认，不重复开通。
	code, out = post(payload, "whsec_test")
	if code != http.StatusOK || out["already_paid"] != true {
		t.Fatalf("replay = %d %v", code, out)
	}

	// 已支付订单不能作废。
	voidBody, _ := json.Marshal(map[string]any{"order_id": orderID, "status": "void"})
	if code, _ := post(voidBody, "whsec_test"); code != http.StatusConflict {
		t.Fatalf("void paid order = %d, want 409", code)
	}
}

// TestAdminMarkOrderPaid 人工到账确认。
func TestAdminMarkOrderPaid(t *testing.T) {
	e := newEnv(t)
	s := register(t, e, "mark@example.com", "Mark Lab")
	admin := adminToken(t, e)
	var ws model.Workspace
	e.db.First(&ws, "id = ?", s.WSID)
	code, order := e.do(t, http.MethodPost, "/v1/admin/orders", admin, map[string]any{
		"workspace_id": ws.ID.String(), "plan_code": "pro", "amount_cents": 29900, "status": "pending",
	})
	if code != http.StatusCreated {
		t.Fatalf("order: %d %v", code, order)
	}
	code, out := e.do(t, http.MethodPost, fmt.Sprintf("/v1/admin/orders/%v/paid", order["id"]), admin, map[string]any{
		"note": "银行转账已到账",
	})
	if code != http.StatusOK {
		t.Fatalf("mark paid: %d %v", code, out)
	}
	var after model.Workspace
	e.db.First(&after, "id = ?", s.WSID)
	if after.Plan != "pro" || after.SkuQuota != 500 {
		t.Fatalf("quota not applied: %s/%d", after.Plan, after.SkuQuota)
	}
	// 二次确认应 409。
	code, _ = e.do(t, http.MethodPost, fmt.Sprintf("/v1/admin/orders/%v/paid", order["id"]), admin, map[string]any{})
	if code != http.StatusConflict {
		t.Fatalf("second mark paid = %d, want 409", code)
	}
}
