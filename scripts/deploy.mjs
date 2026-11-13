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

const version = Date.now().toString(36);
console.log(`[deploy] asset version = ${version}`);
execSync(`npx wrangler deploy --var SITE_VERSION:${version}`, { stdio: 'inherit' });
