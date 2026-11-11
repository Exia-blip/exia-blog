-- 标题卡：没有手填封面的文章，用生成的分享图当封面
-- 由 scripts/gen-cards.mjs 生成
UPDATE posts SET cover = '/cards/about.png' WHERE slug = 'about' AND (cover IS NULL OR cover = '');
UPDATE posts SET cover = '/cards/d1-no-such-table.png' WHERE slug = 'd1-no-such-table' AND (cover IS NULL OR cover = '');
UPDATE posts SET cover = '/cards/oauth-device-flow.png' WHERE slug = 'oauth-device-flow' AND (cover IS NULL OR cover = '');
UPDATE posts SET cover = '/cards/oauth-auth-code.png' WHERE slug = 'oauth-auth-code' AND (cover IS NULL OR cover = '');
UPDATE posts SET cover = '/cards/oauth-pkce.png' WHERE slug = 'oauth-pkce' AND (cover IS NULL OR cover = '');
UPDATE posts SET cover = '/cards/oauth-token-lifecycle.png' WHERE slug = 'oauth-token-lifecycle' AND (cover IS NULL OR cover = '');
UPDATE posts SET cover = '/cards/wrangler-deploy-errors.png' WHERE slug = 'wrangler-deploy-errors' AND (cover IS NULL OR cover = '');
UPDATE posts SET cover = '/cards/workers-io-different-request.png' WHERE slug = 'workers-io-different-request' AND (cover IS NULL OR cover = '');
UPDATE posts SET cover = '/cards/workers-subrequest-limit.png' WHERE slug = 'workers-subrequest-limit' AND (cover IS NULL OR cover = '');
UPDATE posts SET cover = '/cards/worker-cron-friend-check.png' WHERE slug = 'worker-cron-friend-check' AND (cover IS NULL OR cover = '');
UPDATE posts SET cover = '/cards/editor-autosave.png' WHERE slug = 'editor-autosave' AND (cover IS NULL OR cover = '');
UPDATE posts SET cover = '/cards/editor-markdown-xss.png' WHERE slug = 'editor-markdown-xss' AND (cover IS NULL OR cover = '');
UPDATE posts SET cover = '/cards/r2-image-pipeline.png' WHERE slug = 'r2-image-pipeline' AND (cover IS NULL OR cover = '');
UPDATE posts SET cover = '/cards/comment-anti-spam.png' WHERE slug = 'comment-anti-spam' AND (cover IS NULL OR cover = '');
