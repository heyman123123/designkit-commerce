package handler

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/auth"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/config"
	httpmw "github.com/heyman123123/designkit-commerce/apps/api/internal/middleware"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/service"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/storage"
	"gorm.io/gorm"
)

// Deps 汇集路由需要的依赖。
type Deps struct {
	DB       *gorm.DB
	Cfg      config.Config
	JWT      *auth.Manager
	Store    storage.Store
	Provider service.Provider
}

func NewRouter(d Deps) http.Handler {
	h := &Handler{DB: d.DB, Cfg: d.Cfg, JWT: d.JWT, Store: d.Store, Provider: d.Provider}
	mw := &httpmw.Auth{DB: d.DB, JWT: d.JWT}

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(60 * time.Second))

	r.Get("/healthz", h.Healthz)

	r.Route("/v1", func(r chi.Router) {
		r.Post("/auth/register", h.Register)
		r.Post("/auth/login", h.Login)
		r.Post("/auth/refresh", h.Refresh)
		r.Post("/admin/auth/login", h.AdminLogin)

		r.Group(func(r chi.Router) {
			r.Use(mw.RequireUser)
			r.Get("/auth/me", h.Me)
			r.Get("/workspaces", h.ListWorkspaces)
			r.Post("/workspaces", h.CreateWorkspace)
			r.Post("/workspaces/{id}/switch", h.SwitchWorkspace)
		})

		// 租户作用域：所有业务接口都必须经由 Tenant 中间件。
		r.Route("/w/{workspace}", func(r chi.Router) {
			r.Use(mw.RequireUser)
			r.Use(mw.Tenant)

			r.Get("/events", h.Events)
			r.Get("/usage", h.Usage)
			r.Get("/members", h.ListMembers)
			r.With(httpmw.RequireWrite).Post("/members", h.AddMember)

			r.Get("/projects", h.ListProjects)
			r.With(httpmw.RequireWrite).Post("/projects", h.CreateProject)
			r.Get("/folders", h.ListFolders)
			r.With(httpmw.RequireWrite).Post("/folders", h.CreateFolder)
			r.Get("/skus", h.ListSKUs)
			r.With(httpmw.RequireWrite).Post("/skus", h.CreateSKU)

			r.Get("/assets", h.ListAssets)
			r.With(httpmw.RequireWrite).Post("/skus/{skuID}/assets", h.UploadAsset)
			r.With(httpmw.RequireWrite).Get("/skus/{skuID}/presign", h.Presign)
			r.Get("/assets/{assetID}/content", h.GetAssetContent)
			r.With(httpmw.RequireWrite).Get("/skus/{skuID}/export", h.ExportSKU)

			r.Get("/jobs", h.ListJobs)
			r.With(httpmw.RequireWrite).Post("/jobs", h.CreateJob)
			r.Get("/jobs/{jobID}", h.GetJob)
			r.With(httpmw.RequireReview).Post("/jobs/{jobID}/review", h.ReviewJob)
		})

		// 平台后台：独立 audience，租户令牌无法访问。
		r.Route("/admin", func(r chi.Router) {
			r.Use(mw.RequireAdmin)
			r.Get("/tenants", h.AdminListTenants)
			r.Get("/tenants/{tenantID}", h.AdminGetTenant)
			r.Patch("/tenants/{tenantID}", h.AdminPatchTenant)
			r.Post("/tenants/{tenantID}/suspend", h.AdminSuspendTenant)
			r.Get("/jobs/failed", h.AdminFailedJobs)
			r.Post("/jobs/{jobID}/retry", h.AdminRetryJob)
			r.Get("/usage", h.AdminUsage)
			r.Get("/audit", h.AdminAudit)
		})
	})

	return r
}
