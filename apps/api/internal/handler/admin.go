package handler

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/httpx"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/model"
)

type tenantItem struct {
	ID          string `json:"id"`
	Slug        string `json:"slug"`
	Name        string `json:"name"`
	Plan        string `json:"plan"`
	Status      string `json:"status"`
	SkuQuota    int    `json:"sku_quota"`
	SkuUsed     int    `json:"sku_used"`
	ExportQuota int    `json:"export_quota"`
	ExportUsed  int    `json:"export_used"`
	CostCents   int    `json:"cost_cents"`
	OwnerEmail  string `json:"owner_email"`
	CreatedAt   string `json:"created_at"`
}

// AdminListTenants 平台后台：租户列表，支持搜索与状态筛选。
func (h *Handler) AdminListTenants(w http.ResponseWriter, r *http.Request) {
	q := h.DB.Model(&model.Workspace{})
	if s := strings.TrimSpace(r.URL.Query().Get("q")); s != "" {
		like := "%" + s + "%"
		q = q.Where("name LIKE ? OR slug LIKE ?", like, like)
	}
	if st := r.URL.Query().Get("status"); st != "" {
		q = q.Where("status = ?", st)
	}
	var total int64
	if err := q.Count(&total).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "query_failed", "查询失败")
		return
	}
	page, size := queryPage(r, 50, 100)
	var list []model.Workspace
	if err := q.Order("created_at desc").Offset((page - 1) * size).Limit(size).Find(&list).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "query_failed", "查询失败")
		return
	}
	out := make([]tenantItem, 0, len(list))
	for _, ws := range list {
		var owner model.User
		h.DB.First(&owner, "id = ?", ws.OwnerID)
		var cost int64
		h.DB.Model(&model.UsageLedger{}).Where("workspace_id = ?", ws.ID).
			Select("COALESCE(SUM(cost_cents),0)").Scan(&cost)
		out = append(out, tenantItem{
			ID: ws.ID.String(), Slug: ws.Slug, Name: ws.Name, Plan: ws.Plan, Status: ws.Status,
			SkuQuota: ws.SkuQuota, SkuUsed: ws.SkuUsed, ExportQuota: ws.ExportQuota,
			ExportUsed: ws.ExportUsed, CostCents: int(cost), OwnerEmail: owner.Email,
			CreatedAt: ws.CreatedAt.Format("2006-01-02"),
		})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": out, "total": total, "page": page, "size": size,
	})
}

func (h *Handler) tenantByPath(w http.ResponseWriter, r *http.Request) (model.Workspace, bool) {
	id, ok := pathID(r, "tenantID")
	if !ok {
		badRequest(w, "租户 ID 无效")
		return model.Workspace{}, false
	}
	var ws model.Workspace
	if err := h.DB.First(&ws, "id = ?", id).Error; err != nil {
		httpx.Err(w, http.StatusNotFound, "not_found", "租户不存在")
		return model.Workspace{}, false
	}
	return ws, true
}

func (h *Handler) AdminGetTenant(w http.ResponseWriter, r *http.Request) {
	ws, ok := h.tenantByPath(w, r)
	if !ok {
		return
	}
	var projects, skus, jobs int64
	h.DB.Model(&model.Project{}).Where("workspace_id = ?", ws.ID).Count(&projects)
	h.DB.Model(&model.SKU{}).Where("workspace_id = ?", ws.ID).Count(&skus)
	h.DB.Model(&model.GenerationJob{}).Where("workspace_id = ?", ws.ID).Count(&jobs)
	var cost int64
	h.DB.Model(&model.UsageLedger{}).Where("workspace_id = ?", ws.ID).
		Select("COALESCE(SUM(cost_cents),0)").Scan(&cost)

	var members []model.Member
	h.DB.Where("workspace_id = ?", ws.ID).Find(&members)

	httpx.JSON(w, http.StatusOK, map[string]any{
		"workspace": ws, "projects": projects, "skus": skus, "jobs": jobs,
		"cost_cents": cost, "members": len(members),
	})
}

type adminPatchTenantReq struct {
	Name        *string `json:"name"`
	Plan        *string `json:"plan"`
	Status      *string `json:"status"`
	SkuQuota    *int    `json:"sku_quota"`
	ExportQuota *int    `json:"export_quota"`
}

func (h *Handler) AdminPatchTenant(w http.ResponseWriter, r *http.Request) {
	ws, ok := h.tenantByPath(w, r)
	if !ok {
		return
	}
	var req adminPatchTenantReq
	if err := httpx.Decode(r, &req); err != nil {
		badRequest(w, "请求体格式不正确")
		return
	}
	updates := map[string]any{}
	if req.Name != nil && *req.Name != "" {
		updates["name"] = *req.Name
	}
	if req.Plan != nil {
		switch *req.Plan {
		case "free", "starter", "growth", "pro":
			updates["plan"] = *req.Plan
		default:
			badRequest(w, "套餐不合法")
			return
		}
	}
	if req.Status != nil {
		switch *req.Status {
		case "active", "readonly", "suspended":
			updates["status"] = *req.Status
		default:
			badRequest(w, "状态不合法")
			return
		}
	}
	if req.SkuQuota != nil {
		if *req.SkuQuota < 0 {
			badRequest(w, "配额不能为负")
			return
		}
		updates["sku_quota"] = *req.SkuQuota
	}
	if req.ExportQuota != nil {
		if *req.ExportQuota < 0 {
			badRequest(w, "配额不能为负")
			return
		}
		updates["export_quota"] = *req.ExportQuota
	}
	if len(updates) == 0 {
		badRequest(w, "没有需要更新的字段")
		return
	}
	if err := h.DB.Model(&model.Workspace{}).Where("id = ?", ws.ID).Updates(updates).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "update_failed", "更新失败")
		return
	}
	h.audit(r, "admin.tenant.update", ws.ID.String(), mapToJSON(updates))
	httpx.JSON(w, http.StatusOK, map[string]any{"id": ws.ID, "updates": updates})
}

func (h *Handler) AdminSuspendTenant(w http.ResponseWriter, r *http.Request) {
	ws, ok := h.tenantByPath(w, r)
	if !ok {
		return
	}
	next := "suspended"
	if ws.Status == "suspended" {
		next = "active"
	}
	if err := h.DB.Model(&model.Workspace{}).Where("id = ?", ws.ID).Update("status", next).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "update_failed", "更新失败")
		return
	}
	h.audit(r, "admin.tenant.suspend", ws.ID.String(), next)
	httpx.JSON(w, http.StatusOK, map[string]any{"id": ws.ID, "status": next})
}

func (h *Handler) AdminFailedJobs(w http.ResponseWriter, r *http.Request) {
	var jobs []model.GenerationJob
	if err := h.DB.Where("status = ?", "failed").Order("updated_at desc").Limit(100).Find(&jobs).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "query_failed", "查询失败")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": jobs})
}

// AdminRetryJob 重试失败任务，不重复扣减用户额度。
func (h *Handler) AdminRetryJob(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "jobID")
	if !ok {
		badRequest(w, "任务 ID 无效")
		return
	}
	var job model.GenerationJob
	if err := h.DB.First(&job, "id = ?", id).Error; err != nil {
		httpx.Err(w, http.StatusNotFound, "not_found", "任务不存在")
		return
	}
	err := h.DB.Model(&model.GenerationJob{}).Where("id = ?", job.ID).
		Updates(map[string]any{"status": "queued", "attempts": 0, "error": "", "progress": 0}).Error
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "update_failed", "重试失败")
		return
	}
	h.audit(r, "admin.job.retry", job.ID.String(), "")
	httpx.JSON(w, http.StatusOK, map[string]any{"id": job.ID, "status": "queued"})
}

func (h *Handler) AdminUsage(w http.ResponseWriter, r *http.Request) {
	type row struct {
		WorkspaceID uuid.UUID
		Cost        int64
	}
	var rows []row
	if err := h.DB.Model(&model.UsageLedger{}).
		Select("workspace_id, COALESCE(SUM(cost_cents),0) as cost").
		Group("workspace_id").Order("cost desc").Limit(20).Scan(&rows).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "query_failed", "查询失败")
		return
	}
	var total int64
	h.DB.Model(&model.UsageLedger{}).Select("COALESCE(SUM(cost_cents),0)").Scan(&total)
	httpx.JSON(w, http.StatusOK, map[string]any{"total_cost_cents": total, "top": rows})
}

// AdminAudit 审计日志：支持动作、租户、管理员维度筛选与分页。
func (h *Handler) AdminAudit(w http.ResponseWriter, r *http.Request) {
	q := h.DB.Model(&model.AuditLog{})
	if action := strings.TrimSpace(r.URL.Query().Get("action")); action != "" {
		q = q.Where("action = ?", action)
	}
	if prefix := strings.TrimSpace(r.URL.Query().Get("prefix")); prefix != "" {
		q = q.Where("action LIKE ?", prefix+"%")
	}
	if ws := strings.TrimSpace(r.URL.Query().Get("workspace_id")); ws != "" {
		if id, err := uuid.Parse(ws); err == nil {
			q = q.Where("workspace_id = ?", id)
		}
	}
	if admin := r.URL.Query().Get("is_admin"); admin == "true" || admin == "false" {
		q = q.Where("is_admin = ?", admin == "true")
	}
	var total int64
	if err := q.Count(&total).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "query_failed", "查询失败")
		return
	}
	page, size := queryPage(r, 200, 200)
	var items []model.AuditLog
	if err := q.Order("created_at desc").Offset((page - 1) * size).Limit(size).Find(&items).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "query_failed", "查询失败")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items, "total": total, "page": page, "size": size,
	})
}

// queryPage 解析 page/size，size 上限为 maxSize。
func queryPage(r *http.Request, defaultSize, maxSize int) (int, int) {
	page := 1
	size := defaultSize
	if v, err := strconv.Atoi(r.URL.Query().Get("page")); err == nil && v > 0 {
		page = v
	}
	if v, err := strconv.Atoi(r.URL.Query().Get("size")); err == nil && v > 0 {
		size = v
	}
	if maxSize > 0 && size > maxSize {
		size = maxSize
	}
	return page, size
}

// AdminTenantMembers 返回租户成员与其账号信息，供运营排查与联系 owner。
func (h *Handler) AdminTenantMembers(w http.ResponseWriter, r *http.Request) {
	ws, ok := h.tenantByPath(w, r)
	if !ok {
		return
	}
	var members []model.Member
	if err := h.DB.Where("workspace_id = ?", ws.ID).Order("created_at asc").Find(&members).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "query_failed", "查询失败")
		return
	}
	userIDs := make([]uuid.UUID, 0, len(members))
	for _, m := range members {
		userIDs = append(userIDs, m.UserID)
	}
	users := map[uuid.UUID]model.User{}
	if len(userIDs) > 0 {
		var rows []model.User
		if err := h.DB.Where("id IN ?", userIDs).Find(&rows).Error; err != nil {
			httpx.Err(w, http.StatusInternalServerError, "query_failed", "查询失败")
			return
		}
		for _, u := range rows {
			users[u.ID] = u
		}
	}
	items := make([]map[string]any, 0, len(members))
	for _, m := range members {
		u := users[m.UserID]
		items = append(items, map[string]any{
			"user_id": m.UserID, "email": u.Email, "name": u.Name,
			"role": m.Role, "joined_at": m.CreatedAt,
		})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}
