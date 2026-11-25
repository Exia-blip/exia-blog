// `npm run check` 中 check:dom 的显式跳过说明。
//
// 为什么跳过：check-dom.mjs 默认打 http://127.0.0.1:8787，本机没起 dev server 时
// 必然 fetch failed。这不是回归，也不是「线上 DOM 抓不到」——它压根没打线上。
//
// 真·未验，不消除：
//   · 独立命令 `npm run check:dom` 原样保留，起了本地 Worker 就能跑；
//   · CI 里 ci-browser.mjs 会把本地 Worker 的 BASE 传给它，DOM 基线在 CI 覆盖；
//   · 部署后的线上 DOM/响应头由 `npm run check:live` 覆盖。
// 所以这里只跳过聚合命令里的那一次，并留下原因，避免它变成「反正每次都红」的噪音。
console.log('[check] check:dom 已显式跳过：需本地 Worker 127.0.0.1:8787；');
console.log('[check] CI 由 ci-browser.mjs 传 BASE 覆盖，线上由 check:live 覆盖。真·未验，留痕。');
