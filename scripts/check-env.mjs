// 部署前体检：哪些值真的配上了，哪些只是「以为配上了」。
// 用法：node scripts/check-env.mjs
//
// 存在的理由只有一个：Turnstile 半配是这站唯一会「静默打死评论区」的状态。
// 只填 SITE_KEY 不填 SECRET，前端照常弹验证框、服务端按配置不完整拒收，
// 表现是「评论一直提交失败」，但后台不会有人告诉你为什么。
// 所以在动 key 之前先把当前状态摆出来。
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

/* wrangler.jsonc 里带注释，JSON.parse 直接吃会炸。
   这里只需要知道某几个键在不在 vars 里，不追求完整解析 —— 解析器留个漏洞反而更危险。 */
const jsonc = read('wrangler.jsonc');
const varOf = (name) => {
  const m = jsonc.match(new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`));
  return m ? m[1] : '';
};

const devVars = read('.dev.vars');
const devVarOf = (name) => {
  const m = devVars.match(new RegExp(`^${name}\\s*=\\s*"?([^"\\n]*)"?`, 'm'));
  return m ? m[1].trim() : '';
};

let secrets = [];
let secretsKnown = false;
try {
  /* 直接跑 node_modules 里的入口，不走 npx：
     Windows 上 .cmd 不能被 spawn（Node 22 会报 EINVAL），改用 shell 又要引 cmd.exe，
     一层套一层只是为了启动一个本地文件，不划算。 */
  const out = execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'list'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  secrets = JSON.parse(out.slice(out.indexOf('['))).map((s) => s.name);
  secretsKnown = true;
} catch (e) {
  console.log(`（读不到线上密钥清单：${String(e.message).split('\n')[0]}）\n`);
}
const hasSecret = (n) => secrets.includes(n);

/* 有值的定义：线上密钥里有，或本地 .dev.vars 里有。
   vars 里写空串等于没写 —— 但这一点要单独说，因为「键在、值是空」最难看出来。
   脱敏：只露前 6 位和长度，够分辨「填的是哪个」，不够泄露。 */
const mask = (v) => (!v ? '' : `${v.slice(0, 6)}…（${v.length} 字符）`);

const rows = [];
const add = (name, { secret = false, note = '' } = {}) => {
  const fromVar = varOf(name);
  const fromDev = devVarOf(name);
  const on = secret ? hasSecret(name) : !!fromVar;
  const local = !!fromDev;
  /* 三态：「只在本机能跑」和「线上生效」是两件事。
     老版本这里只判 on，结果 .dev.vars 里明明有值却显示「未配」，
     自相矛盾的表格比没有表格更误导。 */
  let state = '未配';
  if (on) state = '已配';
  else if (local) state = '仅本地';
  if (!on && jsonc.includes(`"${name}"`) && !fromVar) state = '键在值为空';
  const where = [on && secret ? '线上密钥' : '', on && !secret ? 'wrangler vars' : '', local ? '.dev.vars' : ''].filter(Boolean).join(' / ');
  rows.push({ name, state, where: where || '—', note, mask: mask(fromVar || fromDev) });
};

add('SESSION_SECRET', { secret: true, note: '登录会话签名' });
add('GITHUB_CLIENT_SECRET', { secret: true, note: 'GitHub OAuth' });
add('TURNSTILE_SITE_KEY', { note: '人机验证（公开值）' });
add('TURNSTILE_SECRET', { secret: true, note: '人机验证（服务端校验）' });
add('WEBHOOK_URL', { secret: true, note: '新评论通知' });

const site = !!varOf('TURNSTILE_SITE_KEY') || !!devVarOf('TURNSTILE_SITE_KEY');
const secret = hasSecret('TURNSTILE_SECRET') || !!devVarOf('TURNSTILE_SECRET');

console.log('  项                          状态        来源              说明');
for (const r of rows) {
  console.log(`  ${r.name.padEnd(26)}  ${r.state.padEnd(10)}  ${r.where.padEnd(16)}  ${r.note}`);
}

console.log('');
if (site && !secret) {
  console.log('  ✗ Turnstile 只配了 SITE_KEY，缺 TURNSTILE_SECRET。');
  console.log('    这个状态下所有评论都会被拒收（antispam.js 的 site-only 分支），');
  console.log('    页面上看不出异常，只有提交时提示「人机验证配置不完整」。');
  console.log('    补上：npx wrangler secret put TURNSTILE_SECRET');
  /* 只有真读到线上密钥清单才敢拦部署。
     读不到时（离线、没登录）secret 一律判空，这时拦人等于「没网就不让发版」。 */
  if (secretsKnown) process.exitCode = 1;
  else console.log('    （密钥清单没读到，不确定线上到底有没有 SECRET，先不拦）');
} else if (!site && secret) {
  console.log('  ⚠ 只有 TURNSTILE_SECRET，前端没有组件，按未启用处理（评论正常）。');
} else if (site && secret) {
  console.log('  ✓ Turnstile 已启用，前端弹框 + 服务端校验都在。');
} else {
  console.log('  · Turnstile 未启用。评论走蜜罐 + 关键词 + 频率限制，功能正常。');
}

const hook = hasSecret('WEBHOOK_URL') ? '已配' : '未配';
console.log(`  · WEBHOOK_URL ${hook} —— 未配时新评论不通知任何人，评论本身照收。`);
