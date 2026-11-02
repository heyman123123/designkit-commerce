package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/heyman123123/designkit-commerce/apps/api/internal/model"
)

// Events 用 SSE 推送本租户任务状态变化，断线由客户端重连。
func (h *Handler) Events(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	// 统一用 UTC 比较：SQLite 里时间按 UTC 存，本地时区直接比较会漏事件。
	since := time.Now().UTC().Add(-2 * time.Minute)
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	ctx := r.Context()

	send := func() bool {
		var jobs []model.GenerationJob
		if err := h.DB.WithContext(ctx).
			Where("workspace_id = ? AND updated_at > ?", wsID(r), since).
			Order("updated_at asc").Limit(50).Find(&jobs).Error; err != nil {
			return true
		}
		for _, job := range jobs {
			payload, _ := json.Marshal(map[string]any{
				"id": job.ID, "sku_id": job.SKUID, "template": job.Template,
				"status": job.Status, "progress": job.Progress,
				"review_status": job.ReviewStatus, "error": job.Error,
			})
			fmt.Fprintf(w, "event: job\ndata: %s\n\n", payload)
			if job.UpdatedAt.After(since) {
				since = job.UpdatedAt.UTC()
			}
		}
		flusher.Flush()
		return true
	}

	send()
	for {
		select {
		case <-ctx.Done():
			return
		case tick := <-ticker.C:
			fmt.Fprintf(w, ": ping %d\n\n", tick.Unix())
			flusher.Flush()
			send()
		}
	}
}
