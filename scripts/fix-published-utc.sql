-- published_at 全站按 UTC 存（nowISO 也是 UTC），seed 里写成了本地时间，这里纠正
UPDATE posts SET published_at = '2026-11-08 14:50:00', created_at = '2026-11-08 14:50:00',
                 updated_at = '2026-11-08 14:50:00'
WHERE slug IN ('wrangler-deploy-errors', 'workers-io-different-request');
UPDATE posts SET updated_at = '2026-11-08 14:52:00' WHERE slug = 'd1-no-such-table';
