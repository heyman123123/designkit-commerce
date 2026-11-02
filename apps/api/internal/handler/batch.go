package handler

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/httpx"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/model"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/reqctx"
	"gorm.io/gorm"
)

// presignTTL 直传地址的有效期；客户端需要在此时限内完成 PUT。
const presignTTL = 15 * time.Minute

// presigner 由支持预签名的存储实现（S3/R2）；本地存储不实现。
type presigner interface {
	PresignPut(key string, ttl time.Duration) (string, error)
	PresignGet(key string, ttl time.Duration) (string, error)
}

type presignResp struct {
	Method    string            `json:"method"`
	UploadURL string            `json:"upload_url"`
	Key       string            `json:"key,omitempty"`
	Headers   map[string]string `json:"headers,omitempty"`
	ExpiresIn int               `json:"expires_in"`
	MaxMB     int64             `json:"max_mb"`
	Direct    bool              `json:"direct"`
}

// PresignUpload 为直传返回预签名 PUT 地址；本地存储退回服务端上传地址。
func (h *Handler) PresignUpload(w http.ResponseWriter, r *http.Request) {
	skuUUID, ok := pathID(r, "skuID")
	if !ok {
		badRequest(w, "SKU ID 无效")
		return
	}
	var sku model.SKU
	if err := h.DB.First(&sku, "id = ? AND workspace_id = ?", skuUUID, wsID(r)).Error; err != nil {
		httpx.Err(w, http.StatusNotFound, "not_found", "资源不存在")
		return
	}
	slug := chi.URLParam(r, "workspace")
	st, canPresign := h.Store.(presigner)
	// 运营开关 s3_direct_upload 关闭时退回服务端上传，便于出问题时一键降级。
	if canPresign && !h.directUploadEnabled() {
		canPresign = false
	}
	if !canPresign {
		httpx.JSON(w, http.StatusOK, presignResp{
			Method:    http.MethodPost,
			UploadURL: fmt.Sprintf("/v1/w/%s/skus/%s/assets", slug, sku.ID),
			ExpiresIn: 0,
			MaxMB:     h.Cfg.MaxUploadMB,
			Direct:    false,
		})
		return
	}
	// 客户端声明扩展名，避免服务端在 PUT 之后再改动对象名。
	ext := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("ext")))
	if ext == "" {
		ext = ".png"
	}
	if _, ok := allowedMime[mimeByExt[ext]]; !ok {
		badRequest(w, "仅支持 PNG/JPEG/WebP")
		return
	}
	key := fmt.Sprintf("ws/%s/sku/%s/src/%s%s", wsID(r), sku.Code, uuid.New(), ext)
	url, err := st.PresignPut(key, presignTTL)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "presign_failed", "生成直传地址失败")
		return
	}
	httpx.JSON(w, http.StatusOK, presignResp{
		Method:    http.MethodPut,
		UploadURL: url,
		Key:       key,
		Headers:   map[string]string{"Content-Type": mimeByExt[ext]},
		ExpiresIn: int(presignTTL / time.Second),
		MaxMB:     h.Cfg.MaxUploadMB,
		Direct:    true,
	})
}

// directUploadEnabled 读取运营开关；没有该开关记录时视为允许（存储已显式配置为 S3）。
func (h *Handler) directUploadEnabled() bool {
	var flag model.FeatureFlag
	if err := h.DB.First(&flag, "key = ?", "s3_direct_upload").Error; err != nil {
		return true
	}
	return flag.Enabled
}

var mimeByExt = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
}

type completeReq struct {
	Key string `json:"key"`
}

// CompleteUpload 在客户端直传成功后登记素材：校验归属路径后回读对象做哈希与尺寸探测。
func (h *Handler) CompleteUpload(w http.ResponseWriter, r *http.Request) {
	skuUUID, ok := pathID(r, "skuID")
	if !ok {
		badRequest(w, "SKU ID 无效")
		return
	}
	var sku model.SKU
	if err := h.DB.First(&sku, "id = ? AND workspace_id = ?", skuUUID, wsID(r)).Error; err != nil {
		httpx.Err(w, http.StatusNotFound, "not_found", "资源不存在")
		return
	}
	var req completeReq
	if err := httpx.Decode(r, &req); err != nil {
		badRequest(w, "请求体格式不正确")
		return
	}
	key := strings.TrimSpace(req.Key)
	prefix := fmt.Sprintf("ws/%s/sku/%s/src/", wsID(r), sku.Code)
	if !strings.HasPrefix(key, prefix) || strings.Contains(key, "..") {
		badRequest(w, "对象路径不属于当前 SKU")
		return
	}
	ext := strings.ToLower(filepath.Ext(key))
	mime, okMime := mimeByExt[ext]
	if !okMime {
		badRequest(w, "仅支持 PNG/JPEG/WebP")
		return
	}
	if h.Cfg.MaxUploadMB > 0 {
		// 直传绕过了 MaxBytesReader，这里用回读字节数做最后一道大小限制。
	}

	hash := ""
	width, height := 0, 0
	var size int64
	f, err := h.Store.Open(r.Context(), key)
	if err != nil {
		httpx.Err(w, http.StatusNotFound, "object_missing", "对象存储中找不到该文件，请先完成上传")
		return
	}
	hasher := sha256.New()
	size, err = io.Copy(hasher, f)
	f.Close()
	if err != nil || size == 0 {
		httpx.Err(w, http.StatusBadRequest, "object_unreadable", "无法读取已上传的对象")
		return
	}
	if h.Cfg.MaxUploadMB > 0 && size > int64(h.Cfg.MaxUploadMB)<<20 {
		_ = h.Store.Delete(r.Context(), key)
		badRequest(w, "文件超过大小限制")
		return
	}
	hash = hex.EncodeToString(hasher.Sum(nil))
	if f2, err := h.Store.Open(r.Context(), key); err == nil {
		if cfg, _, err := image.DecodeConfig(f2); err == nil {
			width, height = cfg.Width, cfg.Height
		}
		f2.Close()
	}
	if width == 0 || height == 0 {
		httpx.Err(w, http.StatusBadRequest, "not_an_image", "文件不是可识别的图片")
		return
	}

	asset := model.Asset{
		WorkspaceID: wsID(r), SKUID: sku.ID, Kind: "source",
		StorageKey: key, Mime: mime, SizeBytes: size, Hash: hash,
		Width: width, Height: height, Status: "uploaded",
	}
	if err := h.DB.Create(&asset).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "create_failed", "登记素材失败")
		return
	}
	h.audit(r, "asset.upload", asset.ID.String(), "direct")
	httpx.JSON(w, http.StatusCreated, asset)
}

type batchReviewReq struct {
	IDs    []uuid.UUID `json:"ids"`
	Status string      `json:"status"`
	Reason string      `json:"reason"`
}

type batchItem struct {
	ID    uuid.UUID `json:"id"`
	OK    bool      `json:"ok"`
	Error string    `json:"error,omitempty"`
}

// reviewBatchLimit 单次批量审核上限，避免长事务与超时。
const reviewBatchLimit = 200

// ReviewBatch 批量审核：逐条独立事务，返回每条结果而不是整体失败。
func (h *Handler) ReviewBatch(w http.ResponseWriter, r *http.Request) {
	if !reqctx.CanReview(reqctx.Role(r.Context())) {
		httpx.Err(w, http.StatusForbidden, "forbidden", "当前角色没有审核权限")
		return
	}
	var req batchReviewReq
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
	if req.Status == "rejected" && strings.TrimSpace(req.Reason) == "" {
		badRequest(w, "驳回必须填写原因")
		return
	}
	ids := dedupeIDs(req.IDs)
	if len(ids) == 0 {
		badRequest(w, "请选择要审核的结果")
		return
	}
	if len(ids) > reviewBatchLimit {
		badRequest(w, fmt.Sprintf("单次最多审核 %d 条", reviewBatchLimit))
		return
	}

	results := make([]batchItem, 0, len(ids))
	approved := 0
	for _, id := range ids {
		item := batchItem{ID: id}
		var job model.GenerationJob
		if err := h.DB.First(&job, "id = ? AND workspace_id = ?", id, wsID(r)).Error; err != nil {
			item.Error = "结果不存在"
			results = append(results, item)
			continue
		}
		if job.Status != "succeeded" {
			item.Error = "任务尚未完成"
			results = append(results, item)
			continue
		}
		err := h.DB.Transaction(func(tx *gorm.DB) error {
			return applyReview(tx, wsID(r), &job, req.Status, req.Reason)
		})
		if err != nil {
			item.Error = "审核失败"
			results = append(results, item)
			continue
		}
		item.OK = true
		if req.Status == "approved" {
			approved++
		}
		results = append(results, item)
	}
	h.audit(r, "job.review_batch", fmt.Sprintf("%d", len(ids)),
		fmt.Sprintf("%s 成功 %d/%d", req.Status, countOK(results), len(ids)))
	httpx.JSON(w, http.StatusOK, map[string]any{
		"status": req.Status, "total": len(ids), "success": countOK(results),
		"approved": approved, "items": results,
	})
}

func countOK(items []batchItem) int {
	n := 0
	for _, it := range items {
		if it.OK {
			n++
		}
	}
	return n
}

func dedupeIDs(ids []uuid.UUID) []uuid.UUID {
	seen := make(map[uuid.UUID]struct{}, len(ids))
	out := make([]uuid.UUID, 0, len(ids))
	for _, id := range ids {
		if id == uuid.Nil {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}

// applyReview 写入审核结论、同步素材状态，并在通过时把结果设为主版本。
func applyReview(tx *gorm.DB, workspaceID uuid.UUID, job *model.GenerationJob, status, reason string) error {
	if err := tx.Model(&model.GenerationJob{}).Where("id = ?", job.ID).
		Updates(map[string]any{"review_status": status, "review_reason": reason}).Error; err != nil {
		return err
	}
	if job.OutputAssetID != nil {
		assetStatus := "qc_passed"
		if status == "rejected" {
			assetStatus = "qc_rejected"
		}
		if status == "manual" {
			assetStatus = "analyzed"
		}
		if err := tx.Model(&model.Asset{}).Where("id = ?", *job.OutputAssetID).
			Update("status", assetStatus).Error; err != nil {
			return err
		}
	}
	if status == "approved" {
		return promoteVersion(tx, workspaceID, job.SKUID, job.Template, job.ID)
	}
	return nil
}

type batchExportReq struct {
	SkuIDs []uuid.UUID `json:"sku_ids"`
}

// exportBatchLimit 单次批量导出上限。
const exportBatchLimit = 50

// ExportBatch 批量导出多个 SKU 的当前主版本，按 SKU 数扣减导出额度。
func (h *Handler) ExportBatch(w http.ResponseWriter, r *http.Request) {
	var req batchExportReq
	if err := httpx.Decode(r, &req); err != nil {
		badRequest(w, "请求体格式不正确")
		return
	}
	ids := dedupeIDs(req.SkuIDs)
	if len(ids) == 0 {
		badRequest(w, "请选择要导出的 SKU")
		return
	}
	if len(ids) > exportBatchLimit {
		badRequest(w, fmt.Sprintf("单次最多导出 %d 个 SKU", exportBatchLimit))
		return
	}
	var ws model.Workspace
	if err := h.DB.First(&ws, "id = ?", wsID(r)).Error; err != nil {
		httpx.Err(w, http.StatusNotFound, "not_found", "资源不存在")
		return
	}
	var skus []model.SKU
	if err := h.DB.Where("workspace_id = ? AND id IN ?", wsID(r), ids).Find(&skus).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "query_failed", "查询失败")
		return
	}
	if len(skus) == 0 {
		httpx.Err(w, http.StatusNotFound, "not_found", "所选 SKU 不存在")
		return
	}
	if ws.ExportUsed+len(skus) > ws.ExportQuota {
		httpx.Err(w, http.StatusPaymentRequired, "quota_exceeded",
			fmt.Sprintf("导出额度不足：需要 %d，剩余 %d", len(skus), ws.ExportQuota-ws.ExportUsed))
		return
	}

	type skuPack struct {
		sku     model.SKU
		assets  []model.Asset
		tplByID map[uuid.UUID]string
	}
	packs := make([]skuPack, 0, len(skus))
	total := 0
	for _, sku := range skus {
		assets, tplByID, _, err := currentVersionAssets(h.DB, wsID(r), sku)
		if err != nil {
			httpx.Err(w, http.StatusInternalServerError, "query_failed", "查询失败")
			return
		}
		if len(assets) == 0 {
			continue
		}
		total += len(assets)
		packs = append(packs, skuPack{sku: sku, assets: assets, tplByID: tplByID})
	}
	if total == 0 {
		httpx.Err(w, http.StatusConflict, "nothing_to_export", "所选 SKU 都没有已通过质检的当前版本")
		return
	}

	if err := h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&model.Workspace{}).Where("id = ?", wsID(r)).
			UpdateColumn("export_used", gorm.Expr("export_used + ?", len(packs))).Error; err != nil {
			return err
		}
		for _, p := range packs {
			if err := tx.Create(&model.UsageLedger{
				WorkspaceID: wsID(r), Event: "export", Units: 1, Note: p.sku.Code,
			}).Error; err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		httpx.Err(w, http.StatusInternalServerError, "export_failed", "记录导出失败")
		return
	}

	stamp := time.Now().Format("20060102-1504")
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf("attachment; filename=\"designkit-batch-%s.zip\"", stamp))
	w.Header().Set("X-Export-Skus", fmt.Sprintf("%d", len(packs)))
	w.Header().Set("X-Export-Files", fmt.Sprintf("%d", total))
	w.WriteHeader(http.StatusOK)

	zw := zip.NewWriter(w)
	defer zw.Close()
	for _, p := range packs {
		for _, a := range p.assets {
			f, err := h.Store.Open(r.Context(), a.StorageKey)
			if err != nil {
				continue
			}
			ext := filepath.Ext(a.StorageKey)
			label := p.tplByID[a.ID]
			if label == "" {
				label = strings.TrimSuffix(filepath.Base(a.StorageKey), ext)
			}
			entry, err := zw.Create(fmt.Sprintf("%s/%s-%s%s", p.sku.Code, label, a.ID.String()[:8], ext))
			if err == nil {
				_, _ = io.Copy(entry, f)
			}
			f.Close()
		}
	}
	h.audit(r, "sku.export_batch", fmt.Sprintf("%d", len(packs)), "批量导出")
}

type compareSide struct {
	Job   model.GenerationJob `json:"job"`
	Asset *model.Asset        `json:"asset"`
}

// CompareVersions 返回两个历史版本的元数据，供并排对比视图使用。
func (h *Handler) CompareVersions(w http.ResponseWriter, r *http.Request) {
	skuUUID, ok := pathID(r, "skuID")
	if !ok {
		badRequest(w, "SKU ID 无效")
		return
	}
	var sku model.SKU
	if err := h.DB.First(&sku, "id = ? AND workspace_id = ?", skuUUID, wsID(r)).Error; err != nil {
		httpx.Err(w, http.StatusNotFound, "not_found", "资源不存在")
		return
	}
	leftID, err1 := uuid.Parse(r.URL.Query().Get("left"))
	rightID, err2 := uuid.Parse(r.URL.Query().Get("right"))
	if err1 != nil || err2 != nil || leftID == rightID {
		badRequest(w, "需要两个不同的版本 ID")
		return
	}
	load := func(id uuid.UUID) (compareSide, error) {
		var job model.GenerationJob
		if err := h.DB.First(&job, "id = ? AND workspace_id = ? AND sku_id = ?",
			id, wsID(r), sku.ID).Error; err != nil {
			return compareSide{}, err
		}
		side := compareSide{Job: job}
		if job.OutputAssetID != nil {
			var asset model.Asset
			if err := h.DB.First(&asset, "id = ? AND workspace_id = ?", *job.OutputAssetID, wsID(r)).Error; err == nil {
				side.Asset = &asset
			}
		}
		return side, nil
	}
	left, err := load(leftID)
	if err != nil {
		httpx.Err(w, http.StatusNotFound, "not_found", "左版本不存在")
		return
	}
	right, err := load(rightID)
	if err != nil {
		httpx.Err(w, http.StatusNotFound, "not_found", "右版本不存在")
		return
	}
	var marks []model.VersionMark
	h.DB.Where("workspace_id = ? AND sku_id = ?", wsID(r), sku.ID).Find(&marks)
	httpx.JSON(w, http.StatusOK, map[string]any{
		"sku": sku, "left": left, "right": right, "marks": marks,
	})
}

// currentVersionAssets 取该 SKU 每个模板的当前主版本素材；没有版本标记时退回全部已通过结果。
// 第二个返回值是 素材 ID → 模板代码 的映射，用于导出文件名。
func currentVersionAssets(db *gorm.DB, workspaceID uuid.UUID, sku model.SKU) ([]model.Asset, map[uuid.UUID]string, bool, error) {
	var marks []model.VersionMark
	db.Where("workspace_id = ? AND sku_id = ? AND is_current = ?", workspaceID, sku.ID, true).Find(&marks)

	tpl := map[uuid.UUID]string{}
	q := db.Where("workspace_id = ? AND sku_id = ? AND kind = ? AND status = ?",
		workspaceID, sku.ID, "output", "qc_passed")
	if len(marks) > 0 {
		jobIDs := make([]uuid.UUID, 0, len(marks))
		for _, m := range marks {
			jobIDs = append(jobIDs, m.JobID)
		}
		var curJobs []model.GenerationJob
		db.Where("workspace_id = ? AND id IN ?", workspaceID, jobIDs).Find(&curJobs)
		assetIDs := make([]uuid.UUID, 0, len(curJobs))
		for _, j := range curJobs {
			if j.OutputAssetID != nil {
				assetIDs = append(assetIDs, *j.OutputAssetID)
				tpl[*j.OutputAssetID] = j.Template
			}
		}
		if len(assetIDs) == 0 {
			return nil, tpl, true, nil
		}
		q = q.Where("id IN ?", assetIDs)
	}
	var assets []model.Asset
	if err := q.Order("created_at asc").Find(&assets).Error; err != nil {
		return nil, nil, len(marks) > 0, err
	}
	return assets, tpl, len(marks) > 0, nil
}
