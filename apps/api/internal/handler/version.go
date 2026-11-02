package handler

import (
	"net/http"
	"sort"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/heyman123123/designkit-commerce/apps/api/internal/httpx"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/model"
)

type versionItem struct {
	JobID        string    `json:"job_id"`
	AssetID      string    `json:"asset_id"`
	Template     string    `json:"template"`
	VersionNo    int       `json:"version_no"`
	IsCurrent    bool      `json:"is_current"`
	ReviewStatus string    `json:"review_status"`
	AssetStatus  string    `json:"asset_status"`
	QCScore      int       `json:"qc_score"`
	QCIssues     string    `json:"qc_issues"`
	CostCents    int       `json:"cost_cents"`
	Reason       string    `json:"review_reason"`
	CreatedAt    time.Time `json:"created_at"`
}

// ListVersions 返回某 SKU 的结果版本链：按模板分组编号，并标出当前主版本。
func (h *Handler) ListVersions(w http.ResponseWriter, r *http.Request) {
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

	var jobs []model.GenerationJob
	if err := h.DB.Where("workspace_id = ? AND sku_id = ? AND status = ?", wsID(r), sku.ID, "succeeded").
		Order("created_at asc").Find(&jobs).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "query_failed", "查询失败")
		return
	}

	assetIDs := make([]uuid.UUID, 0, len(jobs))
	for _, j := range jobs {
		if j.OutputAssetID != nil {
			assetIDs = append(assetIDs, *j.OutputAssetID)
		}
	}
	assetMap := map[uuid.UUID]model.Asset{}
	if len(assetIDs) > 0 {
		var assets []model.Asset
		h.DB.Where("workspace_id = ? AND id IN ?", wsID(r), assetIDs).Find(&assets)
		for _, a := range assets {
			assetMap[a.ID] = a
		}
	}

	var marks []model.VersionMark
	h.DB.Where("workspace_id = ? AND sku_id = ?", wsID(r), sku.ID).Find(&marks)
	currentByTemplate := map[string]uuid.UUID{}
	for _, m := range marks {
		if m.IsCurrent {
			currentByTemplate[m.Template] = m.JobID
		}
	}

	counters := map[string]int{}
	lastByTemplate := map[string]uuid.UUID{}
	lastApproved := map[string]uuid.UUID{}
	out := make([]versionItem, 0, len(jobs))
	for _, j := range jobs {
		counters[j.Template]++
		lastByTemplate[j.Template] = j.ID
		if j.ReviewStatus == "approved" {
			lastApproved[j.Template] = j.ID
		}
		item := versionItem{
			JobID: j.ID.String(), Template: j.Template, VersionNo: counters[j.Template],
			ReviewStatus: j.ReviewStatus, CostCents: j.CostCents, Reason: j.ReviewReason,
			CreatedAt: j.CreatedAt,
		}
		if j.OutputAssetID != nil {
			item.AssetID = j.OutputAssetID.String()
			if a, ok := assetMap[*j.OutputAssetID]; ok {
				item.AssetStatus = a.Status
				item.QCScore = a.QCScore
				item.QCIssues = a.QCIssues
			}
		}
		out = append(out, item)
	}

	// 当前版本：显式标记优先，其次最近审核通过，最后最近一次生成。
	for i := range out {
		t := out[i].Template
		var chosen uuid.UUID
		if v, ok := currentByTemplate[t]; ok {
			chosen = v
		} else if v, ok := lastApproved[t]; ok {
			chosen = v
		} else {
			chosen = lastByTemplate[t]
		}
		out[i].IsCurrent = chosen != uuid.Nil && out[i].JobID == chosen.String()
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Template != out[j].Template {
			return out[i].Template < out[j].Template
		}
		return out[i].VersionNo > out[j].VersionNo
	})

	names := make([]string, 0, len(validTemplates))
	for k := range validTemplates {
		names = append(names, k)
	}
	sort.Strings(names)
	httpx.JSON(w, http.StatusOK, map[string]any{"items": out, "templates": names})
}

// PromoteVersion 把某个历史版本设为当前主版本（导出只取主版本）。
func (h *Handler) PromoteVersion(w http.ResponseWriter, r *http.Request) {
	skuID, ok := pathID(r, "skuID")
	if !ok {
		badRequest(w, "SKU ID 无效")
		return
	}
	jobID, ok := pathID(r, "jobID")
	if !ok {
		badRequest(w, "任务 ID 无效")
		return
	}
	var sku model.SKU
	if err := h.DB.First(&sku, "id = ? AND workspace_id = ?", skuID, wsID(r)).Error; err != nil {
		httpx.Err(w, http.StatusNotFound, "not_found", "资源不存在")
		return
	}
	var job model.GenerationJob
	if err := h.DB.First(&job, "id = ? AND workspace_id = ? AND sku_id = ?", jobID, wsID(r), sku.ID).Error; err != nil {
		httpx.Err(w, http.StatusNotFound, "not_found", "资源不存在")
		return
	}
	if job.Status != "succeeded" {
		httpx.Err(w, http.StatusConflict, "not_ready", "任务尚未成功，不能设为当前版本")
		return
	}
	if err := h.DB.Transaction(func(tx *gorm.DB) error {
		return promoteVersion(tx, wsID(r), sku.ID, job.Template, job.ID)
	}); err != nil {
		httpx.Err(w, http.StatusInternalServerError, "update_failed", "切换版本失败")
		return
	}
	h.audit(r, "version.promote", job.ID.String(), job.Template)
	httpx.JSON(w, http.StatusOK, map[string]any{"job_id": job.ID, "template": job.Template, "is_current": true})
}

// promoteVersion 在同一事务内把同模板的其他版本取消当前标记。
func promoteVersion(tx *gorm.DB, ws, skuID uuid.UUID, template string, jobID uuid.UUID) error {
	if err := tx.Model(&model.VersionMark{}).
		Where("workspace_id = ? AND sku_id = ? AND template = ?", ws, skuID, template).
		Update("is_current", false).Error; err != nil {
		return err
	}
	var existing model.VersionMark
	err := tx.Where("workspace_id = ? AND job_id = ?", ws, jobID).First(&existing).Error
	if err == nil {
		return tx.Model(&model.VersionMark{}).Where("id = ?", existing.ID).
			Updates(map[string]any{"is_current": true, "deleted_at": nil}).Error
	}
	if err != gorm.ErrRecordNotFound {
		return err
	}
	return tx.Create(&model.VersionMark{
		WorkspaceID: ws, SKUID: skuID, Template: template, JobID: jobID, IsCurrent: true,
	}).Error
}
