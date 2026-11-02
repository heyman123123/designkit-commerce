package handler

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"path/filepath"

	"github.com/google/uuid"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/httpx"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/model"
)

var allowedMime = map[string]string{
	"image/png":  ".png",
	"image/jpeg": ".jpg",
	"image/webp": ".webp",
}

// UploadAsset 接收 multipart 上传，落对象存储并登记素材。
func (h *Handler) UploadAsset(w http.ResponseWriter, r *http.Request) {
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

	r.Body = http.MaxBytesReader(w, r.Body, h.Cfg.MaxUploadMB<<20)
	file, header, err := r.FormFile("file")
	if err != nil {
		badRequest(w, "请上传 file 字段")
		return
	}
	defer file.Close()

	buf := make([]byte, 512)
	n, _ := io.ReadFull(file, buf)
	mime := http.DetectContentType(buf[:n])
	ext, okMime := allowedMime[mime]
	if !okMime {
		badRequest(w, "仅支持 PNG/JPEG/WebP")
		return
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		httpx.Err(w, http.StatusInternalServerError, "upload_failed", "读取文件失败")
		return
	}

	assetID := uuid.New()
	key := fmt.Sprintf("ws/%s/sku/%s/src/%s%s", wsID(r), sku.Code, assetID, ext)
	size, err := h.Store.Save(r.Context(), key, file)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "upload_failed", "保存文件失败")
		return
	}

	// 重新读取用于 hash 与尺寸探测
	hash := ""
	width, height := 0, 0
	if f, err := h.Store.Open(r.Context(), key); err == nil {
		hasher := sha256.New()
		if _, err := io.Copy(hasher, f); err == nil {
			hash = hex.EncodeToString(hasher.Sum(nil))
		}
		f.Close()
		if f2, err := h.Store.Open(r.Context(), key); err == nil {
			if cfg, _, err := image.DecodeConfig(f2); err == nil {
				width, height = cfg.Width, cfg.Height
			}
			f2.Close()
		}
	}

	asset := model.Asset{
		WorkspaceID: wsID(r), SKUID: sku.ID, Kind: "source",
		StorageKey: key, Mime: mime, SizeBytes: size, Hash: hash,
		Width: width, Height: height, Status: "uploaded",
	}
	asset.ID = assetID
	if err := h.DB.Create(&asset).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "create_failed", "登记素材失败")
		return
	}
	h.audit(r, "asset.upload", asset.ID.String(), header.Filename)
	httpx.JSON(w, http.StatusCreated, asset)
}

func (h *Handler) ListAssets(w http.ResponseWriter, r *http.Request) {
	q := h.DB.Where("workspace_id = ?", wsID(r))
	if sku := r.URL.Query().Get("sku_id"); sku != "" {
		q = q.Where("sku_id = ?", sku)
	}
	if kind := r.URL.Query().Get("kind"); kind != "" {
		q = q.Where("kind = ?", kind)
	}
	var items []model.Asset
	if err := q.Order("created_at desc").Limit(200).Find(&items).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "query_failed", "查询失败")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

// GetAssetContent 只向本租户成员返回文件内容。
func (h *Handler) GetAssetContent(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "assetID")
	if !ok {
		badRequest(w, "素材 ID 无效")
		return
	}
	var asset model.Asset
	if err := h.DB.First(&asset, "id = ? AND workspace_id = ?", id, wsID(r)).Error; err != nil {
		httpx.Err(w, http.StatusNotFound, "not_found", "资源不存在")
		return
	}
	f, err := h.Store.Open(r.Context(), asset.StorageKey)
	if err != nil {
		httpx.Err(w, http.StatusNotFound, "not_found", "文件不存在")
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", asset.Mime)
	w.Header().Set("Cache-Control", "private, max-age=300")
	w.Header().Set("Content-Disposition", "inline; filename=\""+filepath.Base(asset.StorageKey)+"\"")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, f)
}
