package model

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// 基础：所有业务表都带 WorkspaceID，读写由仓储/处理器强制注入作用域。

type Base struct {
	ID        uuid.UUID      `gorm:"type:uuid;primaryKey" json:"id"`
	CreatedAt time.Time      `json:"created_at"`
	UpdatedAt time.Time      `json:"updated_at"`
	DeletedAt gorm.DeletedAt `gorm:"index" json:"-"`
}

func (b *Base) BeforeCreate(tx *gorm.DB) error {
	if b.ID == uuid.Nil {
		b.ID = uuid.New()
	}
	return nil
}

type User struct {
	Base
	Email           string `gorm:"uniqueIndex;size:191;not null" json:"email"`
	PasswordHash    string `gorm:"not null" json:"-"`
	Name            string `json:"name"`
	IsPlatformAdmin bool   `gorm:"default:false" json:"is_platform_admin"`
	Disabled        bool   `gorm:"default:false" json:"disabled"`
}

type Workspace struct {
	Base
	Name        string     `gorm:"size:120;not null" json:"name"`
	Slug        string     `gorm:"uniqueIndex;size:80;not null" json:"slug"`
	Plan        string     `gorm:"size:32;default:free" json:"plan"`     // free|starter|growth|pro
	Status      string     `gorm:"size:32;default:active" json:"status"` // active|readonly|suspended|deleted
	SkuQuota    int        `gorm:"default:1" json:"sku_quota"`
	ExportQuota int        `gorm:"default:0" json:"export_quota"`
	SkuUsed     int        `gorm:"default:0" json:"sku_used"`
	ExportUsed  int        `gorm:"default:0" json:"export_used"`
	TrialEndsAt *time.Time `json:"trial_ends_at"`
	OwnerID     uuid.UUID  `gorm:"type:uuid;index" json:"owner_id"`
}

type Member struct {
	Base
	WorkspaceID uuid.UUID `gorm:"type:uuid;index:idx_member_ws_user,unique;not null" json:"workspace_id"`
	UserID      uuid.UUID `gorm:"type:uuid;index:idx_member_ws_user,unique;not null" json:"user_id"`
	Role        string    `gorm:"size:32;default:viewer" json:"role"` // owner|admin|editor|reviewer|viewer
}

type Project struct {
	Base
	WorkspaceID uuid.UUID `gorm:"type:uuid;index:idx_project_ws_slug,unique;not null" json:"workspace_id"`
	Name        string    `gorm:"size:160;not null" json:"name"`
	Slug        string    `gorm:"size:80;index:idx_project_ws_slug,unique;not null" json:"slug"`
	Platform    string    `gorm:"size:32;default:amazon" json:"platform"`
	Category    string    `gorm:"size:80" json:"category"`
}

type Folder struct {
	Base
	WorkspaceID uuid.UUID  `gorm:"type:uuid;index;not null" json:"workspace_id"`
	ProjectID   uuid.UUID  `gorm:"type:uuid;index;not null" json:"project_id"`
	ParentID    *uuid.UUID `gorm:"type:uuid;index" json:"parent_id"`
	Name        string     `gorm:"size:120;not null" json:"name"`
	Kind        string     `gorm:"size:32;default:sku" json:"kind"` // sku|batch
}

type SKU struct {
	Base
	WorkspaceID uuid.UUID  `gorm:"type:uuid;index:idx_sku_ws_code,unique;not null" json:"workspace_id"`
	ProjectID   uuid.UUID  `gorm:"type:uuid;index;not null" json:"project_id"`
	FolderID    *uuid.UUID `gorm:"type:uuid;index" json:"folder_id"`
	Code        string     `gorm:"size:80;index:idx_sku_ws_code,unique;not null" json:"code"`
	Title       string     `gorm:"size:200" json:"title"`
	Attributes  string     `gorm:"type:text" json:"attributes"` // JSON 字符串
}

type Asset struct {
	Base
	WorkspaceID uuid.UUID `gorm:"type:uuid;index;not null" json:"workspace_id"`
	SKUID       uuid.UUID `gorm:"column:sku_id;type:uuid;index;not null" json:"sku_id"`
	Kind        string    `gorm:"size:32;default:source" json:"kind"` // source|output
	StorageKey  string    `gorm:"size:255;not null" json:"storage_key"`
	Mime        string    `gorm:"size:80" json:"mime"`
	SizeBytes   int64     `json:"size_bytes"`
	Hash        string    `gorm:"size:64;index" json:"hash"`
	Width       int       `json:"width"`
	Height      int       `json:"height"`
	Status      string    `gorm:"size:32;default:uploaded" json:"status"` // uploaded|analyzed|generated|qc_passed|qc_rejected|frozen
	QCScore     int       `gorm:"default:0" json:"qc_score"`
	QCIssues    string    `gorm:"type:text" json:"qc_issues"` // JSON 数组
}

type GenerationJob struct {
	Base
	WorkspaceID    uuid.UUID  `gorm:"type:uuid;index;uniqueIndex:idx_job_idem,priority:1;not null" json:"workspace_id"`
	SKUID          uuid.UUID  `gorm:"column:sku_id;type:uuid;index;not null" json:"sku_id"`
	SourceAssetID  *uuid.UUID `gorm:"type:uuid" json:"source_asset_id"`
	Template       string     `gorm:"size:40;not null" json:"template"` // main|scene|selling_point
	Status         string     `gorm:"size:32;default:queued;index" json:"status"`
	Progress       int        `gorm:"default:0" json:"progress"`
	Error          string     `gorm:"size:255" json:"error"`
	IdempotencyKey *string    `gorm:"size:120;uniqueIndex:idx_job_idem,priority:2" json:"idempotency_key"`
	Attempts       int        `gorm:"default:0" json:"attempts"`
	CostCents      int        `gorm:"default:0" json:"cost_cents"`
	OutputAssetID  *uuid.UUID `gorm:"type:uuid" json:"output_asset_id"`
	ReviewStatus   string     `gorm:"size:32;default:pending" json:"review_status"` // pending|approved|rejected|manual
	ReviewReason   string     `gorm:"size:255" json:"review_reason"`
}

type UsageLedger struct {
	Base
	WorkspaceID uuid.UUID  `gorm:"type:uuid;index;not null" json:"workspace_id"`
	Event       string     `gorm:"size:48;not null" json:"event"` // sku_created|export|generation
	Units       int        `json:"units"`
	CostCents   int        `json:"cost_cents"`
	JobID       *uuid.UUID `gorm:"type:uuid" json:"job_id"`
	Note        string     `gorm:"size:255" json:"note"`
}

type AuditLog struct {
	Base
	WorkspaceID *uuid.UUID `gorm:"type:uuid;index" json:"workspace_id"`
	ActorID     *uuid.UUID `gorm:"type:uuid;index" json:"actor_id"`
	Action      string     `gorm:"size:80;not null" json:"action"`
	Target      string     `gorm:"size:120" json:"target"`
	Meta        string     `gorm:"type:text" json:"meta"`
	IsAdmin     bool       `gorm:"default:false" json:"is_admin"`
}

type RefreshToken struct {
	Base
	UserID    uuid.UUID `gorm:"type:uuid;index;not null" json:"user_id"`
	TokenHash string    `gorm:"size:128;uniqueIndex;not null" json:"-"`
	ExpiresAt time.Time `json:"expires_at"`
	Revoked   bool      `gorm:"default:false" json:"revoked"`
}

// VersionMark 记录某个 SKU 某个模板下当前选中的版本（审核通过或手工指定）。
type VersionMark struct {
	Base
	WorkspaceID uuid.UUID `gorm:"type:uuid;index:idx_vmark,priority:1;not null" json:"workspace_id"`
	SKUID       uuid.UUID `gorm:"column:sku_id;type:uuid;index:idx_vmark,priority:2;not null" json:"sku_id"`
	Template    string    `gorm:"size:40;index:idx_vmark,priority:3;not null" json:"template"`
	JobID       uuid.UUID `gorm:"column:job_id;type:uuid;index:idx_vmark,priority:4;unique;not null" json:"job_id"`
	IsCurrent   bool      `gorm:"default:false" json:"is_current"`
}

// All 返回参与自动迁移的模型。
func All() []any {
	return []any{
		&User{}, &Workspace{}, &Member{}, &Project{}, &Folder{}, &SKU{},
		&Asset{}, &GenerationJob{}, &UsageLedger{}, &AuditLog{}, &RefreshToken{}, &VersionMark{},
	}
}
