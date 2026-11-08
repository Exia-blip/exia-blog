-- 发布时间：草稿转发布时定下，之后不再改写。
-- 存量数据：当前所有非私密文章都是已发布状态，用 created_at 回填一次。
ALTER TABLE posts ADD COLUMN published_at TEXT NOT NULL DEFAULT '';
UPDATE posts SET published_at = created_at WHERE published_at = '' AND is_private = 0;
CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(published_at);
