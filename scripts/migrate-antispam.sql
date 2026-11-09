-- 评论防滥用：加限额表（幂等，重复执行无副作用）
CREATE TABLE IF NOT EXISTS comment_guard (
  k        TEXT PRIMARY KEY,
  day      TEXT NOT NULL DEFAULT '',
  hits     INTEGER NOT NULL DEFAULT 0,
  last_ts  INTEGER NOT NULL DEFAULT 0,
  banned   INTEGER NOT NULL DEFAULT 0
);

-- 按 IP 查历史评论（封 IP 时要一次扫出来）
CREATE INDEX IF NOT EXISTS idx_comments_ip ON comments (ip);
