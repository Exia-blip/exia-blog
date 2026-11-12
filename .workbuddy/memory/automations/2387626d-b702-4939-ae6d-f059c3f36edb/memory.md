# Automation Memory — 发布 sticky-toc-grid-align-items

## 2026-11-13 00:00 (GMT+8)
- 执行：`UPDATE posts SET hidden = 0 WHERE slug='sticky-toc-grid-align-items'`（remote D1 blog-db，rows_written=1）
- 确认：id=25, hidden=0, published_at=2026-11-13 01:00:00
- 验证：无需等待 300s TTL —— 改库后立即（带 `?t=` 与非带参路径）文章页 200、无 noindex、h-anchor=12、pre.code-block=11、首页/RSS/sitemap 均已出现 slug。
- 偏差记录：任务预期 12 个 `pre.code-block`，实际源文件 `content/12-sticky-toc-grid-align-items.md` 只有 22 条围栏 = 11 个代码块，渲染 11 个为正确。后续同类校验应以源文件围栏数/2 为准，勿硬编码 12。
- 经验：该站 `?t=` 查询串会绕过边缘缓存键，可用作即时校验；真实访问路径（无参）也已同步为已发布状态。
- 未做：Google Search Console 手动请求索引（自动化环境无 GSC 授权）。
