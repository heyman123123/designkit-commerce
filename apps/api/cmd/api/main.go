package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/heyman123123/designkit-commerce/apps/api/internal/auth"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/config"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/handler"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/model"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/platform"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/service"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/storage"
	"gorm.io/gorm"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))
	cfg := config.Load()

	db, err := platform.Open(cfg)
	if err != nil {
		slog.Error("open database", "err", err)
		os.Exit(1)
	}

	store, err := storage.NewLocal(cfg.StorageDir)
	if err != nil {
		slog.Error("init storage", "err", err)
		os.Exit(1)
	}

	seedAdmin(cfg, db)
	if err := handler.SeedPlatform(db); err != nil {
		slog.Error("seed platform defaults", "err", err)
	}

	jwtManager := auth.NewManager(cfg.JWTSecret, cfg.AccessTTL)
	provider := service.NewProvider()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// 单机模式下 API 进程内同时跑队列；也可以单独跑 cmd/worker。
	if strings.ToLower(os.Getenv("RUN_WORKER")) != "false" {
		runner := &service.Runner{DB: db, Store: store, Provider: provider, Tick: cfg.WorkerTick}
		go runner.Start(ctx)
	}

	router := handler.NewRouter(handler.Deps{
		DB: db, Cfg: cfg, JWT: jwtManager, Store: store, Provider: provider,
	})
	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      0, // SSE 需要长连接
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		slog.Info("api listening", "addr", cfg.Addr, "env", cfg.Env, "driver", cfg.DBDriver)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("listen", "err", err)
			cancel()
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	select {
	case <-stop:
	case <-ctx.Done():
	}

	slog.Info("shutting down")
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer shutdownCancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("shutdown", "err", err)
	}
}

func seedAdmin(cfg config.Config, db *gorm.DB) {
	if cfg.AdminEmail == "" || cfg.AdminPass == "" {
		return
	}
	email := strings.ToLower(strings.TrimSpace(cfg.AdminEmail))
	var user model.User
	err := db.First(&user, "email = ?", email).Error
	if err == nil {
		if !user.IsPlatformAdmin {
			db.Model(&user).Update("is_platform_admin", true)
			slog.Info("promoted existing user to platform admin", "email", email)
		}
		return
	}
	hash, err := auth.HashPassword(cfg.AdminPass)
	if err != nil {
		slog.Error("seed admin hash", "err", err)
		return
	}
	admin := model.User{Email: email, PasswordHash: hash, Name: "Platform Admin", IsPlatformAdmin: true}
	if err := db.Create(&admin).Error; err != nil {
		slog.Error("seed admin create", "err", err)
		return
	}
	slog.Info("seeded platform admin", "email", email)
}
