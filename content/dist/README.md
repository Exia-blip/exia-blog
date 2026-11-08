# 分发稿：OAuth Device Flow

站内原文：https://exia.de5.net/p/oauth-device-flow

三个平台各一份，**不要同一份贴三处**。顺序建议：掘金 → V2EX → dev.to（掘金审核最慢，先交上去；V2EX 要人盯着回帖；dev.to 发完基本没互动压力）。

发之前改一处：`client_id=Iv1.xxxxxxxxxxxx` 换成自己随便编的格式即可，别贴真的。

链接统一带 `?utm_source=juejin|v2ex|devto&utm_medium=post`，方便以后回头看哪边带来的访客真的读了第二篇。

---

## 掘金

- 标题：`OAuth Device Flow 到底解决了什么问题？从 gh auth login 说起`
- 分类：前端 / 后端（选后端更准）
- 标签：OAuth、后端、安全、GitHub
- 正文：`juejin-device-flow.md`
- 注意：文末不要写「关注我」「欢迎star」，只留一句原文出处。掘金对导流敏感，正文里保留 GitHub 官方端点链接是加分项，能证明不是编的。

## V2EX

- 节点：`/go/programming`（不是 `/go/create`，那是个股节点）
- 标题：`为什么 gh auth login 不需要回调地址？把 Device Flow 拆了一遍`
- 正文：`v2ex-device-flow.md`
- 注意：V2EX 对纯引流帖反感，正文必须是「我讲一个机制」，链接放最后一行当补充。新号可能发不出带链接的帖，先攒几次正常回复。发完 24 小时内回帖，别发完就跑。

## dev.to

- 标题：`How OAuth Device Flow works when your app has no callback URL`
- 标签：`oauth, security, webdev, javascript`（dev.to 最多 4 个）
- 正文：`devto-device-flow.md`，文件头带 front matter，`canonical_url` 指回站内
- 注意：dev.to 会把 canonical_url 当权威来源，不跟自己抢排名。英文别用机翻腔，宁可句子短。

---

## 发完之后

1. 三处都发完，去 Search Console 对 `/p/oauth-device-flow` 请求一次编入索引（外链进来时爬虫会更勤快，这时候请求最有效）。
2. 一周后看 `utm_source` 的分布，把效果最好的那个平台定成主力，下次同类文章优先发它。
3. 有评论指出错误就直接在站内原文改，并在文末加一句「2026-11 修订：……」。评论区纠错是最便宜的技术审稿。
