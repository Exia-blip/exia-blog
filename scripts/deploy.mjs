// 部署包装：每次部署带一个新的资源版本号，HTML 里的 /style.css?v=... 跟着变，
// 静态资源才能放心用一年强缓存。
// 直接 `npx wrangler deploy` 不会带版本号，走 `npm run deploy` 即可。
import { execSync, spawnSync } from 'node:child_process';

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

const version = Date.now().toString(36);
console.log(`[deploy] asset version = ${version}`);
execSync(`npx wrangler deploy --var SITE_VERSION:${version}`, { stdio: 'inherit' });

/* 部署后打线上体检（check-live 默认打 https://exia.de5.net）。
   必须在部署后跑——部署前跑测的是旧版本，等于没测。
   它覆盖响应头 / CSP / srcset / alt / 103 等线上才能验的项，是发版闭环的最后一环。
   体检失败不回滚（回滚要另发一个版本），而是明确报错让人决定。 */
try {
  execSync('npm run check:live', { stdio: 'inherit', shell: true });
} catch {
  console.log('\n[deploy] ⚠️ 线上体检失败。代码已部署，请查看上面的失败项决定是否需要修复重发。');
  process.exit(1);
}
