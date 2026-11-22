-- 评论先审后发：默认 approved，存量评论全部保持可见、行为不变。
-- 开关存在 settings 表的 comment_moderation 键；打开后新评论落 pending，
-- 管理员在 /admin/comments 放行或驳回。管理员自己发的评论仍直接 approved。
ALTER TABLE comments ADD COLUMN status TEXT NOT NULL DEFAULT 'approved';
CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status, created_at);
