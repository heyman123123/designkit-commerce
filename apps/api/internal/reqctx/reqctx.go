package reqctx

import (
	"context"

	"github.com/google/uuid"
)

type ctxKey int

const (
	keyUser ctxKey = iota
	keyWorkspace
	keyRole
	keyPlan
	keyAdmin
)

type Identity struct {
	UserID uuid.UUID
	Role   string
}

func WithUser(ctx context.Context, userID uuid.UUID) context.Context {
	return context.WithValue(ctx, keyUser, userID)
}

func UserID(ctx context.Context) (uuid.UUID, bool) {
	v, ok := ctx.Value(keyUser).(uuid.UUID)
	return v, ok
}

func WithWorkspace(ctx context.Context, id uuid.UUID, role, plan string) context.Context {
	ctx = context.WithValue(ctx, keyWorkspace, id)
	ctx = context.WithValue(ctx, keyRole, role)
	ctx = context.WithValue(ctx, keyPlan, plan)
	return ctx
}

func WorkspaceID(ctx context.Context) (uuid.UUID, bool) {
	v, ok := ctx.Value(keyWorkspace).(uuid.UUID)
	return v, ok
}

func Role(ctx context.Context) string {
	v, _ := ctx.Value(keyRole).(string)
	return v
}

func Plan(ctx context.Context) string {
	v, _ := ctx.Value(keyPlan).(string)
	return v
}

func WithAdmin(ctx context.Context, admin bool) context.Context {
	return context.WithValue(ctx, keyAdmin, admin)
}

func IsAdmin(ctx context.Context) bool {
	v, _ := ctx.Value(keyAdmin).(bool)
	return v
}

// CanWrite 判断角色是否可写业务数据。
func CanWrite(role string) bool {
	switch role {
	case "owner", "admin", "editor":
		return true
	}
	return false
}

// CanReview 判断角色是否可审核。
func CanReview(role string) bool {
	switch role {
	case "owner", "admin", "editor", "reviewer":
		return true
	}
	return false
}

// CanManage 判断角色是否可管理成员与计费。
func CanManage(role string) bool {
	switch role {
	case "owner", "admin":
		return true
	}
	return false
}
