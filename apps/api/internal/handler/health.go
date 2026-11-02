package handler

import (
	"encoding/json"
	"net/http"

	"github.com/heyman123123/designkit-commerce/apps/api/internal/httpx"
)

func mapToJSON(m map[string]any) string {
	b, err := json.Marshal(m)
	if err != nil {
		return ""
	}
	return string(b)
}

// Healthz 区分数据库与存储状态，便于探针与运维判断。
func (h *Handler) Healthz(w http.ResponseWriter, r *http.Request) {
	dbOK := true
	if sqlDB, err := h.DB.DB(); err != nil {
		dbOK = false
	} else if err := sqlDB.PingContext(r.Context()); err != nil {
		dbOK = false
	}
	status := http.StatusOK
	if !dbOK {
		status = http.StatusServiceUnavailable
	}
	httpx.JSON(w, status, map[string]any{
		"status":  map[bool]string{true: "ok", false: "degraded"}[dbOK],
		"db":      dbOK,
		"queue":   "polling",
		"version": "0.1.0",
	})
}
