-- 标签名大小写归一：cloudflare / Cloudflare 曾是两条记录。
--
-- 写入侧 normalizeTag() 早就 toLowerCase()，但那是 11 月加的；之前落库的老数据
-- 里留下了 Cloudflare、cf 这类写法。后果不是「显示难看」：
--   · 标签云把 8 篇文章拆成 #cloudflare 7 + #Cloudflare 1；
--   · /tag/Cloudflare 会 301 到小写，然后只列出 7 篇 —— 那 1 篇点进去找不到；
--   · 文章尾部、关于页的标签链接各指一半。
-- 只改查询不改数据只能治一半（同一个标签两个地址，SEO 上也重复）。
--
-- 三步：先把关联并到 id 最小的那条，再删重复行，最后用 UNIQUE ... COLLATE NOCASE
-- 从根上禁止再出现。lower() 在 SQLite 只折叠 ASCII，中文标签不受影响（本来也没有大小写）。
--
-- 幂等：第二次重放时三步都无行可动，索引已存在走 IF NOT EXISTS。

-- ① 把重复标签上的文章关联复制到保留项（id 最小的那条）
INSERT OR IGNORE INTO post_tags (post_id, tag_id)
SELECT pt.post_id, k.min_id
FROM post_tags pt
JOIN tags t ON t.id = pt.tag_id
JOIN (SELECT lower(name) AS ln, MIN(id) AS min_id FROM tags GROUP BY lower(name)) k
  ON k.ln = lower(t.name)
WHERE t.id <> k.min_id;

-- ② 清掉仍指向重复标签的关联（文章已经在 ① 里挂到保留项上）
DELETE FROM post_tags WHERE tag_id IN (
  SELECT t.id FROM tags t
  WHERE t.id <> (SELECT MIN(t2.id) FROM tags t2 WHERE lower(t2.name) = lower(t.name))
);

-- ③ 删掉重复的标签行
DELETE FROM tags WHERE id IN (
  SELECT t.id FROM tags t
  WHERE t.id <> (SELECT MIN(t2.id) FROM tags t2 WHERE lower(t2.name) = lower(t.name))
);

-- ④ 以后 INSERT 'Cloudflare' 会撞上这条索引 —— 写入侧必须按 NOCASE 查已有 id，
--    否则 INSERT OR IGNORE 静默失败、随后的精确 SELECT 找不到，标签会直接丢。
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name_nocase ON tags(name COLLATE NOCASE);
