package handler

import (
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/heyman123123/designkit-commerce/apps/api/internal/httpx"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/model"
)

/* ---------------- 平台概览 ---------------- */

// AdminOverview 给后台首页一组全局指标。
func (h *Handler) AdminOverview(w http.ResponseWriter, r *http.Request) {
	count := func(m any, where string, args ...any) int64 {
		var n int64
		q := h.DB.Model(m)
		if where != "" {
			q = q.Where(where, args...)
		}
		q.Count(&n)
		return n
	}
	var revenue, cost int64
	h.DB.Model(&model.Order{}).Where("status = ?", "paid").Select("COALESCE(SUM(amount_cents),0)").Scan(&revenue)
	h.DB.Model(&model.UsageLedger{}).Select("COALESCE(SUM(cost_cents),0)").Scan(&cost)

	var recent []model.Order
	h.DB.Order("created_at desc").Limit(5).Find(&recent)

	httpx.JSON(w, http.StatusOK, map[string]any{
		"tenants": map[string]any{
			"total":     count(&model.Workspace{}, ""),
			"active":    count(&model.Workspace{}, "status = ?", "active"),
			"readonly":  count(&model.Workspace{}, "status = ?", "readonly"),
			"suspended": count(&model.Workspace{}, "status = ?", "suspended"),
		},
		"jobs": map[string]any{
			"queued":    count(&model.GenerationJob{}, "status = ?", "queued"),
			"running":   count(&model.GenerationJob{}, "status = ?", "running"),
			"succeeded": count(&model.GenerationJob{}, "status = ?", "succeeded"),
			"failed":    count(&model.GenerationJob{}, "status = ?", "failed"),
		},
		"revenue_cents":  revenue,
		"cost_cents":     cost,
		"margin_cents":   revenue - cost,
		"pending_orders": count(&model.Order{}, "status = ?", "pending"),
		"open_risks":     count(&model.RiskCase{}, "status = ?", "open"),
		"recent_orders":  recent,
	})
}

/* ---------------- 套餐 ---------------- */

func (h *Handler) AdminListPlans(w http.ResponseWriter, r *http.Request) {
	var items []model.Plan
	if err := h.DB.Order("sort asc, price_cents asc").Find(&items).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "query_failed", "查询失败")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

type planReq struct {
	Code        string `json:"code"`
	Name        string `json:"name"`
	PriceCents  *int   `json:"price_cents"`
	PeriodDays  *int   `json:"period_days"`
	SkuQuota    *int   `json:"sku_quota"`
	ExportQuota *int   `json:"export_quota"`
	Features    string `json:"features"`
	Active      *bool  `json:"active"`
	Sort        *int   `json:"sort"`
}

func (h *Handler) AdminUpsertPlan(w http.ResponseWriter, r *http.Request) {
	var req planReq
	if err := httpx.Decode(r, &req); err != nil {
		badRequest(w, "请求体格式不正确")
		return
	}
	// PATCH /plans/{code} 以 URL 为准；POST /plans 用请求体。
	if pathCode := strings.TrimSpace(chi.URLParam(r, "code")); pathCode != "" {
		if req.Code != "" && req.Code != pathCode {
			badRequest(w, "URL 与请求体中的套餐编码不一致")
			return
		}
		req.Code = pathCode
	}
	req.Code = strings.TrimSpace(req.Code)
	if req.Code == "" {
		badRequest(w, "请填写套餐编码")
		return
	}
	var plan model.Plan
	err := h.DB.First(&plan, "code = ?", req.Code).Error
	creating := err != nil
	if err != nil && err != gorm.ErrRecordNotFound {
		httpx.Err(w, http.StatusInternalServerError, "query_failed", "查询失败")
		return
	}
	if creating {
		if req.Name == "" {
			badRequest(w, "请填写套餐名称")
			return
		}
		plan = model.Plan{Code: req.Code, Name: req.Name}
	}
	if req.Name != "" {
		plan.Name = req.Name
	}
	if req.PriceCents != nil {
		plan.PriceCents = *req.PriceCents
	}
	if req.PeriodDays != nil {
		plan.PeriodDays = *req.PeriodDays
	}
	if req.SkuQuota != nil {
		plan.SkuQuota = *req.SkuQuota
	}
	if req.ExportQuota != nil {
		plan.ExportQuota = *req.ExportQuota
	}
	if req.Features != "" {
		plan.Features = req.Features
	}
	if req.Active != nil {
		plan.Active = *req.Active
	}
	if req.Sort != nil {
		plan.Sort = *req.Sort
	}
	if err := h.DB.Save(&plan).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "save_failed", "保存失败")
		return
	}
	h.audit(r, "admin.plan.upsert", plan.Code, "")
	httpx.JSON(w, http.StatusOK, plan)
}

// AdminApplyPlan 把套餐配额应用到租户（开通/续费/升级）。
func (h *Handler) AdminApplyPlan(w http.ResponseWriter, r *http.Request) {
	ws, ok := h.tenantByPath(w, r)
	if !ok {
		return
	}
	var req struct {
		PlanCode string `json:"plan_code"`
	}
	if err := httpx.Decode(r, &req); err != nil || req.PlanCode == "" {
		badRequest(w, "请选择套餐")
		return
	}
	var plan model.Plan
	if err := h.DB.First(&plan, "code = ?", req.PlanCode).Error; err != nil {
		httpx.Err(w, http.StatusNotFound, "plan_not_found", "套餐不存在")
		return
	}
	if err := h.DB.Model(&model.Workspace{}).Where("id = ?", ws.ID).Updates(map[string]any{
		"plan": plan.Code, "sku_quota": plan.SkuQuota, "export_quota": plan.ExportQuota,
	}).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "update_failed", "应用套餐失败")
		return
	}
	h.audit(r, "admin.tenant.apply_plan", ws.ID.String(), plan.Code)
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": ws.ID, "plan": plan.Code, "sku_quota": plan.SkuQuota, "export_quota": plan.ExportQuota,
	})
}

// AdminExtendTrial 延长试用期。
func (h *Handler) AdminExtendTrial(w http.ResponseWriter, r *http.Request) {
	ws, ok := h.tenantByPath(w, r)
	if !ok {
		return
	}
	var req struct {
		Days int `json:"days"`
	}
	if err := httpx.Decode(r, &req); err != nil || req.Days <= 0 || req.Days > 365 {
		badRequest(w, "请填写 1-365 天")
		return
	}
	until := time.Now().AddDate(0, 0, req.Days)
	if err := h.DB.Model(&model.Workspace{}).Where("id = ?", ws.ID).
		Updates(map[string]any{"trial_ends_at": until, "status": "active"}).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "update_failed", "更新失败")
		return
	}
	h.audit(r, "admin.tenant.trial", ws.ID.String(), until.Format(time.RFC3339))
	httpx.JSON(w, http.StatusOK, map[string]any{"id": ws.ID, "trial_ends_at": until})
}

/* ---------------- 订单 ---------------- */

type orderView struct {
	model.Order
	TenantName string `json:"tenant_name"`
}

func (h *Handler) AdminListOrders(w http.ResponseWriter, r *http.Request) {
	q := h.DB.Model(&model.Order{})
	if st := r.URL.Query().Get("status"); st != "" {
		q = q.Where("status = ?", st)
	}
	if ws := r.URL.Query().Get("workspace_id"); ws != "" {
		q = q.Where("workspace_id = ?", ws)
	}
	var items []model.Order
	if err := q.Order("created_at desc").Limit(200).Find(&items).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "query_failed", "查询失败")
		return
	}
	out := make([]orderView, 0, len(items))
	names := map[uuid.UUID]string{}
	for _, it := range items {
		name, ok := names[it.WorkspaceID]
		if !ok {
			var ws model.Workspace
			h.DB.First(&ws, "id = ?", it.WorkspaceID)
			name = ws.Name
			names[it.WorkspaceID] = name
		}
		out = append(out, orderView{Order: it, TenantName: name})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": out})
}

type createOrderReq struct {
	WorkspaceID string `json:"workspace_id"`
	PlanCode    string `json:"plan_code"`
	AmountCents int    `json:"amount_cents"`
	Status      string `json:"status"`
	Channel     string `json:"channel"`
	Note        string `json:"note"`
}

func (h *Handler) AdminCreateOrder(w http.ResponseWriter, r *http.Request) {
	var req createOrderReq
	if err := httpx.Decode(r, &req); err != nil {
		badRequest(w, "请求体格式不正确")
		return
	}
	wsID, err := uuid.Parse(req.WorkspaceID)
	if err != nil {
		badRequest(w, "租户 ID 无效")
		return
	}
	if req.PlanCode == "" {
		badRequest(w, "请填写套餐编码")
		return
	}
	switch req.Status {
	case "", "pending", "paid":
	default:
		badRequest(w, "订单状态不合法")
		return
	}
	status := req.Status
	if status == "" {
		status = "paid"
	}
	if req.Channel == "" {
		req.Channel = "manual"
	}
	order := model.Order{
		WorkspaceID: wsID, PlanCode: req.PlanCode, AmountCents: req.AmountCents,
		Status: status, Channel: req.Channel, Note: req.Note,
	}
	if status == "paid" {
		now := time.Now()
		order.PaidAt = &now
	}
	err = h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&order).Error; err != nil {
			return err
		}
		if status == "paid" {
			return applyPlanQuota(tx, wsID, req.PlanCode)
		}
		return nil
	})
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "create_failed", "创建订单失败")
		return
	}
	h.audit(r, "admin.order.create", order.ID.String(), req.PlanCode)
	httpx.JSON(w, http.StatusCreated, order)
}

func (h *Handler) AdminRefundOrder(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "orderID")
	if !ok {
		badRequest(w, "订单 ID 无效")
		return
	}
	var order model.Order
	if err := h.DB.First(&order, "id = ?", id).Error; err != nil {
		httpx.Err(w, http.StatusNotFound, "not_found", "订单不存在")
		return
	}
	if order.Status == "refunded" {
		httpx.Err(w, http.StatusConflict, "already_refunded", "订单已退款")
		return
	}
	if err := h.DB.Model(&model.Order{}).Where("id = ?", order.ID).Update("status", "refunded").Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "update_failed", "退款失败")
		return
	}
	h.audit(r, "admin.order.refund", order.ID.String(), "")
	httpx.JSON(w, http.StatusOK, map[string]any{"id": order.ID, "status": "refunded"})
}

/* ---------------- 优惠码 ---------------- */

func (h *Handler) AdminListCoupons(w http.ResponseWriter, r *http.Request) {
	var items []model.Coupon
	if err := h.DB.Order("created_at desc").Limit(100).Find(&items).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "query_failed", "查询失败")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

func (h *Handler) AdminUpsertCoupon(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code           string `json:"code"`
		PercentOff     *int   `json:"percent_off"`
		AmountOffCents *int   `json:"amount_off_cents"`
		MaxRedemptions *int   `json:"max_redemptions"`
		ExpiresInDays  *int   `json:"expires_in_days"`
		Active         *bool  `json:"active"`
		Note           string `json:"note"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		badRequest(w, "请求体格式不正确")
		return
	}
	req.Code = strings.ToUpper(strings.TrimSpace(req.Code))
	if req.Code == "" {
		badRequest(w, "请填写优惠码")
		return
	}
	var c model.Coupon
	err := h.DB.First(&c, "code = ?", req.Code).Error
	creating := err != nil
	if creating {
		c = model.Coupon{Code: req.Code, Active: true}
	}
	if req.PercentOff != nil {
		if *req.PercentOff < 0 || *req.PercentOff > 100 {
			badRequest(w, "折扣百分比需在 0-100")
			return
		}
		c.PercentOff = *req.PercentOff
	}
	if req.AmountOffCents != nil {
		c.AmountOffCents = *req.AmountOffCents
	}
	if req.MaxRedemptions != nil {
		c.MaxRedemptions = *req.MaxRedemptions
	}
	if req.Active != nil {
		c.Active = *req.Active
	}
	if req.Note != "" {
		c.Note = req.Note
	}
	if req.ExpiresInDays != nil && *req.ExpiresInDays > 0 {
		until := time.Now().AddDate(0, 0, *req.ExpiresInDays)
		c.ExpiresAt = &until
	}
	if err := h.DB.Save(&c).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "save_failed", "保存失败")
		return
	}
	h.audit(r, "admin.coupon.upsert", c.Code, "")
	httpx.JSON(w, http.StatusOK, c)
}

/* ---------------- 风控 ---------------- */

type riskView struct {
	model.RiskCase
	TenantName string `json:"tenant_name"`
}

func (h *Handler) AdminListRisk(w http.ResponseWriter, r *http.Request) {
	q := h.DB.Model(&model.RiskCase{})
	if st := r.URL.Query().Get("status"); st != "" {
		q = q.Where("status = ?", st)
	}
	var items []model.RiskCase
	if err := q.Order("created_at desc").Limit(200).Find(&items).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "query_failed", "查询失败")
		return
	}
	out := make([]riskView, 0, len(items))
	for _, it := range items {
		name := ""
		if it.WorkspaceID != nil {
			var ws model.Workspace
			if h.DB.First(&ws, "id = ?", *it.WorkspaceID).Error == nil {
				name = ws.Name
			}
		}
		out = append(out, riskView{RiskCase: it, TenantName: name})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": out})
}

func (h *Handler) AdminCreateRisk(w http.ResponseWriter, r *http.Request) {
	var req struct {
		WorkspaceID string `json:"workspace_id"`
		Kind        string `json:"kind"`
		Severity    string `json:"severity"`
		Detail      string `json:"detail"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		badRequest(w, "请求体格式不正确")
		return
	}
	if req.Kind == "" {
		badRequest(w, "请选择风控类型")
		return
	}
	switch req.Severity {
	case "", "low", "medium", "high":
	default:
		badRequest(w, "严重级别不合法")
		return
	}
	if req.Severity == "" {
		req.Severity = "medium"
	}
	c := model.RiskCase{Kind: req.Kind, Severity: req.Severity, Detail: req.Detail, Status: "open"}
	if req.WorkspaceID != "" {
		id, err := uuid.Parse(req.WorkspaceID)
		if err != nil {
			badRequest(w, "租户 ID 无效")
			return
		}
		c.WorkspaceID = &id
	}
	if err := h.DB.Create(&c).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "create_failed", "创建失败")
		return
	}
	h.audit(r, "admin.risk.create", c.ID.String(), req.Kind)
	httpx.JSON(w, http.StatusCreated, c)
}

// AdminResolveRisk 结案；freeze=true 时同时暂停租户。
func (h *Handler) AdminResolveRisk(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "riskID")
	if !ok {
		badRequest(w, "风控 ID 无效")
		return
	}
	var req struct {
		Resolution string `json:"resolution"`
		Freeze     bool   `json:"freeze"`
	}
	_ = httpx.Decode(r, &req)
	var c model.RiskCase
	if err := h.DB.First(&c, "id = ?", id).Error; err != nil {
		httpx.Err(w, http.StatusNotFound, "not_found", "记录不存在")
		return
	}
	now := time.Now()
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&model.RiskCase{}).Where("id = ?", c.ID).Updates(map[string]any{
			"status": "resolved", "resolution": req.Resolution, "resolved_at": now,
		}).Error; err != nil {
			return err
		}
		if req.Freeze && c.WorkspaceID != nil {
			return tx.Model(&model.Workspace{}).Where("id = ?", *c.WorkspaceID).Update("status", "suspended").Error
		}
		return nil
	})
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "update_failed", "结案失败")
		return
	}
	h.audit(r, "admin.risk.resolve", c.ID.String(), mapToJSON(map[string]any{"freeze": req.Freeze}))
	httpx.JSON(w, http.StatusOK, map[string]any{"id": c.ID, "status": "resolved", "freeze": req.Freeze})
}

/* ---------------- 配置 ---------------- */

func (h *Handler) AdminListTemplates(w http.ResponseWriter, r *http.Request) {
	var items []model.PlatformTemplate
	if err := h.DB.Order("sort asc, code asc").Find(&items).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "query_failed", "查询失败")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

func (h *Handler) AdminPatchTemplate(w http.ResponseWriter, r *http.Request) {
	code := strings.TrimSpace(chi.URLParam(r, "code"))
	if code == "" {
		badRequest(w, "模板编码无效")
		return
	}
	var req struct {
		Name     *string `json:"name"`
		Prompt   *string `json:"prompt"`
		Active   *bool   `json:"active"`
		Sort     *int    `json:"sort"`
		Platform *string `json:"platform"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		badRequest(w, "请求体格式不正确")
		return
	}
	var t model.PlatformTemplate
	if err := h.DB.First(&t, "code = ?", code).Error; err != nil {
		httpx.Err(w, http.StatusNotFound, "not_found", "模板不存在")
		return
	}
	updates := map[string]any{}
	if req.Name != nil && *req.Name != "" {
		updates["name"] = *req.Name
	}
	if req.Prompt != nil {
		updates["prompt"] = *req.Prompt
	}
	if req.Active != nil {
		updates["active"] = *req.Active
	}
	if req.Sort != nil {
		updates["sort"] = *req.Sort
	}
	if req.Platform != nil && *req.Platform != "" {
		updates["platform"] = *req.Platform
	}
	if len(updates) == 0 {
		badRequest(w, "没有需要更新的字段")
		return
	}
	if err := h.DB.Model(&model.PlatformTemplate{}).Where("id = ?", t.ID).Updates(updates).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "update_failed", "更新失败")
		return
	}
	h.audit(r, "admin.template.update", code, mapToJSON(updates))
	httpx.JSON(w, http.StatusOK, map[string]any{"code": code, "updates": updates})
}

func (h *Handler) AdminListFlags(w http.ResponseWriter, r *http.Request) {
	var items []model.FeatureFlag
	if err := h.DB.Order("key asc").Find(&items).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "query_failed", "查询失败")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

func (h *Handler) AdminPatchFlag(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimSpace(chi.URLParam(r, "key"))
	if key == "" {
		badRequest(w, "开关 key 无效")
		return
	}
	var req struct {
		Enabled     *bool   `json:"enabled"`
		Description *string `json:"description"`
	}
	if err := httpx.Decode(r, &req); err != nil {
		badRequest(w, "请求体格式不正确")
		return
	}
	var f model.FeatureFlag
	if err := h.DB.First(&f, "key = ?", key).Error; err != nil {
		if err != gorm.ErrRecordNotFound {
			httpx.Err(w, http.StatusInternalServerError, "query_failed", "查询失败")
			return
		}
		f = model.FeatureFlag{Key: key}
	}
	if req.Description != nil {
		f.Description = *req.Description
	}
	if req.Enabled != nil {
		f.Enabled = *req.Enabled
	}
	if err := h.DB.Save(&f).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "save_failed", "保存失败")
		return
	}
	h.audit(r, "admin.flag.update", key, mapToJSON(map[string]any{"enabled": f.Enabled}))
	httpx.JSON(w, http.StatusOK, f)
}

/* ---------------- 成本 ---------------- */

// AdminCosts 按天 / 模板 / 租户聚合成本，用 Go 侧聚合避免数据库方言差异。
func (h *Handler) AdminCosts(w http.ResponseWriter, r *http.Request) {
	days := 30
	if v := r.URL.Query().Get("days"); v != "" {
		if n := atoiSafe(v); n > 0 && n <= 365 {
			days = n
		}
	}
	since := time.Now().AddDate(0, 0, -days)
	var rows []model.UsageLedger
	if err := h.DB.Where("created_at >= ?", since).Find(&rows).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "query_failed", "查询失败")
		return
	}

	dayMap := map[string]*costBucket{}
	tplMap := map[string]*costBucket{}
	wsMap := map[string]*costBucket{}
	eventMap := map[string]*costBucket{}
	var total int64

	for _, row := range rows {
		total += int64(row.CostCents)
		addCost(dayMap, row.CreatedAt.Format("2006-01-02"), row)
		addCost(eventMap, row.Event, row)
		if row.Event == "generation" {
			tpl := row.Note
			if tpl == "" {
				tpl = "unknown"
			}
			addCost(tplMap, tpl, row)
		}
		addCost(wsMap, row.WorkspaceID.String(), row)
	}

	byTenant := flattenCost(wsMap, false)
	for _, item := range byTenant {
		key := item["key"].(string)
		if id, err := uuid.Parse(key); err == nil {
			var ws model.Workspace
			if h.DB.First(&ws, "id = ?", id).Error == nil {
				item["name"] = ws.Name
			}
		}
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"days":             days,
		"total_cost_cents": total,
		"by_day":           flattenCost(dayMap, true),
		"by_template":      flattenCost(tplMap, false),
		"by_tenant":        byTenant,
		"by_event":         flattenCost(eventMap, false),
	})
}

type costBucket struct {
	Cost  int64
	Units int64
	Count int64
}

func addCost(m map[string]*costBucket, key string, row model.UsageLedger) {
	if key == "" {
		key = "unknown"
	}
	b, ok := m[key]
	if !ok {
		b = &costBucket{}
		m[key] = b
	}
	b.Cost += int64(row.CostCents)
	b.Units += int64(row.Units)
	b.Count++
}

func flattenCost(m map[string]*costBucket, byKey bool) []map[string]any {
	out := make([]map[string]any, 0, len(m))
	for k, b := range m {
		out = append(out, map[string]any{
			"key": k, "cost_cents": b.Cost, "units": b.Units, "count": b.Count,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if byKey {
			return out[i]["key"].(string) < out[j]["key"].(string)
		}
		ci, cj := out[i]["cost_cents"].(int64), out[j]["cost_cents"].(int64)
		if ci != cj {
			return ci > cj
		}
		return out[i]["key"].(string) < out[j]["key"].(string)
	})
	return out
}

/* ---------------- 种子数据 ---------------- */

// SeedPlatform 幂等写入默认套餐、模板与功能开关。
func SeedPlatform(db *gorm.DB) error {
	plans := []model.Plan{
		{Code: "free", Name: "免费试用", PriceCents: 0, PeriodDays: 14, SkuQuota: 1, ExportQuota: 1, Sort: 0},
		{Code: "starter", Name: "入门版", PriceCents: 2900, PeriodDays: 30, SkuQuota: 20, ExportQuota: 30, Sort: 1},
		{Code: "growth", Name: "成长版", PriceCents: 9900, PeriodDays: 30, SkuQuota: 100, ExportQuota: 200, Sort: 2},
		{Code: "pro", Name: "专业版", PriceCents: 29900, PeriodDays: 30, SkuQuota: 500, ExportQuota: 1000, Sort: 3},
	}
	for _, p := range plans {
		var count int64
		db.Model(&model.Plan{}).Where("code = ?", p.Code).Count(&count)
		if count == 0 {
			if err := db.Create(&p).Error; err != nil {
				return err
			}
		}
	}
	templates := []model.PlatformTemplate{
		{Code: "main", Name: "主图", Platform: "amazon", Sort: 0, Active: true,
			Prompt: "白底或纯色背景，商品居中，突出材质与比例，无文字水印，1:1 构图"},
		{Code: "scene", Name: "场景图", Platform: "amazon", Sort: 1, Active: true,
			Prompt: "真实生活场景，自然光，商品为主要视觉焦点，背景不喧宾夺主"},
		{Code: "selling_point", Name: "卖点图", Platform: "amazon", Sort: 2, Active: true,
			Prompt: "突出 2-3 个核心卖点，留出文字排版空间，避免夸大与绝对化表述"},
	}
	for _, t := range templates {
		var count int64
		db.Model(&model.PlatformTemplate{}).Where("code = ?", t.Code).Count(&count)
		if count == 0 {
			if err := db.Create(&t).Error; err != nil {
				return err
			}
		}
	}
	flags := []model.FeatureFlag{
		{Key: "batch_review", Description: "批量审核", Enabled: false},
		{Key: "auto_qc", Description: "自动质检拦截", Enabled: true},
		{Key: "s3_direct_upload", Description: "S3 预签名直传", Enabled: false},
		{Key: "mobile_share", Description: "移动端分享链接", Enabled: true},
	}
	for _, f := range flags {
		var count int64
		db.Model(&model.FeatureFlag{}).Where("key = ?", f.Key).Count(&count)
		if count == 0 {
			if err := db.Create(&f).Error; err != nil {
				return err
			}
		}
	}
	return nil
}

func atoiSafe(s string) int {
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0
		}
		n = n*10 + int(r-'0')
	}
	return n
}
