package model

import (
	"time"

	"github.com/google/uuid"
)

// 平台运营侧模型：套餐、订单、优惠码、风控、模板配置与功能开关。

// Plan 是套餐定义，租户的 plan 字段引用 plan code。
type Plan struct {
	Base
	Code        string `gorm:"uniqueIndex;size:32;not null" json:"code"`
	Name        string `gorm:"size:80;not null" json:"name"`
	PriceCents  int    `json:"price_cents"`
	PeriodDays  int    `gorm:"default:30" json:"period_days"`
	SkuQuota    int    `json:"sku_quota"`
	ExportQuota int    `json:"export_quota"`
	Features    string `gorm:"type:text" json:"features"`
	Active      bool   `gorm:"default:true" json:"active"`
	Sort        int    `gorm:"default:0" json:"sort"`
}

// Order 记录一次开通/续费/退款，金额以分为单位。
type Order struct {
	Base
	WorkspaceID uuid.UUID  `gorm:"type:uuid;index;not null" json:"workspace_id"`
	PlanCode    string     `gorm:"size:32;not null" json:"plan_code"`
	AmountCents int        `json:"amount_cents"`
	Status      string     `gorm:"size:24;default:pending" json:"status"` // pending|paid|refunded|void
	Channel     string     `gorm:"size:32;default:manual" json:"channel"` // manual|stripe|alipay|wechat
	Note        string     `gorm:"size:255" json:"note"`
	PaidAt      *time.Time `json:"paid_at"`
	CreatedBy   *uuid.UUID `gorm:"type:uuid" json:"created_by"`
}

// Coupon 优惠码，按百分比或固定金额减免。
type Coupon struct {
	Base
	Code           string     `gorm:"uniqueIndex;size:40;not null" json:"code"`
	PercentOff     int        `json:"percent_off"`
	AmountOffCents int        `json:"amount_off_cents"`
	MaxRedemptions int        `json:"max_redemptions"`
	Redeemed       int        `gorm:"default:0" json:"redeemed"`
	ExpiresAt      *time.Time `json:"expires_at"`
	Active         bool       `gorm:"default:true" json:"active"`
	Note           string     `gorm:"size:255" json:"note"`
}

// RiskCase 风控事件：投诉、侵权、滥用等。
type RiskCase struct {
	Base
	WorkspaceID *uuid.UUID `gorm:"type:uuid;index" json:"workspace_id"`
	Kind        string     `gorm:"size:40;not null" json:"kind"`           // complaint|copyright|abuse|quality|other
	Severity    string     `gorm:"size:16;default:medium" json:"severity"` // low|medium|high
	Status      string     `gorm:"size:20;default:open" json:"status"`     // open|resolved|frozen
	Detail      string     `gorm:"type:text" json:"detail"`
	Resolution  string     `gorm:"size:255" json:"resolution"`
	ResolvedAt  *time.Time `json:"resolved_at"`
}

// PlatformTemplate 生成模板配置，与 service 里的模板编码对应。
type PlatformTemplate struct {
	Base
	Code     string `gorm:"uniqueIndex;size:40;not null" json:"code"`
	Name     string `gorm:"size:80;not null" json:"name"`
	Platform string `gorm:"size:32;default:amazon" json:"platform"`
	Prompt   string `gorm:"type:text" json:"prompt"`
	Active   bool   `gorm:"default:true" json:"active"`
	Sort     int    `gorm:"default:0" json:"sort"`
}

// FeatureFlag 平台功能开关。
type FeatureFlag struct {
	Base
	Key         string `gorm:"uniqueIndex;size:60;not null" json:"key"`
	Description string `gorm:"size:255" json:"description"`
	Enabled     bool   `gorm:"default:false" json:"enabled"`
}
