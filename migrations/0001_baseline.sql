-- 0001 · 基线结构（2026-11-22 从线上库 sqlite_master 导出后整理）
--
-- 为什么要有这个文件：
--   在此之前，表结构是「写一段代码顺手 ALTER 一下」长出来的，没有版本记录。
--   结果是：谁也不知道某台库到底有哪几列，只能靠 PRAGMA 现查、靠记忆比对。
--   migrate.mjs 解决了「整库搬走」，但「库结构该长什么样、现在差多少」没人管。
--
-- 为什么全部是 IF NOT EXISTS：
--   存量库已经跑过这十一条 CREATE 和十条 CREATE INDEX 了，这份文件对它是 **no-op**：
--   唯一作用是让 wrangler 的 d1_migrations 记下「基线已应用」。
--   干净的库（新账号、本地测试）则靠它一次建齐 —— 同一份文件对两种库都成立。
--
-- 以后加列/加表不写在这里，新建 0002_xxx.sql，写完跑：
--   npm run schema:plan      看还有哪些没应用
--   npm run schema:apply     应用（--local / --remote）
--   npm run check:schema     比对实际结构与基线，抓「代码假设有、库里没有」的漂移

-- ---------- 用户 ----------
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id   TEXT UNIQUE NOT NULL,
  login       TEXT NOT NULL,
  name        TEXT,
  avatar      TEXT,
  email       TEXT,
  is_admin    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- 文章 ----------
CREATE TABLE IF NOT EXISTS posts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT UNIQUE NOT NULL,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL DEFAULT '',
  cover         TEXT,
  summary       TEXT NOT NULL DEFAULT '',
  summary_src   TEXT NOT NULL DEFAULT '',
  summary_hash  TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT '',
  series        TEXT NOT NULL DEFAULT '',
  series_order  INTEGER NOT NULL DEFAULT 0,
  is_private    INTEGER NOT NULL DEFAULT 0,  -- 私密：仅作者与管理員可见，未登录 404
  hidden        INTEGER NOT NULL DEFAULT 0,  -- 不列入首页与 sitemap
  author_id     INTEGER NOT NULL,
  published_at  TEXT NOT NULL DEFAULT '',    -- 空 = 立即；未来 = 定时发布闸门
  html_content  TEXT NOT NULL DEFAULT '',    -- 渲染缓存，读取侧 html_content || renderBody()
  cover_body    TEXT NOT NULL DEFAULT '',    -- 正文首图，RSS enclosure 用
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tags (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS post_tags (
  post_id  INTEGER NOT NULL,
  tag_id   INTEGER NOT NULL,
  PRIMARY KEY (post_id, tag_id)
);

-- ---------- 评论 ----------
CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id     INTEGER NOT NULL,
  parent_id   INTEGER,                       -- 一层回复；NULL = 顶层
  name        TEXT NOT NULL,
  email       TEXT,
  website     TEXT,
  content     TEXT NOT NULL,
  is_admin    INTEGER NOT NULL DEFAULT 0,
  ip          TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 反垃圾的滑动窗口计数，按 key（ip / ip+路径）累计
CREATE TABLE IF NOT EXISTS comment_guard (
  k        TEXT PRIMARY KEY,
  day      TEXT NOT NULL DEFAULT '',
  hits     INTEGER NOT NULL DEFAULT 0,
  last_ts  INTEGER NOT NULL DEFAULT 0,
  banned   INTEGER NOT NULL DEFAULT 0
);

-- ---------- 友链（cron 每 20 分钟探测一次，写回 status / checked_at） ----------
CREATE TABLE IF NOT EXISTS friends (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  url          TEXT NOT NULL,
  avatar       TEXT,
  desc         TEXT,
  status       INTEGER NOT NULL DEFAULT 1,   -- 1 可访问 0 挂
  checked_at   TEXT,
  http_status  INTEGER NOT NULL DEFAULT 0,
  latency_ms   INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- 站点配置（后台可改，覆盖 wrangler.jsonc 的 vars） ----------
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL DEFAULT ''
);

-- ---------- 统计 ----------
CREATE TABLE IF NOT EXISTS pv (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  day   TEXT NOT NULL,
  path  TEXT NOT NULL,
  ref   TEXT NOT NULL DEFAULT '',
  ip    TEXT NOT NULL,
  kind  TEXT NOT NULL DEFAULT 'pc',
  ts    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  day    TEXT NOT NULL,
  name   TEXT NOT NULL,
  path   TEXT NOT NULL DEFAULT '',
  extra  TEXT NOT NULL DEFAULT '',
  ip     TEXT NOT NULL,
  ts     TEXT NOT NULL
);

-- ---------- 索引 ----------
CREATE INDEX IF NOT EXISTS idx_posts_author     ON posts (author_id);
CREATE INDEX IF NOT EXISTS idx_posts_category   ON posts (category);
CREATE INDEX IF NOT EXISTS idx_posts_created    ON posts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_published  ON posts (published_at);
CREATE INDEX IF NOT EXISTS idx_posts_series     ON posts (series, series_order);
CREATE INDEX IF NOT EXISTS idx_post_tags_tag    ON post_tags (tag_id);
CREATE INDEX IF NOT EXISTS idx_comments_post    ON comments (post_id);
CREATE INDEX IF NOT EXISTS idx_comments_ip      ON comments (ip);
CREATE INDEX IF NOT EXISTS idx_events_day       ON events (day);
CREATE INDEX IF NOT EXISTS idx_events_name      ON events (day, name);
