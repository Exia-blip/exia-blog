-- 站点设置（后台可改，覆盖 wrangler.jsonc 的 vars）
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL DEFAULT ''
);

-- 用户
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id   TEXT UNIQUE NOT NULL,
  login       TEXT NOT NULL,
  name        TEXT,
  avatar      TEXT,
  email       TEXT,                         -- 联系邮箱，仅自己与管理员可见
  is_admin    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 文章
CREATE TABLE IF NOT EXISTS posts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT UNIQUE NOT NULL,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  cover       TEXT,
  category    TEXT NOT NULL DEFAULT '',      -- 分类：一篇文章一个，空串表示未分类
  is_private  INTEGER NOT NULL DEFAULT 0,  -- 私密：仅作者可见，未登录 404
  hidden      INTEGER NOT NULL DEFAULT 0,  -- 不列入首页
  summary     TEXT NOT NULL DEFAULT '',    -- AI 摘要（发布/保存时生成）
  summary_src TEXT NOT NULL DEFAULT '',    -- ai | fallback | manual
  summary_hash TEXT NOT NULL DEFAULT '',   -- 生成摘要时的正文指纹，避免重复烧 token
  series      TEXT NOT NULL DEFAULT '',    -- 所属系列（连载名），空串表示单篇
  series_order INTEGER NOT NULL DEFAULT 0, -- 系列内序号，同序号按创建时间
  author_id   INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_author  ON posts(author_id);
CREATE INDEX IF NOT EXISTS idx_posts_category ON posts(category);

-- 标签
CREATE TABLE IF NOT EXISTS tags (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS post_tags (
  post_id  INTEGER NOT NULL,
  tag_id   INTEGER NOT NULL,
  PRIMARY KEY (post_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_post_tags_tag ON post_tags(tag_id);

-- 评论（parent_id 为 NULL 是顶级，否则挂在顶级下，两级）
CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id     INTEGER NOT NULL,
  parent_id   INTEGER,
  name        TEXT NOT NULL,
  email       TEXT,
  website     TEXT,
  content     TEXT NOT NULL,
  is_admin    INTEGER NOT NULL DEFAULT 0,
  ip          TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);

-- 友链
CREATE TABLE IF NOT EXISTS friends (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  avatar      TEXT,
  desc        TEXT,
  status      INTEGER NOT NULL DEFAULT 1, -- 1 可访问 0 挂
  checked_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
