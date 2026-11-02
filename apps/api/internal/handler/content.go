package handler

import (
	"net/http"

	"gorm.io/gorm"

	"github.com/google/uuid"

	"github.com/heyman123123/designkit-commerce/apps/api/internal/httpx"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/model"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/reqctx"
)

type createWorkspaceReq struct {
	Name string `json:"name"`
}

func (h *Handler) ListWorkspaces(w http.ResponseWriter, r *http.Request) {
	uid := userID(r)
	var members []model.Member
	if err := h.DB.Where("user_id = ?", uid).Find(&members).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "query_failed", "查询失败")
		return
	}
	type item struct {
		ID          string `json:"id"`
		Slug        string `json:"slug"`
		Name        string `json:"name"`
		Plan        string `json:"plan"`
		Status      string `json:"status"`
		Role        string `json:"role"`
		SkuQuota    int    `json:"sku_quota"`
		SkuUsed     int    `json:"sku_used"`
		ExportQuota int    `json:"export_quota"`
		ExportUsed  int    `json:"export_used"`
	}
	out := make([]item, 0, len(members))
	for _, m := range members {
		var ws model.Workspace
		if err := h.DB.First(&ws, "id = ?", m.WorkspaceID).Error; err != nil {
			continue
		}
		out = append(out, item{
			ID: ws.ID.String(), Slug: ws.Slug, Name: ws.Name, Plan: ws.Plan, Status: ws.Status,
			Role: m.Role, SkuQuota: ws.SkuQuota, SkuUsed: ws.SkuUsed,
			ExportQuota: ws.ExportQuota, ExportUsed: ws.ExportUsed,
		})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": out})
}

func (h *Handler) CreateWorkspace(w http.ResponseWriter, r *http.Request) {
	var req createWorkspaceReq
	if err := httpx.Decode(r, &req); err != nil || req.Name == "" {
		badRequest(w, "请填写工作区名称")
		return
	}
	uid := userID(r)
	ws := model.Workspace{
		Name: req.Name, Slug: h.uniqueSlug(slugify(req.Name)),
		Plan: "free", Status: "active", SkuQuota: 1, ExportQuota: 1, OwnerID: uid,
	}
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&ws).Error; err != nil {
			return err
		}
		if err := tx.Create(&model.Member{WorkspaceID: ws.ID, UserID: uid, Role: "owner"}).Error; err != nil {
			return err
		}
		p := model.Project{WorkspaceID: ws.ID, Name: "默认项目", Slug: "default", Platform: "amazon"}
		if err := tx.Create(&p).Error; err != nil {
			return err
		}
		return tx.Create(&model.Folder{WorkspaceID: ws.ID, ProjectID: p.ID, Name: "未分类 SKU", Kind: "sku"}).Error
	})
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "create_failed", "创建工作区失败")
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": ws.ID, "slug": ws.Slug, "name": ws.Name, "plan": ws.Plan, "role": "owner",
	})
}

// SwitchWorkspace 重新签发带目标租户的 access token，实现安全切换。
func (h *Handler) SwitchWorkspace(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "id")
	if !ok {
		badRequest(w, "工作区 ID 无效")
		return
	}
	uid := userID(r)
	var member model.Member
	if err := h.DB.First(&member, "workspace_id = ? AND user_id = ?", id, uid).Error; err != nil {
		httpx.Err(w, http.StatusNotFound, "not_found", "资源不存在")
		return
	}
	var ws model.Workspace
	if err := h.DB.First(&ws, "id = ?", id).Error; err != nil {
		httpx.Err(w, http.StatusNotFound, "not_found", "资源不存在")
		return
	}
	var user model.User
	if err := h.DB.First(&user, "id = ?", uid).Error; err != nil {
		httpx.Err(w, http.StatusUnauthorized, "user_unavailable", "账号不可用")
		return
	}
	h.issueTokens(w, user, &ws, member.Role)
}

func (h *Handler) ListMembers(w http.ResponseWriter, r *http.Request) {
	var members []model.Member
	if err := h.DB.Where("workspace_id = ?", wsID(r)).Find(&members).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "query_failed", "查询失败")
		return
	}
	type item struct {
		UserID string `json:"user_id"`
		Email  string `json:"email"`
		Name   string `json:"name"`
		Role   string `json:"role"`
	}
	out := make([]item, 0, len(members))
	for _, m := range members {
		var u model.User
		if err := h.DB.First(&u, "id = ?", m.UserID).Error; err != nil {
			continue
		}
		out = append(out, item{UserID: u.ID.String(), Email: u.Email, Name: u.Name, Role: m.Role})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": out})
}

type addMemberReq struct {
	Email string `json:"email"`
	Role  string `json:"role"`
}

func (h *Handler) AddMember(w http.ResponseWriter, r *http.Request) {
	if !reqctx.CanManage(reqctx.Role(r.Context())) {
		httpx.Err(w, http.StatusForbidden, "forbidden", "没有成员管理权限")
		return
	}
	var req addMemberReq
	if err := httpx.Decode(r, &req); err != nil || req.Email == "" {
		badRequest(w, "请填写成员邮箱")
		return
	}
	switch req.Role {
	case "admin", "editor", "reviewer", "viewer":
	default:
		badRequest(w, "角色不合法")
		return
	}
	var user model.User
	if err := h.DB.First(&user, "email = ?", req.Email).Error; err != nil {
		httpx.Err(w, http.StatusNotFound, "user_not_found", "该邮箱尚未注册")
		return
	}
	var exists int64
	h.DB.Model(&model.Member{}).Where("workspace_id = ? AND user_id = ?", wsID(r), user.ID).Count(&exists)
	if exists > 0 {
		httpx.Err(w, http.StatusConflict, "already_member", "该用户已在工作区")
		return
	}
	m := model.Member{WorkspaceID: wsID(r), UserID: user.ID, Role: req.Role}
	if err := h.DB.Create(&m).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "create_failed", "添加成员失败")
		return
	}
	h.audit(r, "member.add", user.ID.String(), req.Role)
	httpx.JSON(w, http.StatusCreated, map[string]any{"user_id": user.ID, "role": req.Role})
}

type createProjectReq struct {
	Name     string `json:"name"`
	Platform string `json:"platform"`
	Category string `json:"category"`
}

func (h *Handler) ListProjects(w http.ResponseWriter, r *http.Request) {
	var items []model.Project
	if err := h.DB.Where("workspace_id = ?", wsID(r)).Order("created_at asc").Find(&items).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "query_failed", "查询失败")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

func (h *Handler) CreateProject(w http.ResponseWriter, r *http.Request) {
	if !reqctx.CanWrite(reqctx.Role(r.Context())) {
		httpx.Err(w, http.StatusForbidden, "read_only", "当前角色没有写入权限")
		return
	}
	var req createProjectReq
	if err := httpx.Decode(r, &req); err != nil || req.Name == "" {
		badRequest(w, "请填写项目名称")
		return
	}
	if req.Platform == "" {
		req.Platform = "amazon"
	}
	p := model.Project{
		WorkspaceID: wsID(r), Name: req.Name, Slug: h.uniqueProjectSlug(req.Name, wsID(r)),
		Platform: req.Platform, Category: req.Category,
	}
	if err := h.DB.Create(&p).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "create_failed", "创建项目失败")
		return
	}
	h.audit(r, "project.create", p.ID.String(), p.Name)
	httpx.JSON(w, http.StatusCreated, p)
}

func (h *Handler) uniqueProjectSlug(name string, ws uuid.UUID) string {
	base := slugify(name)
	slug := base
	for i := 2; i < 100; i++ {
		var count int64
		h.DB.Model(&model.Project{}).Where("workspace_id = ? AND slug = ?", ws, slug).Count(&count)
		if count == 0 {
			return slug
		}
		slug = base + "-" + itoa(i)
	}
	return base + "-" + uuid.NewString()[:6]
}

type createFolderReq struct {
	ProjectID string `json:"project_id"`
	ParentID  string `json:"parent_id"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
}

func (h *Handler) CreateFolder(w http.ResponseWriter, r *http.Request) {
	if !reqctx.CanWrite(reqctx.Role(r.Context())) {
		httpx.Err(w, http.StatusForbidden, "read_only", "当前角色没有写入权限")
		return
	}
	var req createFolderReq
	if err := httpx.Decode(r, &req); err != nil || req.Name == "" || req.ProjectID == "" {
		badRequest(w, "请填写项目与文件夹名称")
		return
	}
	projectID, err := uuid.Parse(req.ProjectID)
	if err != nil {
		badRequest(w, "项目 ID 无效")
		return
	}
	var project model.Project
	if err := h.DB.First(&project, "id = ? AND workspace_id = ?", projectID, wsID(r)).Error; err != nil {
		httpx.Err(w, http.StatusNotFound, "not_found", "资源不存在")
		return
	}
	f := model.Folder{WorkspaceID: wsID(r), ProjectID: projectID, Name: req.Name, Kind: "sku"}
	if req.Kind != "" {
		f.Kind = req.Kind
	}
	if req.ParentID != "" {
		pid, err := uuid.Parse(req.ParentID)
		if err != nil {
			badRequest(w, "父文件夹 ID 无效")
			return
		}
		var parent model.Folder
		if err := h.DB.First(&parent, "id = ? AND workspace_id = ?", pid, wsID(r)).Error; err != nil {
			httpx.Err(w, http.StatusNotFound, "not_found", "资源不存在")
			return
		}
		f.ParentID = &pid
	}
	if err := h.DB.Create(&f).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "create_failed", "创建文件夹失败")
		return
	}
	httpx.JSON(w, http.StatusCreated, f)
}

func (h *Handler) ListFolders(w http.ResponseWriter, r *http.Request) {
	q := h.DB.Where("workspace_id = ?", wsID(r))
	if pid := r.URL.Query().Get("project_id"); pid != "" {
		q = q.Where("project_id = ?", pid)
	}
	var items []model.Folder
	if err := q.Order("created_at asc").Find(&items).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "query_failed", "查询失败")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

type createSKUReq struct {
	ProjectID  string `json:"project_id"`
	FolderID   string `json:"folder_id"`
	Code       string `json:"code"`
	Title      string `json:"title"`
	Attributes string `json:"attributes"`
}

func (h *Handler) ListSKUs(w http.ResponseWriter, r *http.Request) {
	q := h.DB.Where("workspace_id = ?", wsID(r))
	if pid := r.URL.Query().Get("project_id"); pid != "" {
		q = q.Where("project_id = ?", pid)
	}
	var items []model.SKU
	if err := q.Order("created_at desc").Find(&items).Error; err != nil {
		httpx.Err(w, http.StatusInternalServerError, "query_failed", "查询失败")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

func (h *Handler) CreateSKU(w http.ResponseWriter, r *http.Request) {
	if !reqctx.CanWrite(reqctx.Role(r.Context())) {
		httpx.Err(w, http.StatusForbidden, "read_only", "当前角色没有写入权限")
		return
	}
	var req createSKUReq
	if err := httpx.Decode(r, &req); err != nil || req.Code == "" || req.ProjectID == "" {
		badRequest(w, "请填写项目与 SKU 编码")
		return
	}
	projectID, err := uuid.Parse(req.ProjectID)
	if err != nil {
		badRequest(w, "项目 ID 无效")
		return
	}
	var project model.Project
	if err := h.DB.First(&project, "id = ? AND workspace_id = ?", projectID, wsID(r)).Error; err != nil {
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
	if ws.SkuUsed >= ws.SkuQuota {
		httpx.Err(w, http.StatusPaymentRequired, "quota_exceeded", "SKU 配额已用完，请升级套餐")
		return
	}

	s := model.SKU{
		WorkspaceID: wsID(r), ProjectID: projectID, Code: req.Code,
		Title: req.Title, Attributes: req.Attributes,
	}
	if req.FolderID != "" {
		fid, err := uuid.Parse(req.FolderID)
		if err != nil {
			badRequest(w, "文件夹 ID 无效")
			return
		}
		var folder model.Folder
		if err := h.DB.First(&folder, "id = ? AND workspace_id = ?", fid, wsID(r)).Error; err != nil {
			httpx.Err(w, http.StatusNotFound, "not_found", "资源不存在")
			return
		}
		s.FolderID = &fid
	}

	err = h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&s).Error; err != nil {
			return err
		}
		if err := tx.Model(&model.Workspace{}).Where("id = ?", wsID(r)).
			UpdateColumn("sku_used", gorm.Expr("sku_used + 1")).Error; err != nil {
			return err
		}
		return tx.Create(&model.UsageLedger{
			WorkspaceID: wsID(r), Event: "sku_created", Units: 1, Note: s.Code,
		}).Error
	})
	if err != nil {
		httpx.Err(w, http.StatusConflict, "create_failed", "创建 SKU 失败，编码可能已存在")
		return
	}
	h.audit(r, "sku.create", s.ID.String(), s.Code)
	httpx.JSON(w, http.StatusCreated, s)
}
