-- 存量内容按《栏目与标题写作体系》第 6 节处理
-- 1) 测试残留：不进首页/归档/sitemap，并加 noindex；不删数据，随时可恢复
UPDATE posts SET hidden = 1 WHERE slug IN ('cs', 'post-brfy5');

-- 2) 关于我在站点自述里，归 site 栏目；它不再占「关于」这个孤立标签
UPDATE posts SET category = 'site' WHERE slug = 'about';
DELETE FROM post_tags WHERE tag_id IN (SELECT id FROM tags WHERE name IN ('关于', 'About', 'about'));
DELETE FROM tags WHERE name IN ('关于', 'About', 'about');
