-- 同步历史索引：记录每次触发，支持跨 GitHub 保留期的搜索
CREATE TABLE IF NOT EXISTS syncs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id           INTEGER UNIQUE,           -- GitHub run id
  source           TEXT NOT NULL,            -- 完整源地址
  destination      TEXT NOT NULL,            -- 完整目标地址
  registry         TEXT,                     -- 派生：目标 registry 域名
  org              TEXT,                     -- 派生：目标组织
  repo             TEXT,                     -- 派生：镜像名（不含 tag）
  tag              TEXT,                     -- 派生：tag
  arch             TEXT,                     -- amd64 / arm64 / all
  conclusion       TEXT,                     -- NULL=进行中，或 success/failure/cancelled/skipped
  duration_seconds INTEGER,
  created_at       TEXT NOT NULL,            -- ISO8601 UTC
  finished_at      TEXT,
  deleted_at       TEXT                      -- 软删除标记（管理员隐藏记录）
);

CREATE INDEX IF NOT EXISTS idx_syncs_created_at ON syncs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_syncs_repo ON syncs(repo);
CREATE INDEX IF NOT EXISTS idx_syncs_source ON syncs(source);
CREATE INDEX IF NOT EXISTS idx_syncs_destination ON syncs(destination);
CREATE INDEX IF NOT EXISTS idx_syncs_run_id ON syncs(run_id);