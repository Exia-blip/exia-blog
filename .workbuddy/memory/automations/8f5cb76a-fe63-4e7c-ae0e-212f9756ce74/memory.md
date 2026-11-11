# 博客发稿节奏检查 — 执行记录

## 2026-11-08（周日 23:01）
- 核对线上：`/api/posts` 共 8 篇。本周（11-02~11-08）已发 6 篇：11-03 两篇（d1-no-such-table、oauth-device-flow）、11-08 四篇（oauth-auth-code/pkce/token-lifecycle、wrangler-deploy-errors、workers-io-different-request）。11-08 那批属发布日集中上线，后续按周节奏走。
- 内链核对：OAuth 四篇、踩坑三篇互相均有 `/p/` 链接，sitemap 已含全部 7 个文章 URL。
- 结论：本周不需补稿；下周 W1（11-11）无稿，因此按排期起草。
- 产出：`content/05-blog-markdown-xss.md`（slug `blog-markdown-xss`，系列「自建博客实录」1/3）、`scripts/gen-blog-series.mjs`、`scripts/seed-blog-series.sql`。
- 本地 D1 已跑通 schema + seed 验证，未执行 --remote，未部署。
- 待老板确认：11-11 当天执行 seed 并 deploy；GSC 对新 URL 请求索引（本机无授权，无法代做）。

## 2026-11-11（周三 19:43）
- 线上 13 篇。本周（11-09~11-15）已发 3 篇：11-09 `editor-autosave`、11-10 `editor-markdown-xss` 与 `r2-image-pipeline`。节奏未断，但属「两天连发 3 篇」，记一次违反「不要攒几篇一次发完」。
- W1 篇（`blog-markdown-xss`，05 草稿）未上线，且与已发的 `editor-markdown-xss` 撞题（同为自研渲染器 + 转义/白名单 + XSS）。判定作废，不发布，草稿留作素材库；EDITORIAL 排期表已同步（W1 划掉、W2/W3 去掉系列号改为独立篇）。
- 当日不发新稿（再发即本周第 4 篇）。
- 补链（本周唯一实质动作）：`r2-image-pipeline` 原为零内链。已在两篇正文互加 `/p/` 链接，`scripts/gen-crosslinks.mjs` 生成 `scripts/patch-crosslinks.sql`，`wrangler d1 execute --remote --file` 推送成功（2 rows written）。线上验证双向闭合，sitemap lastmod 已变 2026-11-11。
- 坑：首次 `--file` 推送静默未生效（updated_at 未变），重跑一次才写入。以后推完必须 `SELECT` 回验。
- GSC：本机无授权、无脚本，未代做。

## 下次要盯的
- 11-18（W2）：SSR 独立篇，素材在 `src/index.js` 的 `*ssr failed` 分支与 `src/cache.js`；不挂系列号。
- 05 草稿里的九个 payload 与回归脚本可拆出来做 B 类短文，别浪费。
