-- 发布节奏改为「2 天一篇」：12 篇未到点存稿从 2026-11-25 起每 2 天一篇。
-- published_at 存 UTC，北京时间 09:00 = UTC 01:00。
-- 只改 published_at；hidden 保持 0，仍靠 liveSql 时间闸门到点自动上线。
-- 11-21 ld-self-reference 今日已上线，不在本表内。
-- 回滚：scripts/schedule-2day-rollback.sql

UPDATE posts SET published_at = '2026-11-25 01:00:00' WHERE slug = 'three-layer-cache';
UPDATE posts SET published_at = '2026-11-27 01:00:00' WHERE slug = 'jwt-exp-verify';
UPDATE posts SET published_at = '2026-11-29 01:00:00' WHERE slug = 'samesite-behavior';
UPDATE posts SET published_at = '2026-12-01 01:00:00' WHERE slug = 'cors-preflight-cost';
UPDATE posts SET published_at = '2026-12-03 01:00:00' WHERE slug = 'turnstile-what-it-blocks';
UPDATE posts SET published_at = '2026-12-05 01:00:00' WHERE slug = 'workers-free-tier-limits';
UPDATE posts SET published_at = '2026-12-07 01:00:00' WHERE slug = 'd1-kv-r2-latency';
UPDATE posts SET published_at = '2026-12-09 01:00:00' WHERE slug = 'workers-blog-pillar';
UPDATE posts SET published_at = '2026-12-11 01:00:00' WHERE slug = 'related-posts';
UPDATE posts SET published_at = '2026-12-13 01:00:00' WHERE slug = 'search-highlight-xss';
UPDATE posts SET published_at = '2026-12-15 01:00:00' WHERE slug = 'rss-enclosure-cover';
UPDATE posts SET published_at = '2026-12-17 01:00:00' WHERE slug = 'csp-nonce-cache';
