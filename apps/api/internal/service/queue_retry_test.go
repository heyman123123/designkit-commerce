package service_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/heyman123123/designkit-commerce/apps/api/internal/config"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/model"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/platform"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/service"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/storage"
)

type failingProvider struct{}

func (failingProvider) Name() string { return "failing" }
func (failingProvider) Analyze(context.Context, []byte, string) (service.Analysis, error) {
	return service.Analysis{}, nil
}
func (failingProvider) Generate(context.Context, service.GenerateRequest) (service.Generated, error) {
	return service.Generated{}, errors.New("上游生成失败")
}

func retryEnv(t *testing.T) (*service.Runner, *model.GenerationJob) {
	t.Helper()
	cfg := config.Config{
		DBDriver: "sqlite", DSN: fmt.Sprintf("file:qr-%d?mode=memory&cache=shared", time.Now().UnixNano()),
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
	ws := model.Workspace{Name: "Retry", Slug: "retry-" + fmt.Sprint(time.Now().UnixNano()), Plan: "free", Status: "active", SkuQuota: 5}
	db.Create(&ws)
	project := model.Project{WorkspaceID: ws.ID, Name: "P", Slug: "p", Platform: "amazon"}
	db.Create(&project)
	sku := model.SKU{WorkspaceID: ws.ID, ProjectID: project.ID, Code: "RETRY-1"}
	db.Create(&sku)
	job := model.GenerationJob{WorkspaceID: ws.ID, SKUID: sku.ID, Template: "main", Status: "queued", ReviewStatus: "pending"}
	db.Create(&job)
	return &service.Runner{DB: db, Store: store, Provider: failingProvider{}}, &job
}

// TestQueueRetryThenDeadLetter 验证连续失败按 attempts 累积，第 3 次进入 failed 且不多算。
func TestQueueRetryThenDeadLetter(t *testing.T) {
	runner, job := retryEnv(t)
	for i := 1; i <= 3; i++ {
		// 绕过退避：把 updated_at 推到很久以前，模拟已到期。
		runner.DB.Model(&model.GenerationJob{}).Where("id = ?", job.ID).
			UpdateColumn("updated_at", time.Now().Add(-time.Hour))
		ok, err := runner.ProcessOne(context.Background())
		if err != nil {
			t.Fatalf("process %d: %v", i, err)
		}
		if !ok {
			t.Fatalf("process %d: no job claimed", i)
		}
		var cur model.GenerationJob
		runner.DB.First(&cur, "id = ?", job.ID)
		if cur.Attempts != i {
			t.Fatalf("after run %d attempts = %d", i, cur.Attempts)
		}
		if i < 3 && cur.Status != "queued" {
			t.Fatalf("run %d status = %s, want queued", i, cur.Status)
		}
		if i == 3 && cur.Status != "failed" {
			t.Fatalf("run 3 status = %s, want failed", cur.Status)
		}
	}
}

// TestQueueBackoffSkipsFreshRetry 验证退避期内不会被立刻重复认领。
func TestQueueBackoffSkipsFreshRetry(t *testing.T) {
	runner, job := retryEnv(t)
	if ok, _ := runner.ProcessOne(context.Background()); !ok {
		t.Fatal("first run should claim")
	}
	var cur model.GenerationJob
	runner.DB.First(&cur, "id = ?", job.ID)
	if cur.Attempts != 1 || cur.Status != "queued" {
		t.Fatalf("after first failure attempts=%d status=%s", cur.Attempts, cur.Status)
	}
	if ok, _ := runner.ProcessOne(context.Background()); ok {
		t.Fatal("fresh retry should be skipped by backoff")
	}
}
