package middleware

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/auth"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/httpx"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/model"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/reqctx"
	"gorm.io/gorm"
)

type Auth struct {
	DB  *gorm.DB
	JWT *auth.Manager
}

// RequireUser 校验用户令牌，把身份写入 context。
func (a *Auth) RequireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := bearer(r)
		if raw == "" {
			httpx.Err(w, http.StatusUnauthorized, "missing_token", "缺少访问令牌")
			return
		}
		claims, err := a.JWT.Parse(raw, auth.AudienceUser)
		if err != nil {
			httpx.Err(w, http.StatusUnauthorized, "invalid_token", "令牌无效或已过期")
			return
		}
		var user model.User
		if err := a.DB.First(&user, "id = ?", claims.UserID).Error; err != nil || user.Disabled {
			httpx.Err(w, http.StatusUnauthorized, "user_unavailable", "账号不可用")
			return
		}
		ctx := reqctx.WithUser(r.Context(), user.ID)
		ctx = reqctx.WithAdmin(ctx, user.IsPlatformAdmin)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// RequireAdmin 只允许平台管理员，且必须持 admin audience 令牌。
func (a *Auth) RequireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := bearer(r)
		if raw == "" {
			httpx.Err(w, http.StatusUnauthorized, "missing_token", "缺少访问令牌")
			return
		}
		claims, err := a.JWT.Parse(raw, auth.AudienceAdmin)
		if err != nil || !claims.Admin {
			httpx.Err(w, http.StatusForbidden, "admin_required", "需要平台管理员权限")
			return
		}
		var user model.User
		if err := a.DB.First(&user, "id = ?", claims.UserID).Error; err != nil || !user.IsPlatformAdmin || user.Disabled {
			httpx.Err(w, http.StatusForbidden, "admin_required", "需要平台管理员权限")
			return
		}
		ctx := reqctx.WithUser(r.Context(), user.ID)
		ctx = reqctx.WithAdmin(ctx, true)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// Tenant 通过路径 slug 解析工作区并校验成员关系；不存在与无权访问统一返回 404。
func (a *Auth) Tenant(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		slug := chi.URLParam(r, "workspace")
		userID, ok := reqctx.UserID(r.Context())
		if !ok {
			httpx.Err(w, http.StatusUnauthorized, "missing_token", "缺少访问令牌")
			return
		}
		var ws model.Workspace
		if err := a.DB.First(&ws, "slug = ?", slug).Error; err != nil {
			httpx.Err(w, http.StatusNotFound, "not_found", "资源不存在")
			return
		}
		var member model.Member
		if err := a.DB.First(&member, "workspace_id = ? AND user_id = ?", ws.ID, userID).Error; err != nil {
			httpx.Err(w, http.StatusNotFound, "not_found", "资源不存在")
			return
		}
		ctx := reqctx.WithWorkspace(r.Context(), ws.ID, member.Role, ws.Plan)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// RequireWrite 阻止只读角色与只读租户写入。
func RequireWrite(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !reqctx.CanWrite(reqctx.Role(r.Context())) {
			httpx.Err(w, http.StatusForbidden, "read_only", "当前角色没有写入权限")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireReview 限制审核动作。
func RequireReview(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !reqctx.CanReview(reqctx.Role(r.Context())) {
			httpx.Err(w, http.StatusForbidden, "forbidden", "当前角色没有审核权限")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if strings.HasPrefix(h, "Bearer ") {
		return strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
	}
	return ""
}
