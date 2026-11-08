# 博客发稿节奏检查 — 执行记录

## 2026-11-08（周日 23:01）
- 核对线上：`/api/posts` 共 8 篇。本周（11-02~11-08）已发 6 篇：11-03 两篇（d1-no-such-table、oauth-device-flow）、11-08 四篇（oauth-auth-code/pkce/token-lifecycle、wrangler-deploy-errors、workers-io-different-request）。11-08 那批属发布日集中上线，后续按周节奏走。
- 内链核对：OAuth 四篇、踩坑三篇互相均有 `/p/` 链接，sitemap 已含全部 7 个文章 URL。
- 结论：本周不需补稿；下周 W1（11-11）无稿，因此按排期起草。
- 产出：`content/05-blog-markdown-xss.md`（slug `blog-markdown-xss`，系列「自建博客实录」1/3）、`scripts/gen-blog-series.mjs`、`scripts/seed-blog-series.sql`。
- 本地 D1 已跑通 schema + seed 验证，未执行 --remote，未部署。
- 待老板确认：11-11 当天执行 seed 并 deploy；GSC 对新 URL 请求索引（本机无授权，无法代做）。

## 下次要盯的
- 11-11 发布后：抽查文章页渲染（正文对 `#tag` 转链的 alt 注入是本文自己指出的待修项）。
- 2/3（SSR）成稿后，回补 1/3 指向新篇的链接。
