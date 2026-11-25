-- 评论通知送达：把「落库 → 群里收到」这半步从读码结论变成一行可查的事实。
--
-- 为什么落库而不是只打日志：sendWebhook 早就会判 HTTP 码与平台码（企微 93000 那种
-- 200 里藏 error 的情况），但结论只进 console —— 事后谁也不知道那条评论通知到底成没成。
-- 现在每次投递把结果写回这一行，后台评论管理直接显示，不用翻 wrangler tail。
--
-- 取值：'' 未尝试（历史行 / 待审走的是待办提醒）· ok 平台已接受 · fail HTTP 或平台码非 0 · skip 没配 WEBHOOK_URL
ALTER TABLE comments ADD COLUMN notify_status TEXT NOT NULL DEFAULT '';
-- 失败原因（HTTP 500 / 平台码 93000 / 超时），截断后落库，方便直接看出是哪一类
ALTER TABLE comments ADD COLUMN notify_note TEXT NOT NULL DEFAULT '';
-- 投递尝试时刻，UTC；空表示从未尝试过
ALTER TABLE comments ADD COLUMN notified_at TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_comments_notify ON comments(notify_status, id);
