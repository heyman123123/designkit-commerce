-- 生产 schema（Postgres）。本地开发可直接 AutoMigrate，生产请走 golang-migrate。
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    email text NOT NULL,
    password_hash text NOT NULL,
    name text,
    is_platform_admin boolean NOT NULL DEFAULT false,
    disabled boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS workspaces (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    name text NOT NULL,
    slug text NOT NULL,
    plan text NOT NULL DEFAULT 'free',
    status text NOT NULL DEFAULT 'active',
    sku_quota int NOT NULL DEFAULT 1,
    export_quota int NOT NULL DEFAULT 0,
    sku_used int NOT NULL DEFAULT 0,
    export_used int NOT NULL DEFAULT 0,
    trial_ends_at timestamptz,
    owner_id uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces (slug) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    user_id uuid NOT NULL REFERENCES users(id),
    role text NOT NULL DEFAULT 'viewer'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_member_ws_user ON members (workspace_id, user_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS projects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    name text NOT NULL,
    slug text NOT NULL,
    platform text NOT NULL DEFAULT 'amazon',
    category text
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_ws_slug ON projects (workspace_id, slug) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS folders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    project_id uuid NOT NULL REFERENCES projects(id),
    parent_id uuid REFERENCES folders(id),
    name text NOT NULL,
    kind text NOT NULL DEFAULT 'sku'
);
CREATE INDEX IF NOT EXISTS idx_folders_ws ON folders (workspace_id);

CREATE TABLE IF NOT EXISTS skus (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    project_id uuid NOT NULL REFERENCES projects(id),
    folder_id uuid REFERENCES folders(id),
    code text NOT NULL,
    title text,
    attributes text
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sku_ws_code ON skus (workspace_id, code) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS assets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    sku_id uuid NOT NULL REFERENCES skus(id),
    kind text NOT NULL DEFAULT 'source',
    storage_key text NOT NULL,
    mime text,
    size_bytes bigint,
    hash text,
    width int,
    height int,
    status text NOT NULL DEFAULT 'uploaded'
);
CREATE INDEX IF NOT EXISTS idx_assets_ws_created ON assets (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS generation_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    sku_id uuid NOT NULL REFERENCES skus(id),
    source_asset_id uuid REFERENCES assets(id),
    template text NOT NULL,
    status text NOT NULL DEFAULT 'queued',
    progress int NOT NULL DEFAULT 0,
    error text,
    idempotency_key text,
    attempts int NOT NULL DEFAULT 0,
    cost_cents int NOT NULL DEFAULT 0,
    output_asset_id uuid REFERENCES assets(id),
    review_status text NOT NULL DEFAULT 'pending',
    review_reason text
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON generation_jobs (status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_idem ON generation_jobs (workspace_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS usage_ledgers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    event text NOT NULL,
    units int NOT NULL DEFAULT 0,
    cost_cents int NOT NULL DEFAULT 0,
    job_id uuid,
    note text
);
CREATE INDEX IF NOT EXISTS idx_usage_ws ON usage_ledgers (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    workspace_id uuid,
    actor_id uuid,
    action text NOT NULL,
    target text,
    meta text,
    is_admin boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    user_id uuid NOT NULL REFERENCES users(id),
    token_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_hash ON refresh_tokens (token_hash);

-- 第二道防线：启用 RLS 的表由应用在事务内 SET LOCAL app.workspace_id
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE generation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_ledgers ENABLE ROW LEVEL SECURITY;

CREATE POLICY assets_tenant ON assets
    USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
CREATE POLICY jobs_tenant ON generation_jobs
    USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
CREATE POLICY usage_tenant ON usage_ledgers
    USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
