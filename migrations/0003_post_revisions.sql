-- 文章版本快照：每次保存前留一份当前内容，误覆盖或误删后可以回滚。
-- 只存 posts 行里的字段，不存标签关系——回滚改的是正文/状态，标签保持当前值。
-- 每篇保留最近 30 个版本，写入时清理更旧的，避免无限增长。
CREATE TABLE IF NOT EXISTS post_revisions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id       INTEGER NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  content       TEXT NOT NULL DEFAULT '',
  html_content  TEXT NOT NULL DEFAULT '',
  cover         TEXT,
  cover_body    TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT '',
  series        TEXT NOT NULL DEFAULT '',
  series_order  INTEGER NOT NULL DEFAULT 0,
  is_private    INTEGER NOT NULL DEFAULT 0,
  hidden        INTEGER NOT NULL DEFAULT 0,
  review_status TEXT NOT NULL DEFAULT 'approved',
  published_at  TEXT NOT NULL DEFAULT '',
  saved_at      TEXT NOT NULL DEFAULT (datetime('now')),
  saved_by      INTEGER NOT NULL DEFAULT 0,
  note          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_revisions_post ON post_revisions(post_id, saved_at DESC);
