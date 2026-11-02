package handler

import (
	"net/http"
	"regexp"
	"strings"
	"time"

	"gorm.io/gorm"

	"github.com/google/uuid"

	"github.com/heyman123123/designkit-commerce/apps/api/internal/auth"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/httpx"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/model"
)

var emailRe = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)

type registerReq struct {
	Email         string `json:"email"`
	Password      string `json:"password"`
	Name          string `json:"name"`
	WorkspaceName string `json:"workspace_name"`
}

type loginReq struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type refreshReq struct {
	RefreshToken string `json:"refresh_token"`
}

type tokenResp struct {
	AccessToken  string   `json:"access_token"`
	RefreshToken string   `json:"refresh_token"`
	ExpiresIn    int      `json:"expires_in"`
	User         userView `json:"user"`
	Workspace    *wsView  `json:"workspace,omitempty"`
}

type userView struct {
	ID              string `json:"id"`
	Email           string `json:"email"`
	Name            string `json:"name"`
	IsPlatformAdmin bool   `json:"is_platform_admin"`
}

type wsView struct {
	ID          string `json:"id"`
	Slug        string `json:"slug"`
	Name        string `json:"name"`
	Plan        string `json:"plan"`
	Status      string `json:"status"`
	Role        string `json:"role"`
	SkuQuota    int    `json:"sku_quota"`
	SkuUsed     int    `json:"sku_used"`
	ExportQuota int    `json:"export_quota"`
}

// Register 创建账号、默认工作区、默认项目与文件夹，并直接登录。
func (h *Handler) Register(w http.ResponseWriter, r *http.Request) {
	var req registerReq
	if err := httpx.Decode(r, &req); err != nil {
		badRequest(w, "请求体格式不正确")
		return
	}
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	if !emailRe.MatchString(req.Email) {
		badRequest(w, "邮箱格式不正确")
		return
	}
	if len(req.Password) < 8 {
		badRequest(w, "密码至少 8 位")
		return
	}
	if req.WorkspaceName == "" {
		req.WorkspaceName = "我的工作区"
	}

	var exists int64
	h.DB.Model(&model.User{}).Where("email = ?", req.Email).Count(&exists)
	if exists > 0 {
		httpx.Err(w, http.StatusConflict, "email_taken", "该邮箱已注册")
		return
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "hash_failed", "服务器内部错误")
		return
	}

	user := model.User{Email: req.Email, PasswordHash: hash, Name: req.Name}
	ws := model.Workspace{
		Name:        req.WorkspaceName,
		Slug:        h.uniqueSlug(slugify(req.WorkspaceName)),
		Plan:        "free",
		Status:      "active",
		SkuQuota:    1,
		ExportQuota: 1,
	}

	err = h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&user).Error; err != nil {
			return err
		}
		ws.OwnerID = user.ID
		if err := tx.Create(&ws).Error; err != nil {
			return err
		}
		if err := tx.Create(&model.Member{WorkspaceID: ws.ID, UserID: user.ID, Role: "owner"}).Error; err != nil {
			return err
		}
		project := model.Project{
			WorkspaceID: ws.ID,
			Name:        "默认项目",
			Slug:        "default",
			Platform:    "amazon",
			Category:    "",
		}
		if err := tx.Create(&project).Error; err != nil {
			return err
		}
		return tx.Create(&model.Folder{
			WorkspaceID: ws.ID,
			ProjectID:   project.ID,
			Name:        "未分类 SKU",
			Kind:        "sku",
		}).Error
	})
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "register_failed", "注册失败")
		return
	}

	h.issueTokens(w, user, &ws, "owner")
}

func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	var req loginReq
	if err := httpx.Decode(r, &req); err != nil {
		badRequest(w, "请求体格式不正确")
		return
	}
	var user model.User
	if err := h.DB.First(&user, "email = ?", strings.ToLower(strings.TrimSpace(req.Email))).Error; err != nil {
		httpx.Err(w, http.StatusUnauthorized, "invalid_credentials", "邮箱或密码不正确")
		return
	}
	if err := auth.VerifyPassword(user.PasswordHash, req.Password); err != nil {
		httpx.Err(w, http.StatusUnauthorized, "invalid_credentials", "邮箱或密码不正确")
		return
	}
	if user.Disabled {
		httpx.Err(w, http.StatusForbidden, "user_disabled", "账号已停用")
		return
	}

	var member model.Member
	var ws model.Workspace
	hasWS := h.DB.First(&member, "user_id = ?", user.ID).Error == nil
	if hasWS {
		if err := h.DB.First(&ws, "id = ?", member.WorkspaceID).Error; err != nil {
			hasWS = false
		}
	}
	if hasWS {
		h.issueTokens(w, user, &ws, member.Role)
		return
	}
	h.issueTokens(w, user, nil, "")
}

func (h *Handler) Refresh(w http.ResponseWriter, r *http.Request) {
	var req refreshReq
	if err := httpx.Decode(r, &req); err != nil || req.RefreshToken == "" {
		badRequest(w, "缺少 refresh_token")
		return
	}
	hash := auth.HashRefreshToken(req.RefreshToken)
	var rt model.RefreshToken
	if err := h.DB.First(&rt, "token_hash = ?", hash).Error; err != nil {
		httpx.Err(w, http.StatusUnauthorized, "invalid_refresh", "刷新令牌无效")
		return
	}
	if rt.Revoked || time.Now().After(rt.ExpiresAt) {
		httpx.Err(w, http.StatusUnauthorized, "invalid_refresh", "刷新令牌已失效")
		return
	}
	if err := h.DB.Model(&model.RefreshToken{}).Where("id = ?", rt.ID).Update("revoked", true).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "refresh_failed", "刷新失败")
		return
	}
	var user model.User
	if err := h.DB.First(&user, "id = ?", rt.UserID).Error; err != nil {
		httpx.Err(w, http.StatusUnauthorized, "invalid_refresh", "刷新令牌无效")
		return
	}
	var member model.Member
	var ws model.Workspace
	if h.DB.First(&member, "user_id = ?", user.ID).Error == nil &&
		h.DB.First(&ws, "id = ?", member.WorkspaceID).Error == nil {
		h.issueTokens(w, user, &ws, member.Role)
		return
	}
	h.issueTokens(w, user, nil, "")
}

func (h *Handler) Me(w http.ResponseWriter, r *http.Request) {
	var user model.User
	if err := h.DB.First(&user, "id = ?", userID(r)).Error; err != nil {
		httpx.Err(w, http.StatusNotFound, "not_found", "用户不存在")
		return
	}
	httpx.JSON(w, http.StatusOK, userView{
		ID: user.ID.String(), Email: user.Email, Name: user.Name, IsPlatformAdmin: user.IsPlatformAdmin,
	})
}

func (h *Handler) issueTokens(w http.ResponseWriter, user model.User, ws *model.Workspace, role string) {
	var wsUUID uuid.UUID
	plan := ""
	if ws != nil {
		wsUUID = ws.ID
		plan = ws.Plan
	}
	access, err := h.JWT.IssueUser(user.ID, wsUUID, role, plan, user.IsPlatformAdmin)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "token_failed", "签发令牌失败")
		return
	}
	plain, hash, err := auth.NewRefreshToken()
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "token_failed", "签发令牌失败")
		return
	}
	rt := model.RefreshToken{UserID: user.ID, TokenHash: hash, ExpiresAt: time.Now().Add(h.Cfg.RefreshTTL)}
	if err := h.DB.Create(&rt).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "token_failed", "保存刷新令牌失败")
		return
	}
	resp := tokenResp{
		AccessToken:  access,
		RefreshToken: plain,
		ExpiresIn:    int(h.Cfg.AccessTTL.Seconds()),
		User: userView{
			ID: user.ID.String(), Email: user.Email, Name: user.Name, IsPlatformAdmin: user.IsPlatformAdmin,
		},
	}
	if ws != nil {
		resp.Workspace = &wsView{
			ID: ws.ID.String(), Slug: ws.Slug, Name: ws.Name, Plan: ws.Plan,
			Status: ws.Status, Role: role, SkuQuota: ws.SkuQuota, SkuUsed: ws.SkuUsed,
			ExportQuota: ws.ExportQuota,
		}
	}
	httpx.JSON(w, http.StatusOK, resp)
}

// AdminLogin 供平台后台使用，签发 admin audience 令牌。
func (h *Handler) AdminLogin(w http.ResponseWriter, r *http.Request) {
	var req loginReq
	if err := httpx.Decode(r, &req); err != nil {
		badRequest(w, "请求体格式不正确")
		return
	}
	var user model.User
	if err := h.DB.First(&user, "email = ?", strings.ToLower(strings.TrimSpace(req.Email))).Error; err != nil {
		httpx.Err(w, http.StatusUnauthorized, "invalid_credentials", "邮箱或密码不正确")
		return
	}
	if err := auth.VerifyPassword(user.PasswordHash, req.Password); err != nil {
		httpx.Err(w, http.StatusUnauthorized, "invalid_credentials", "邮箱或密码不正确")
		return
	}
	if !user.IsPlatformAdmin || user.Disabled {
		httpx.Err(w, http.StatusForbidden, "admin_required", "需要平台管理员权限")
		return
	}
	access, err := h.JWT.IssueUser(user.ID, uuid.Nil, "platform_admin", "", true)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "token_failed", "签发令牌失败")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"access_token": access,
		"expires_in":   int(h.Cfg.AccessTTL.Seconds()),
		"user": userView{
			ID: user.ID.String(), Email: user.Email, Name: user.Name, IsPlatformAdmin: true,
		},
	})
}
