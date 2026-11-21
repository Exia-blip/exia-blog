-- 回滚：恢复 12 篇存稿的原始每周三排期（与改动前线上 D1 基线一致）。
-- 仅在需要撤销「2 天一篇」时使用。

UPDATE posts SET published_at = '2026-11-25 01:00:00' WHERE slug = 'three-layer-cache';
UPDATE posts SET published_at = '2026-12-02 01:00:00' WHERE slug = 'jwt-exp-verify';
UPDATE posts SET published_at = '2026-12-09 01:00:00' WHERE slug = 'samesite-behavior';
UPDATE posts SET published_at = '2026-12-16 01:00:00' WHERE slug = 'cors-preflight-cost';
UPDATE posts SET published_at = '2026-12-23 01:00:00' WHERE slug = 'turnstile-what-it-blocks';
UPDATE posts SET published_at = '2027-01-06 01:00:00' WHERE slug = 'workers-free-tier-limits';
UPDATE posts SET published_at = '2027-01-13 01:00:00' WHERE slug = 'd1-kv-r2-latency';
UPDATE posts SET published_at = '2027-01-20 01:00:00' WHERE slug = 'workers-blog-pillar';
UPDATE posts SET published_at = '2027-02-03 01:00:00' WHERE slug = 'related-posts';
UPDATE posts SET published_at = '2027-02-10 01:00:00' WHERE slug = 'search-highlight-xss';
UPDATE posts SET published_at = '2027-02-17 01:00:00' WHERE slug = 'rss-enclosure-cover';
UPDATE posts SET published_at = '2027-03-03 01:00:00' WHERE slug = 'csp-nonce-cache';
