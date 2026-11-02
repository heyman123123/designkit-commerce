package handler

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/httpx"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/model"
	"gorm.io/gorm"
)

// paymentProviders 允许的回调渠道名，仅用于订单渠道标记与审计。
var paymentProviders = map[string]bool{
	"stripe": true, "alipay": true, "wechat": true, "generic": true,
}

// paymentWebhookBody 外部支付平台的回调体（统一契约，由我方适配层转换）。
type paymentWebhookBody struct {
	OrderID       string `json:"order_id"`
	Status        string `json:"status"`
	AmountCents   int    `json:"amount_cents"`
	ProviderTxnID string `json:"provider_txn_id"`
	Note          string `json:"note"`
}

// PaymentWebhook 接收支付平台回调：HMAC-SHA256 校验后把订单状态推进。
func (h *Handler) PaymentWebhook(w http.ResponseWriter, r *http.Request) {
	provider := strings.ToLower(chi.URLParam(r, "provider"))
	if !paymentProviders[provider] {
		httpx.Err(w, http.StatusNotFound, "unknown_provider", "未知的支付渠道")
		return
	}
	secret := strings.TrimSpace(h.Cfg.PaymentWebhookSecret)
	if secret == "" {
		httpx.Err(w, http.StatusServiceUnavailable, "webhook_disabled", "未配置支付回调密钥，回调接口未启用")
		return
	}

	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		badRequest(w, "读取回调内容失败")
		return
	}
	signature := strings.TrimSpace(r.Header.Get("X-Payment-Signature"))
	if !validHMAC(secret, raw, signature) {
		httpx.Err(w, http.StatusUnauthorized, "bad_signature", "回调签名校验失败")
		return
	}

	var body paymentWebhookBody
	if err := json.Unmarshal(raw, &body); err != nil {
		badRequest(w, "回调内容格式不正确")
		return
	}
	orderID, err := uuid.Parse(strings.TrimSpace(body.OrderID))
	if err != nil {
		badRequest(w, "订单 ID 无效")
		return
	}
	switch body.Status {
	case "paid", "void", "refunded":
	default:
		badRequest(w, "回调状态不合法")
		return
	}

	var order model.Order
	if err := h.DB.First(&order, "id = ?", orderID).Error; err != nil {
		httpx.Err(w, http.StatusNotFound, "not_found", "订单不存在")
		return
	}
	if body.Status == "paid" && order.Status == "paid" {
		// 平台会重试回调，重复通知直接确认，不重复开通。
		httpx.JSON(w, http.StatusOK, map[string]any{
			"order_id": order.ID, "status": order.Status, "already_paid": true,
		})
		return
	}
	if err := h.transitionOrder(order, body, provider); err != nil {
		httpx.Err(w, http.StatusConflict, "invalid_transition", err.Error())
		return
	}
	h.audit(r, "payment."+provider+"."+body.Status, order.ID.String(), body.ProviderTxnID)
	httpx.JSON(w, http.StatusOK, map[string]any{
		"order_id": order.ID, "status": body.Status, "already_paid": false,
	})
}

// transitionOrder 在事务里推进订单状态；paid 时同步套用套餐配额。
func (h *Handler) transitionOrder(order model.Order, body paymentWebhookBody, provider string) error {
	return h.DB.Transaction(func(tx *gorm.DB) error {
		switch body.Status {
		case "paid":
			if order.Status != "pending" {
				return fmt.Errorf("订单当前状态为 %s，不能标记为已支付", order.Status)
			}
			now := time.Now()
			updates := map[string]any{
				"status": "paid", "paid_at": &now, "channel": provider,
				"amount_cents": body.AmountCents,
			}
			if body.Note != "" {
				updates["note"] = body.Note
			}
			if err := tx.Model(&model.Order{}).Where("id = ?", order.ID).Updates(updates).Error; err != nil {
				return err
			}
			return applyPlanQuota(tx, order.WorkspaceID, order.PlanCode)
		case "void":
			if order.Status != "pending" {
				return fmt.Errorf("只有待支付订单可以作废，当前为 %s", order.Status)
			}
			return tx.Model(&model.Order{}).Where("id = ?", order.ID).Update("status", "void").Error
		case "refunded":
			if order.Status != "paid" {
				return fmt.Errorf("只有已支付订单可以退款，当前为 %s", order.Status)
			}
			return tx.Model(&model.Order{}).Where("id = ?", order.ID).Update("status", "refunded").Error
		}
		return nil
	})
}

// applyPlanQuota 按套餐开通配额；套餐不存在时保留订单但不改配额。
func applyPlanQuota(tx *gorm.DB, workspaceID uuid.UUID, planCode string) error {
	var plan model.Plan
	if err := tx.First(&plan, "code = ?", planCode).Error; err != nil {
		return nil
	}
	return tx.Model(&model.Workspace{}).Where("id = ?", workspaceID).Updates(map[string]any{
		"plan": plan.Code, "sku_quota": plan.SkuQuota, "export_quota": plan.ExportQuota,
	}).Error
}

// validHMAC 校验 hex(HMAC-SHA256(secret, body))。
func validHMAC(secret string, body []byte, signature string) bool {
	if signature == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	want := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(strings.ToLower(signature)), []byte(want))
}

// AdminMarkOrderPaid 人工确认到账（银行转账、线下收款），等价于支付回调的 paid。
func (h *Handler) AdminMarkOrderPaid(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "orderID")
	if !ok {
		badRequest(w, "订单 ID 无效")
		return
	}
	var req struct {
		AmountCents int    `json:"amount_cents"`
		Note        string `json:"note"`
	}
	if r.ContentLength > 0 {
		if err := httpx.Decode(r, &req); err != nil {
			badRequest(w, "请求体格式不正确")
			return
		}
	}
	var order model.Order
	if err := h.DB.First(&order, "id = ?", id).Error; err != nil {
		httpx.Err(w, http.StatusNotFound, "not_found", "订单不存在")
		return
	}
	amount := req.AmountCents
	if amount == 0 {
		amount = order.AmountCents
	}
	err := h.transitionOrder(order, paymentWebhookBody{
		Status: "paid", AmountCents: amount, Note: req.Note,
	}, order.Channel)
	if err != nil {
		httpx.Err(w, http.StatusConflict, "invalid_transition", err.Error())
		return
	}
	h.audit(r, "admin.order.mark_paid", order.ID.String(), fmt.Sprintf("%d", amount))
	httpx.JSON(w, http.StatusOK, map[string]any{"id": order.ID, "status": "paid", "amount_cents": amount})
}
