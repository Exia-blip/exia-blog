-- 系列连载：一个系列名 + 序号，文章页据此生成系列目录与上下篇互链
ALTER TABLE posts ADD COLUMN series TEXT NOT NULL DEFAULT '';
ALTER TABLE posts ADD COLUMN series_order INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_posts_series ON posts(series, series_order);
