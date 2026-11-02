-- 版本标记：同一 SKU 同一模板下，哪一次生成结果是当前主版本。
CREATE TABLE IF NOT EXISTS asset_version_marks (
    id           UUID PRIMARY KEY,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at   TIMESTAMPTZ,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    sku_id       UUID NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
    template     VARCHAR(40) NOT NULL,
    job_id       UUID NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
    is_current   BOOLEAN NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vmark ON asset_version_marks (workspace_id, sku_id, template, job_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_vmark_current ON asset_version_marks (workspace_id, sku_id, template, is_current);

-- 质检明细：分数与问题项 JSON。
ALTER TABLE assets ADD COLUMN IF NOT EXISTS qc_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS qc_issues TEXT;
