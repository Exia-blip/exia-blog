// 部署包装：每次部署带一个新的资源版本号，HTML 里的 /style.css?v=... 跟着变，
// 静态资源才能放心用一年强缓存。
// 直接 `npx wrangler deploy` 不会带版本号，走 `npm run deploy` 即可。
import { execSync, spawnSync } from 'node:child_process';

/* 静态资源的 SRI 与版本号都来自 src/assets.gen.js，它必须与 public 里的字节一一对上。
   放在最前面重算是幂等的：内容没变就什么都不写，变了就把 manifest 跟磁盘对齐。
   为什么不用 --check 卡住：发版路径上人最容易忘的就是「改了 css 忘了跑脚本」，
   与其拦下来让人再敲一次命令，不如直接算对 —— 但 npm test 里仍有一条会校验
   这份 manifest 与磁盘一致，防止有人在测试里改文件却不重算就提交。 */
execSync(`"${process.execPath}" scripts/build-sri.mjs`, { stdio: 'inherit' });

/* 部署前先把配置摆出来。挡的不是「没配完」，而是「半配」——
   只填 TURNSTILE_SITE_KEY 不填 SECRET，评论会被全量拒收，而页面看起来一切正常。
   这种状态上线一次就够难受半天了，所以放在发版路径上，而不是指望有人记得先跑。 */
const pre = spawnSync(process.execPath, ['scripts/check-env.mjs'], { stdio: 'inherit' });
if (pre.status !== 0) {
  console.log('\n[deploy] 配置体检没过，已停下。修完再发版。');
  process.exit(pre.status || 1);
}

/* 发版前先跑全量测试，顺序硬化在发版路径上，不靠人记。
   图片安全 / srcset / alt / SVG CSP 这些管线的回归，线上体检未必抓得到
   （比如某个入口的 CSP 只在单元测试里断言），测试是最后一道闸。
   npm test 是本地单测，不依赖远程 D1，D1 抖动不会误伤发版。 */
try {
  execSync('npm test', { stdio: 'inherit', shell: true });
} catch {
  console.log('\n[deploy] 测试没过，已停下。修完再发版。');
  process.exit(1);
}

/* 库结构闸门：代码要的列，线上库得真有。
   顺序必须是「写 migrations/NNNN_xxx.sql → npm run schema:apply → 发版」；
   反过来（先发版后迁移）会有一段时间代码撞 no such column，页面直接 500。
   退出码 1 = 结构与 migrations 不一致，停下；退出码 2 = 连不上 D1，
   只警告不阻断 —— 网络抖动不该让人发不了版，真正的结构问题会在下次发版时暴露。 */
const sc = spawnSync(process.execPath, ['scripts/schema.mjs', 'check'], { stdio: 'inherit' });
if (sc.status === 1) {
  console.log('\n[deploy] 线上库结构与 migrations 对不上，已停下。先 npm run schema:apply。');
  process.exit(1);
}
if (sc.status === 2) {
  console.log('\n[deploy] ⚠️ 结构体检没跑成（连不上 D1），继续部署 —— 上线后留意 no such column 报错。');
}

// asset version 取时间戳，不读 package.json 的 version（P-106）：
// 语义版本在 git tag / GitHub Release，package.json 的 1.2.6 与线上无关。
const version = Date.now().toString(36);
console.log(`[deploy] asset version = ${version}`);
execSync(`npx wrangler deploy --var SITE_VERSION:${version}`, { stdio: 'inherit' });

/* 部署后打线上体检（check-live 默认打 https://miu.sryze.cc）。
   必须在部署后跑——部署前跑测的是旧版本，等于没测。
   它覆盖响应头 / CSP / srcset / alt / 103 等线上才能验的项，是发版闭环的最后一环。
   体检失败不回滚（回滚要另发一个版本），而是明确报错让人决定。 */
try {
  execSync('npm run check:live', { stdio: 'inherit', shell: true });
} catch {
  console.log('\n[deploy] ⚠️ 线上体检失败。代码已部署，请查看上面的失败项决定是否需要修复重发。');
  /* 部署刚完成时边缘还留着上一版的副本（HTML 是 s-maxage=300）：
     GET 撞上旧副本 → 拿到旧 body 的 ETag；HEAD 落到新代码 → 拿到新 ETag。
     于是「HEAD 与 GET 的 ETag 一致」「带 If-None-Match 回 304」「304 没有 body」
     「304 不带新 nonce 的 CSP」必然成组假红 —— v1.2.4 实测过一次，5 分钟后
     重跑全绿，代码一行没错。这组红不要当回归修，等缓存过期复跑即可。 */
  console.log('[deploy] 若失败项只有 ETag / 304 这一组（HEAD 与 GET 的 ETag 一致、带 If-None-Match 回 304、');
  console.log('[deploy] 304 没有 body、304 不带新 nonce 的 CSP），那是部署后 s-maxage=300 的缓存窗口：');
  console.log('[deploy] 等 5 分钟重跑 npm run check:live 即可，不必重发。');
  process.exit(1);
}
