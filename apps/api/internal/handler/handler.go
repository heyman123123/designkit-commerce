package handler

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/auth"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/config"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/httpx"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/model"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/reqctx"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/service"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/storage"
	"gorm.io/gorm"
)

type Handler struct {
	DB       *gorm.DB
	Cfg      config.Config
	JWT      *auth.Manager
	Store    storage.Store
	Provider service.Provider
}

func wsID(r *http.Request) uuid.UUID {
	id, _ := reqctx.WorkspaceID(r.Context())
	return id
}

func userID(r *http.Request) uuid.UUID {
	id, _ := reqctx.UserID(r.Context())
	return id
}

func pathID(r *http.Request, name string) (uuid.UUID, bool) {
	id, err := uuid.Parse(chi.URLParam(r, name))
	return id, err == nil
}

func (h *Handler) audit(r *http.Request, action, target, meta string) {
	ws := wsID(r)
	uid := userID(r)
	var wsPtr *uuid.UUID
	if ws != uuid.Nil {
		wsPtr = &ws
	}
	var userPtr *uuid.UUID
	if uid != uuid.Nil {
		userPtr = &uid
	}
	_ = h.DB.Create(&model.AuditLog{
		WorkspaceID: wsPtr,
		ActorID:     userPtr,
		Action:      action,
		Target:      target,
		Meta:        meta,
		IsAdmin:     reqctx.IsAdmin(r.Context()),
	}).Error
}

func slugify(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	prevDash := false
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			prevDash = false
		default:
			if !prevDash && b.Len() > 0 {
				b.WriteByte('-')
				prevDash = true
			}
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		out = "workspace"
	}
	if len(out) > 60 {
		out = out[:60]
	}
	return out
}

func (h *Handler) uniqueSlug(base string) string {
	slug := base
	for i := 2; i < 100; i++ {
		var count int64
		h.DB.Model(&model.Workspace{}).Where("slug = ?", slug).Count(&count)
		if count == 0 {
			return slug
		}
		slug = base + "-" + itoa(i)
	}
	return base + "-" + uuid.NewString()[:6]
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var digits []byte
	for i > 0 {
		digits = append([]byte{byte('0' + i%10)}, digits...)
		i /= 10
	}
	return string(digits)
}

func badRequest(w http.ResponseWriter, msg string) {
	httpx.Err(w, http.StatusBadRequest, "bad_request", msg)
}
