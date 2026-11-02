-- 平台运营：套餐、订单、优惠码、风控、模板配置与功能开关。
CREATE TABLE IF NOT EXISTS plans (
    id UUID PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    code VARCHAR(32) NOT NULL UNIQUE,
    name VARCHAR(80) NOT NULL,
    price_cents INTEGER NOT NULL DEFAULT 0,
    period_days INTEGER NOT NULL DEFAULT 30,
    sku_quota INTEGER NOT NULL DEFAULT 0,
    export_quota INTEGER NOT NULL DEFAULT 0,
    features TEXT,
    active BOOLEAN NOT NULL DEFAULT true,
    sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    plan_code VARCHAR(32) NOT NULL,
    amount_cents INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(24) NOT NULL DEFAULT 'pending',
    channel VARCHAR(32) NOT NULL DEFAULT 'manual',
    note VARCHAR(255),
    paid_at TIMESTAMPTZ,
    created_by UUID
);
CREATE INDEX IF NOT EXISTS idx_orders_ws ON orders(workspace_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS coupons (
    id UUID PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    code VARCHAR(40) NOT NULL UNIQUE,
    percent_off INTEGER NOT NULL DEFAULT 0,
    amount_off_cents INTEGER NOT NULL DEFAULT 0,
    max_redemptions INTEGER NOT NULL DEFAULT 0,
    redeemed INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ,
    active BOOLEAN NOT NULL DEFAULT true,
    note VARCHAR(255)
);

CREATE TABLE IF NOT EXISTS risk_cases (
    id UUID PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
    kind VARCHAR(40) NOT NULL,
    severity VARCHAR(16) NOT NULL DEFAULT 'medium',
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    detail TEXT,
    resolution VARCHAR(255),
    resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_risk_status ON risk_cases(status);

CREATE TABLE IF NOT EXISTS platform_templates (
    id UUID PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    code VARCHAR(40) NOT NULL UNIQUE,
    name VARCHAR(80) NOT NULL,
    platform VARCHAR(32) NOT NULL DEFAULT 'amazon',
    prompt TEXT,
    active BOOLEAN NOT NULL DEFAULT true,
    sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS feature_flags (
    id UUID PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    key VARCHAR(60) NOT NULL UNIQUE,
    description VARCHAR(255),
    enabled BOOLEAN NOT NULL DEFAULT false
);
