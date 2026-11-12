# Automation: 发布隐藏文章 worker-render-549-to-96

## 2026-11-12 23:59 执行记录

- D1 `UPDATE posts SET hidden=0` 成功（posts.id=29，changes=1）。
- 复核：hidden=0；published_at = 2026-11-18 01:00:00（未来时间，但 Worker 的公开查询只按 is_private/hidden 过滤，无 published_at<=now 条件，不影响可见性）。
- 线上验证（无需等待 5 分钟，边缘缓存已是新内容）：
  - `/p/worker-render-549-to-96` → 200，无 `noindex`
  - 页面结构：14 个 `h-anchor`、18 个 `code-block`、6 张表
  - 首页 / rss.xml / sitemap.xml 均已含该 slug
  - Cache-Control: public, max-age=0, s-maxage=300, swr=86400
- 任务书里"应有 9 个 h-anchor"与正文不符：content/13-worker-render-549-to-96.md 实际有 14 个 `##` 标题，页面 14 个锚点一一对应。后续同类验收按正文标题数核对，不按固定数字。

## 经验

- 该站文章页缓存 key 忽略 query string？实测带 ?t= 与不带均返回最新内容，改库后基本立刻可见。
- 验收命令模板：curl 状态码 + grep noindex + 统计 h-anchor/code-block/table + 三处收录检查。
