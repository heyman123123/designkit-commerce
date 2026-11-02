package handler

import (
	"archive/zip"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/httpx"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/model"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/reqctx"
	"gorm.io/gorm"
)

var validTemplates = map[string]bool{"main": true, "scene": true, "selling_point": true}

type createJobReq struct {
	SKUID          string `json:"sku_id"`
	SourceAssetID  string `json:"source_asset_id"`
	Template       string `json:"template"`
	IdempotencyKey string `json:"idempotency_key"`
}

// CreateJob 入队生成任务；同一幂等键重复提交返回原任务，不重复扣费。
func (h *Handler) CreateJob(w http.ResponseWriter, r *http.Request) {
	if !reqctx.CanWrite(reqctx.Role(r.Context())) {
		httpx.Err(w, http.StatusForbidden, "read_only", "当前角色没有写入权限")
		return
	}
	var req createJobReq
	if err := httpx.Decode(r, &req); err != nil {
		badRequest(w, "请求体格式不正确")
		return
	}
	if !validTemplates[req.Template] {
		badRequest(w, "模板不合法")
		return
	}
	skuID, err := uuid.Parse(req.SKUID)
	if err != nil {
		badRequest(w, "SKU ID 无效")
		return
	}
	var sku model.SKU
	if err := h.DB.First(&sku, "id = ? AND workspace_id = ?", skuID, wsID(r)).Error; err != nil {
		httpx.Err(w, http.StatusNotFound, "not_found", "资源不存在")
		return
	}

	var ws model.Workspace
	if err := h.DB.First(&ws, "id = ?", wsID(r)).Error; err != nil {
		httpx.Err(w, http.StatusNotFound, "not_found", "资源不存在")
		return
	}
	if ws.Status == "readonly" || ws.Status == "suspended" {
		httpx.Err(w, http.StatusPaymentRequired, "read_only_plan", "当前套餐为只读状态")
		return
	}

	job := model.GenerationJob{
		WorkspaceID: wsID(r), SKUID: sku.ID, Template: req.Template,
		Status: "queued", ReviewStatus: "pending",
	}
	if req.SourceAssetID != "" {
		aid, err := uuid.Parse(req.SourceAssetID)
		if err != nil {
			badRequest(w, "素材 ID 无效")
			return
		}
		var asset model.Asset
		if err := h.DB.First(&asset, "id = ? AND workspace_id = ? AND sku_id = ?", aid, wsID(r), sku.ID).Error; err != nil {
			httpx.Err(w, http.StatusNotFound, "not_found", "资源不存在")
			return
		}
		job.SourceAssetID = &aid
	}
	if req.IdempotencyKey != "" {
		key := req.IdempotencyKey
		job.IdempotencyKey = &key
		var existing model.GenerationJob
		if err := h.DB.First(&existing, "workspace_id = ? AND idempotency_key = ?", wsID(r), key).Error; err == nil {
			httpx.JSON(w, http.StatusOK, existing)
			return
		}
	}

	if err := h.DB.Create(&job).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "create_failed", "创建任务失败")
		return
	}
	h.audit(r, "job.create", job.ID.String(), req.Template)
	httpx.JSON(w, http.StatusCreated, job)
}

func (h *Handler) ListJobs(w http.ResponseWriter, r *http.Request) {
	q := h.DB.Where("workspace_id = ?", wsID(r))
	if sku := r.URL.Query().Get("sku_id"); sku != "" {
		q = q.Where("sku_id = ?", sku)
	}
	if status := r.URL.Query().Get("status"); status != "" {
		q = q.Where("status = ?", status)
	}
	var items []model.GenerationJob
	if err := q.Order("created_at desc").Limit(200).Find(&items).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "query_failed", "查询失败")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

func (h *Handler) GetJob(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "jobID")
	if !ok {
		badRequest(w, "任务 ID 无效")
		return
	}
	var job model.GenerationJob
	if err := h.DB.First(&job, "id = ? AND workspace_id = ?", id, wsID(r)).Error; err != nil {
		httpx.Err(w, http.StatusNotFound, "not_found", "资源不存在")
		return
	}
	httpx.JSON(w, http.StatusOK, job)
}

type reviewReq struct {
	Status string `json:"status"`
	Reason string `json:"reason"`
}

// ReviewJob 审核生成结果，驳回必须给出原因。
func (h *Handler) ReviewJob(w http.ResponseWriter, r *http.Request) {
	if !reqctx.CanReview(reqctx.Role(r.Context())) {
		httpx.Err(w, http.StatusForbidden, "forbidden", "当前角色没有审核权限")
		return
	}
	id, ok := pathID(r, "jobID")
	if !ok {
		badRequest(w, "任务 ID 无效")
		return
	}
	var req reviewReq
	if err := httpx.Decode(r, &req); err != nil {
		badRequest(w, "请求体格式不正确")
		return
	}
	switch req.Status {
	case "approved", "rejected", "manual":
	default:
		badRequest(w, "审核状态不合法")
		return
	}
	if req.Status == "rejected" && req.Reason == "" {
		badRequest(w, "驳回必须填写原因")
		return
	}

	var job model.GenerationJob
	if err := h.DB.First(&job, "id = ? AND workspace_id = ?", id, wsID(r)).Error; err != nil {
		httpx.Err(w, http.StatusNotFound, "not_found", "资源不存在")
		return
	}
	if job.Status != "succeeded" {
		httpx.Err(w, http.StatusConflict, "not_reviewable", "任务尚未完成，不能审核")
		return
	}

	err := h.DB.Transaction(func(tx *gorm.DB) error {
		return applyReview(tx, wsID(r), &job, req.Status, req.Reason)
	})
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "update_failed", "审核失败")
		return
	}
	h.audit(r, "job.review", job.ID.String(), req.Status)
	httpx.JSON(w, http.StatusOK, map[string]any{"id": job.ID, "review_status": req.Status})
}

type usageResp struct {
	SkuQuota    int                 `json:"sku_quota"`
	SkuUsed     int                 `json:"sku_used"`
	ExportQuota int                 `json:"export_quota"`
	ExportUsed  int                 `json:"export_used"`
	CostCents   int                 `json:"cost_cents"`
	Entries     []model.UsageLedger `json:"entries"`
}

func (h *Handler) Usage(w http.ResponseWriter, r *http.Request) {
	var ws model.Workspace
	if err := h.DB.First(&ws, "id = ?", wsID(r)).Error; err != nil {
		httpx.Err(w, http.StatusNotFound, "not_found", "资源不存在")
		return
	}
	var entries []model.UsageLedger
	h.DB.Where("workspace_id = ?", wsID(r)).Order("created_at desc").Limit(50).Find(&entries)

	var cost int64
	h.DB.Model(&model.UsageLedger{}).Where("workspace_id = ?", wsID(r)).
		Select("COALESCE(SUM(cost_cents),0)").Scan(&cost)

	httpx.JSON(w, http.StatusOK, usageResp{
		SkuQuota: ws.SkuQuota, SkuUsed: ws.SkuUsed,
		ExportQuota: ws.ExportQuota, ExportUsed: ws.ExportUsed,
		CostCents: int(cost), Entries: entries,
	})
}

// ExportSKU 打包该 SKU 下已通过 QC 的结果图，按套餐扣减导出额度。
func (h *Handler) ExportSKU(w http.ResponseWriter, r *http.Request) {
	skuID, ok := pathID(r, "skuID")
	if !ok {
		badRequest(w, "SKU ID 无效")
		return
	}
	var sku model.SKU
	if err := h.DB.First(&sku, "id = ? AND workspace_id = ?", skuID, wsID(r)).Error; err != nil {
		httpx.Err(w, http.StatusNotFound, "not_found", "资源不存在")
		return
	}
	var ws model.Workspace
	if err := h.DB.First(&ws, "id = ?", wsID(r)).Error; err != nil {
		httpx.Err(w, http.StatusNotFound, "not_found", "资源不存在")
		return
	}
	if ws.ExportUsed >= ws.ExportQuota {
		httpx.Err(w, http.StatusPaymentRequired, "quota_exceeded", "高清导出额度已用完")
		return
	}
	assets, templateByAsset, hasMarks, err := currentVersionAssets(h.DB, wsID(r), sku)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "query_failed", "查询失败")
		return
	}
	if len(assets) == 0 {
		if hasMarks {
			httpx.Err(w, http.StatusConflict, "nothing_to_export", "当前主版本没有可导出的结果")
		} else {
			httpx.Err(w, http.StatusConflict, "nothing_to_export", "没有通过质检的结果可导出")
		}
		return
	}

	if err := h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&model.Workspace{}).Where("id = ?", wsID(r)).
			UpdateColumn("export_used", gorm.Expr("export_used + 1")).Error; err != nil {
			return err
		}
		return tx.Create(&model.UsageLedger{
			WorkspaceID: wsID(r), Event: "export", Units: 1, Note: sku.Code,
		}).Error
	}); err != nil {
		httpx.Err(w, http.StatusInternalServerError, "export_failed", "记录导出失败")
		return
	}

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf("attachment; filename=\"%s-amazon-pack.zip\"", sku.Code))
	w.WriteHeader(http.StatusOK)

	zw := zip.NewWriter(w)
	defer zw.Close()
	for _, a := range assets {
		f, err := h.Store.Open(r.Context(), a.StorageKey)
		if err != nil {
			continue
		}
		ext := filepath.Ext(a.StorageKey)
		label := templateByAsset[a.ID]
		if label == "" {
			label = strings.TrimSuffix(filepath.Base(a.StorageKey), ext)
		}
		name := fmt.Sprintf("%s/%s-%s%s", sku.Code, label, a.ID.String()[:8], ext)
		entry, err := zw.Create(name)
		if err == nil {
			_, _ = io.Copy(entry, f)
		}
		f.Close()
	}
	h.audit(r, "sku.export", sku.ID.String(), sku.Code)
}
