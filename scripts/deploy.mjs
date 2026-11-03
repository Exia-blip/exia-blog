// 部署包装：每次部署带一个新的资源版本号，HTML 里的 /style.css?v=... 跟着变，
// 静态资源才能放心用一年强缓存。
// 直接 `npx wrangler deploy` 不会带版本号，走 `npm run deploy` 即可。
import { execSync } from 'node:child_process';

const version = Date.now().toString(36);
console.log(`[deploy] asset version = ${version}`);
execSync(`npx wrangler deploy --var SITE_VERSION:${version}`, { stdio: 'inherit' });
