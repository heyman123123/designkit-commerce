package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/heyman123123/designkit-commerce/apps/api/internal/config"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/platform"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/service"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/storage"
)

// worker 单独消费生成队列，可与 API 分进程部署。
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

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-stop
		cancel()
	}()

	runner := &service.Runner{DB: db, Store: store, Provider: service.MockProvider{}, Tick: cfg.WorkerTick}
	slog.Info("worker started", "tick", cfg.WorkerTick.String())
	runner.Start(ctx)
	slog.Info("worker stopped")
}
