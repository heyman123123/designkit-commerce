package platform

import (
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/config"
	"github.com/heyman123123/designkit-commerce/apps/api/internal/model"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// Open 建立 GORM 连接。生产用 Postgres，测试与本地默认 SQLite。
func Open(cfg config.Config) (*gorm.DB, error) {
	level := logger.Warn
	if cfg.Env == "dev" {
		level = logger.Info
	}

	gcfg := &gorm.Config{
		Logger:                 logger.Default.LogMode(level),
		SkipDefaultTransaction: true,
		NowFunc:                func() time.Time { return time.Now().UTC() },
	}

	var dialector gorm.Dialector
	switch cfg.DBDriver {
	case "postgres":
		dialector = postgres.Open(cfg.DSN)
	case "sqlite":
		if err := os.MkdirAll("./data", 0o755); err != nil && cfg.DSN != ":memory:" {
			slog.Warn("create data dir", "err", err)
		}
		dialector = sqlite.Open(cfg.DSN)
	default:
		return nil, fmt.Errorf("unsupported DB_DRIVER %q", cfg.DBDriver)
	}

	db, err := gorm.Open(dialector, gcfg)
	if err != nil {
		return nil, err
	}

	if cfg.AutoMigrate {
		if err := db.AutoMigrate(model.All()...); err != nil {
			return nil, fmt.Errorf("automigrate: %w", err)
		}
	}
	return db, nil
}

// Scope 返回强制租户过滤的查询入口。
func Scope(db *gorm.DB, workspaceID any) *gorm.DB {
	return db.Where("workspace_id = ?", workspaceID)
}
