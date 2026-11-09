-- 友链检测记录细化：http_status 存真实响应码（0 表示没拿到响应），latency_ms 存握手到响应头的耗时
ALTER TABLE friends ADD COLUMN http_status INTEGER NOT NULL DEFAULT 0;
ALTER TABLE friends ADD COLUMN latency_ms INTEGER;
