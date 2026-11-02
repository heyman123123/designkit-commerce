package service_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/heyman123123/designkit-commerce/apps/api/internal/config"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/model"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/platform"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/service"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/storage"
)

func TestRunnerGeneratesAsset(t *testing.T) {
	cfg := config.Config{
		DBDriver: "sqlite", DSN: fmt.Sprintf("file:q-%d?mode=memory&cache=shared", time.Now().UnixNano()),
		AutoMigrate: true, Env: "test", StorageDir: t.TempDir(),
	}
	db, err := platform.Open(cfg)
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	store, err := storage.NewLocal(cfg.StorageDir)
	if err != nil {
		t.Fatalf("store: %v", err)
	}

	ws := model.Workspace{Name: "Test", Slug: "test-ws", Plan: "free", Status: "active", SkuQuota: 5, ExportQuota: 1}
	if err := db.Create(&ws).Error; err != nil {
		t.Fatalf("ws: %v", err)
	}
	project := model.Project{WorkspaceID: ws.ID, Name: "P", Slug: "p", Platform: "amazon"}
	if err := db.Create(&project).Error; err != nil {
		t.Fatalf("project: %v", err)
	}
	sku := model.SKU{WorkspaceID: ws.ID, ProjectID: project.ID, Code: "RUN-1", Title: "Runner"}
	if err := db.Create(&sku).Error; err != nil {
		t.Fatalf("sku: %v", err)
	}
	job := model.GenerationJob{WorkspaceID: ws.ID, SKUID: sku.ID, Template: "main", Status: "queued", ReviewStatus: "pending"}
	if err := db.Create(&job).Error; err != nil {
		t.Fatalf("job: %v", err)
	}

	runner := &service.Runner{DB: db, Store: store, Provider: service.MockProvider{}}
	ctx := context.Background()
	processed, err := runner.ProcessOne(ctx)
	if err != nil || !processed {
		t.Fatalf("process: processed=%v err=%v", processed, err)
	}

	var got model.GenerationJob
	if err := db.First(&got, "id = ?", job.ID).Error; err != nil {
		t.Fatalf("reload job: %v", err)
	}
	if got.Status != "succeeded" {
		t.Fatalf("job status = %s, want succeeded (error=%s)", got.Status, got.Error)
	}
	if got.OutputAssetID == nil {
		t.Fatal("output asset id not set")
	}

	var asset model.Asset
	if err := db.First(&asset, "id = ?", *got.OutputAssetID).Error; err != nil {
		t.Fatalf("asset: %v", err)
	}
	if asset.WorkspaceID != ws.ID || asset.SKUID != sku.ID {
		t.Fatalf("asset tenant/sku mismatch: %+v", asset)
	}
	if asset.Width < 500 || asset.Height < 500 {
		t.Fatalf("output too small: %dx%d", asset.Width, asset.Height)
	}
	if got.CostCents <= 0 {
		t.Fatalf("expected cost recorded, got %d", got.CostCents)
	}

	// 队列空闲时返回 false
	processed, err = runner.ProcessOne(ctx)
	if err != nil {
		t.Fatalf("second process: %v", err)
	}
	if processed {
		t.Fatal("queue should be empty")
	}
}
