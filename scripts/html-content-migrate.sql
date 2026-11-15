-- 正文预渲染 + 正文首图落库
--
-- html_content：发布/保存时把 renderBody + sanitizeHtml 的成品存下来。
--   content 仍存 Markdown（编辑器回显要它），渲染页面时优先读 html_content。
--   边缘缓存 miss、冷启动、改文 bust 之后的那次回源，不用再在 Worker CPU 上
--   现场跑一遍 Markdown 解析 + 标签清洗 + 目录抽取。
-- cover_body：正文首图快照。列表/归档原来为了算封面必须 SELECT 正文，
--   有了这一列，列表查询就能把 content 整列裁掉。
--
-- 空串是合法值：表示「保存时判定过，这篇没有可用的正文首图 / 还没回填」。
-- 读取侧对空 html_content 回退到现算，所以先加列再回填不会出现白页。

ALTER TABLE posts ADD COLUMN html_content TEXT NOT NULL DEFAULT '';
ALTER TABLE posts ADD COLUMN cover_body TEXT NOT NULL DEFAULT '';
