package service

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/model"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/storage"
	"gorm.io/gorm"
)

const maxAttempts = 3

type Runner struct {
	DB       *gorm.DB
	Store    storage.Store
	Provider Provider
	Tick     time.Duration
	Logger   *slog.Logger
}

// Start 阻塞运行队列循环，直到 ctx 取消。
func (r *Runner) Start(ctx context.Context) {
	tick := r.Tick
	if tick <= 0 {
		tick = 2 * time.Second
	}
	ticker := time.NewTicker(tick)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			for i := 0; i < 4; i++ {
				processed, err := r.ProcessOne(ctx)
				if err != nil {
					r.logger().Error("queue process", "err", err)
					break
				}
				if !processed {
					break
				}
			}
		}
	}
}

func (r *Runner) logger() *slog.Logger {
	if r.Logger != nil {
		return r.Logger
	}
	return slog.Default()
}

// ProcessOne 认领一个排队任务并执行；没有任务时返回 false。
func (r *Runner) ProcessOne(ctx context.Context) (bool, error) {
	var job model.GenerationJob
	err := r.DB.WithContext(ctx).
		Where("status = ?", "queued").
		Order("created_at asc").
		First(&job).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}

	res := r.DB.WithContext(ctx).Model(&model.GenerationJob{}).
		Where("id = ? AND status = ?", job.ID, "queued").
		Updates(map[string]any{"status": "running", "progress": 20, "attempts": job.Attempts + 1})
	if res.Error != nil {
		return false, res.Error
	}
	if res.RowsAffected == 0 {
		return true, nil // 已被其他 worker 认领
	}

	if err := r.execute(ctx, &job); err != nil {
		r.fail(ctx, &job, err)
		return true, nil
	}
	return true, nil
}

func (r *Runner) execute(ctx context.Context, job *model.GenerationJob) error {
	var sku model.SKU
	if err := r.DB.WithContext(ctx).First(&sku, "id = ? AND workspace_id = ?", job.SKUID, job.WorkspaceID).Error; err != nil {
		return err
	}

	var sourceBytes []byte
	mime := "image/png"
	if job.SourceAssetID != nil {
		var src model.Asset
		if err := r.DB.WithContext(ctx).First(&src, "id = ? AND workspace_id = ?", *job.SourceAssetID, job.WorkspaceID).Error; err == nil {
			mime = src.Mime
			if f, err := r.Store.Open(ctx, src.StorageKey); err == nil {
				defer f.Close()
				buf := new(bytes.Buffer)
				_, _ = buf.ReadFrom(f)
				sourceBytes = buf.Bytes()
			}
		}
	}

	analysis, err := r.Provider.Analyze(ctx, sourceBytes, mime)
	if err != nil {
		return err
	}
	_ = analysis

	r.DB.WithContext(ctx).Model(&model.GenerationJob{}).Where("id = ?", job.ID).Update("progress", 55)

	gen, err := r.Provider.Generate(ctx, GenerateRequest{
		Template:    job.Template,
		SKUCode:     sku.Code,
		SourceBytes: sourceBytes,
		SourceMime:  mime,
		Width:       1000,
		Height:      1000,
	})
	if err != nil {
		return err
	}

	key := objectKey(job.WorkspaceID, sku.Code, job.ID, job.Template)
	if _, err := r.Store.Save(ctx, key, bytes.NewReader(gen.Bytes)); err != nil {
		return err
	}

	status := "qc_passed"
	if gen.Width < 500 || gen.Height < 500 {
		status = "qc_rejected"
	}

	asset := model.Asset{
		WorkspaceID: job.WorkspaceID,
		SKUID:       job.SKUID,
		Kind:        "output",
		StorageKey:  key,
		Mime:        gen.Mime,
		SizeBytes:   int64(len(gen.Bytes)),
		Width:       gen.Width,
		Height:      gen.Height,
		Status:      status,
	}
	if err := r.DB.WithContext(ctx).Create(&asset).Error; err != nil {
		return err
	}

	return r.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&model.GenerationJob{}).Where("id = ?", job.ID).
			Updates(map[string]any{
				"status":          "succeeded",
				"progress":        100,
				"output_asset_id": asset.ID,
				"cost_cents":      gen.CostCents,
				"review_status":   "pending",
				"error":           "",
			}).Error; err != nil {
			return err
		}
		// 生成成本进入不可变流水，后台成本看板以此对账。
		return tx.Create(&model.UsageLedger{
			WorkspaceID: job.WorkspaceID,
			Event:       "generation",
			Units:       1,
			CostCents:   gen.CostCents,
			JobID:       &job.ID,
			Note:        job.Template,
		}).Error
	})
}

func (r *Runner) fail(ctx context.Context, job *model.GenerationJob, cause error) {
	attempts := job.Attempts + 1
	msg := cause.Error()
	if len(msg) > 200 {
		msg = msg[:200]
	}
	status := "queued"
	if attempts >= maxAttempts {
		status = "failed"
	}
	err := r.DB.WithContext(ctx).Model(&model.GenerationJob{}).Where("id = ?", job.ID).
		Updates(map[string]any{"status": status, "error": msg, "progress": 0}).Error
	if err != nil {
		r.logger().Error("mark job failed", "job", job.ID, "err", err)
	}
}

func objectKey(ws uuid.UUID, skuCode string, jobID uuid.UUID, template string) string {
	return "ws/" + ws.String() + "/sku/" + skuCode + "/gen/" + jobID.String() + "-" + template + ".png"
}
