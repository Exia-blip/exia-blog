#!/usr/bin/env node
// 一条命令配好通知与人机验证：先验值 → 再写入 → 最后体检。
//
// 用法：
//   npm run setup:webhook    -- <webhook 地址>
//   npm run setup:turnstile  -- <SITE_KEY> <SECRET>
//
// 为什么非要先验一遍：这两个值配错的后果都是静默的。
//   · webhook 地址失效时，企微/飞书回的是 HTTP 200 + {"errcode":93000}，只看状态码全是成功；
//   · Turnstile secret 写错时前端照常弹框、服务端永远验不过，
//     用户看到的是「评论一直提交失败」，页面上找不到任何线索。
// 两个都能靠一次真实请求在写进去之前判掉，那就别把它留到线上试。
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { webhookPlatform, webhookPayload } from '../src/webhook.js';

const argv = process.argv.slice(2);
// --dry：只验值、不落盘。密钥不会写进 Worker，wrangler.jsonc 也不会改。
// 想先确认「这把 secret 到底对不对」而不想动线上时用它。
const dry = argv.includes('--dry');
// --no-probe：跳过会写数据的探测（umami 用）。内网实例、或不想在统计里留一条假 PV 时用。
const noProbe = argv.includes('--no-probe');
const [cmd, ...args] = argv.filter((a) => !a.startsWith('--'));
const die = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};

/* 占位符必须在脚本里拦，不能指望「用户会自己替换」。
   文档里写的是 `npm run setup:umami -- <script> <你的-website-id>`，原样粘进 bash 时
   `<你的-website-id` 不是参数而是重定向：shell 去找这个文件、找不到、命令在 npm
   启动之前就断了，报的是 "No such file or directory" —— 看上去像文件缺失，
   实际是参数写错了，而且这种情况下什么都不会发生，也没有任何提示。
   形状上能认出来的占位符，在这里一次说清。 */
const looksPlaceholder = (v) => {
  const s = String(v).trim();
  if (!s) return false;
  if (s.startsWith('<') || s.endsWith('>')) return true;
  return /(你的|xxxx|XXXX|\.\.\.|…)/.test(s);
};

for (const a of args) {
  if (looksPlaceholder(a)) {
    die(
      `「${a}」是占位符，不是真实值。\n` +
        '  另外提醒：`<...>` 在 bash 里是重定向，照原样粘进去命令会直接报\n' +
        '  "No such file or directory" 而不是进入脚本 —— 加引号或不带尖括号才是参数。\n\n' +
        '  不想手动替换的话，直接跑不带参数的 npm run setup:<子命令>，\n' +
        '  它会逐项问你，把值粘在提示符后面即可。'
    );
  }
}

/* 交互式补值：参数缺了但人在终端前，就问。
   这条路的意义是彻底绕开「复制命令 → 找占位符 → 替换」这个动作，
   而占位符没被替换正是最容易出错的一步。 */
const canAsk = () => process.stdin.isTTY && process.stdout.isTTY;
/* 一个进程只开一个 readline，并且自己管行缓冲。
   两个坑都是实测踩出来的：
   1. 每问一次新建一个接口再 close，第二问会永远卡住 —— 关闭时把 stdin 一起 pause 了。
   2. 直接 rl.question()，如果数据比提问先到（`printf 'a\nb\n' | npm run ...`、
      或用 heredoc 喂值），先到的那一行会被 readline 丢掉：那一刻还没有等待者。
      人肉输入碰不到，但任何脚本化调用都会，而这种失败表现为「卡住」，最难查。
   所以行先进队列，问的时候先看队列；terminal: false 也是故意的，
   默认值会调 stdin.setRawMode，管道场景下没有这个方法。 */
let rl = null;
let waiter = null;
const pending = [];
const ensureRl = () => {
  if (rl) return rl;
  rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (l) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(l);
    } else pending.push(l);
  });
  rl.on('close', () => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(''); // EOF：当成按了回车，让后续校验去判够不够
    }
  });
  return rl;
};
const ask = async (q, fallback = '') => {
  ensureRl();
  process.stdout.write(q);
  const raw = pending.length ? pending.shift() : await new Promise((res) => (waiter = res));
  const v = String(raw || '').trim();
  return v || fallback;
};

/* 一切 wrangler 调用都直接跑 node_modules 里的入口：
   Windows 上 .cmd 不能被 spawn（EINVAL），用 npx 又要过一层 shell，
   而这层 shell 在受限环境里本身就可能被拦。 */
const wrangler = (argv, opts = {}) => spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...argv], opts);

const putSecret = (name, value) => {
  if (dry) {
    console.log(`  --  跳过写入 secret ${name}（--dry）`);
    return;
  }
  const r = wrangler(['secret', 'put', name], { input: value, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  if (r.status !== 0) die(`写入 ${name} 失败：${(r.stderr || '').split('\n').filter(Boolean).pop() || r.status}`);
  console.log(`  ok  已写入 secret ${name}`);
};

const preflight = () => {
  if (dry) {
    console.log('\n（--dry：跳过体检）');
    return;
  }
  console.log('\n—— 体检 ——');
  const r = spawnSync(process.execPath, ['scripts/check-env.mjs'], { stdio: 'inherit' });
  if (r.status !== 0) die('体检没过，见上面的原因');
};

/* ---------------- webhook ---------------- */
async function setupWebhook() {
  const url = (args[0] || '').trim();
  if (!url) die('用法：npm run setup:webhook -- <webhook 地址>');

  let u;
  try {
    u = new URL(url);
  } catch {
    die(`这不是一个完整 URL：${url.slice(0, 60)}（要带 https://）`);
  }
  if (u.protocol !== 'https:') die(`必须是 https，当前是 ${u.protocol}`);

  const platform = webhookPlatform(url);
  const known = {
    wecom: '企业微信群机器人',
    feishu: '飞书自定义机器人',
    discord: 'Discord',
    slack: 'Slack',
    generic: '通用（按 { text } 发）',
  }[platform];
  console.log(`  平台判定：${platform} —— ${known}`);
  if (platform === 'generic') {
    console.log('  ⚠ 域名不在企微/飞书/Discord/Slack 里，按通用结构发 { text }。');
    console.log('    接收端不是 Slack 兼容的话可能收不到，先看下面这条测试消息有没有到。');
  }

  console.log('\n—— 发一条测试消息 ——');
  const text = '🔔 通知已接通\n这条来自 exia.de5.net 的配置脚本，收到即表示地址有效。';
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(webhookPayload(url, text)),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    die(`请求没发出去：${e.message}\n  常见原因：地址拼错、机器人已被移除、本机网络不通。`);
  }

  const body = await r.text();
  let code = 0;
  let detail = '';
  try {
    const d = JSON.parse(body);
    code = Number(d.errcode ?? d.code ?? d.StatusCode ?? 0);
    detail = d.errmsg || d.msg || d.message || '';
  } catch {
    /* 非 JSON 响应（Slack 回 "ok" 之类），只看状态码 */
  }

  if (!r.ok || code) {
    // 企微：93000 地址错 / 93001 内容空 / 45009 频率超限；飞书：19021 签名校验失败
    const hint =
      code === 93000
        ? 'webhook 地址无效或机器人已被删除，去群里重新拿一次地址'
        : code === 45009
          ? '该机器人发得太频繁，等几分钟再试'
          : code === 19021
            ? '飞书开了「签名校验」，本项目的发送端不带签名，需要在飞书那边关掉'
            : '看返回内容，地址一般要整段重新复制（key 在 query 里）';
    die(`发送失败：HTTP ${r.status}${code ? ` / 平台码 ${code} ${detail}` : ''}\n  ${hint}`);
  }

  console.log(`  ok  平台接受了这条消息（HTTP ${r.status}${code ? ` code ${code}` : ''}）`);
  console.log('     去群里确认一下真的收到，再往下走。');

  console.log('\n—— 写入密钥 ——');
  putSecret('WEBHOOK_URL', url);
  preflight();
  console.log('\n完成。新评论会推到刚才那个群。');
}

/* ---------------- turnstile ---------------- */
async function setupTurnstile() {
  const [siteKey, secret] = args.map((s) => (s || '').trim());
  if (!siteKey || !secret) die('用法：npm run setup:turnstile -- <SITE_KEY> <SECRET>');

  // Cloudflare 的密钥都是 0x/1x/2x/3x 开头 + 一长串 base62，长度 24 上下
  const shape = /^[0-9]x[0-9A-Za-z]{18,}$/;
  if (!shape.test(siteKey)) die(`SITE_KEY 形状不对：${siteKey.slice(0, 12)}…（应以 0x 开头，二十多位）`);
  if (!shape.test(secret)) die(`SECRET 形状不对：${secret.slice(0, 12)}…（同上）`);
  if (siteKey === secret) die('SITE_KEY 和 SECRET 填成同一个了。它们是两个不同的值。');

  console.log('  SITE_KEY 形状正常（公开值，最终写进 wrangler.jsonc 的 vars）');
  console.log('  SECRET   形状正常（私密值，走 wrangler secret）');

  console.log('\n—— 拿 secret 去 siteverify 验一次 ——');
  /* 用一个假 token 换错误码，判别的是 secret 本身：
       有效 secret + 假 token  → invalid-input-response   ← 说明 secret 被认了
       无效 secret + 任何 token → invalid-input-secret     ← 说明 secret 是错的
     这是唯一能在「不产生真实验证流量」的前提下判断 secret 对错的办法。 */
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', 'probe-not-a-real-token');
  let d;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    d = await r.json();
  } catch (e) {
    die(`连不上 siteverify：${e.message}`);
  }
  const codes = d['error-codes'] || [];
  if (codes.includes('invalid-input-secret')) {
    die('SECRET 无效：Cloudflare 不认这把密钥。\n  去 Turnstile → 你的 widget → Secret Key 重新复制（注意别拿成 Site Key）。');
  }
  if (d.success) {
    console.log('  ok  通过，但返回 success:true —— 这是 Cloudflare 的测试密钥（1x000…）。');
    console.log('     测试密钥对任何人都放行，只适合本地验证流程，上线前换成正式密钥。');
  } else if (codes.includes('invalid-input-response')) {
    console.log('  ok  SECRET 被接受（假 token 被拒，正是预期结果）');
  } else {
    console.log(`  ? 返回了没见过的结果：${JSON.stringify(d)}`);
    console.log('     不阻断，但建议先搞清这串错误码再上线。');
  }

  console.log('\n—— 把 SITE_KEY 写进 wrangler.jsonc ——');
  const path = 'wrangler.jsonc';
  const src = readFileSync(path, 'utf8');
  const line = `"TURNSTILE_SITE_KEY": "${siteKey}"`;
  let out;
  if (/"TURNSTILE_SITE_KEY"\s*:\s*"[^"]*"/.test(src)) {
    out = src.replace(/"TURNSTILE_SITE_KEY"\s*:\s*"[^"]*"/, line);
    console.log('  ok  已有该键，替换为新值');
  } else {
    /* 插在 R2_PUBLIC_BASE 后面：那里是 vars 的最后一项，
       新键接上去要补一个逗号，否则整份配置立刻语法错误。 */
    const anchor = /(\n(\s*)"R2_PUBLIC_BASE":\s*"[^"]*")(,?)/;
    if (!anchor.test(src)) die('wrangler.jsonc 里找不到 "R2_PUBLIC_BASE"，不敢乱插，停手。');
    out = src.replace(anchor, (m, keep, indent, comma) => `${keep}${comma || ','}\n${indent}${line}`);
    console.log('  ok  已插入 vars');
  }

  /* 写回之前先确认这份 JSONC 去掉注释后还能被解析。
     「改配置改出语法错误」在部署时才报，那时候人已经在等结果了。 */
  const stripped = out.replace(/^\s*\/\/.*$/gm, '');
  try {
    JSON.parse(stripped);
  } catch (e) {
    die(`改完之后 wrangler.jsonc 不是合法 JSON（${e.message}）。文件没有保存，原样未动。`);
  }
  if (dry) {
    const around = out.split('\n').filter((l) => /TURNSTILE_SITE_KEY|R2_PUBLIC_BASE/.test(l));
    console.log('  --  不落盘（--dry），改完会是这两行：');
    for (const l of around) console.log(`      ${l.trim()}`);
  } else {
    writeFileSync(path, out);
  }

  console.log('\n—— 写入密钥 ——');
  putSecret('TURNSTILE_SECRET', secret);
  preflight();

  console.log('\n完成。部署后打开任一文章页，评论区应该出现验证框。');
  console.log('如果验证框一直转圈或报错，先去 CF 面板确认 widget 的 Hostname 包含 exia.de5.net。');
}

/* ---------------- umami ---------------- */
/* 两个值都是公开信息（会出现在每一份 HTML 里），所以走 vars 不走 secret。
   判错的方式和 turnstile 同源：拿一个必然失败的请求换错误码。
   Umami 的 /api/send 对「id 不存在」和「id 存在但域名不对」回的是不同的错，
   所以假 id 会得到 Invalid website ID，真 id 至少不会得到这一句。 */
async function setupUmami() {
  const [a1, a2] = args.map((s) => (s || '').trim());
  let scriptUrl = a1;
  let siteId = a2;

  if ((!scriptUrl || !siteId) && canAsk()) {
    console.log('\n—— 没给全参数，逐项问一下（直接回车用方括号里的值）——');
    if (!scriptUrl) {
      scriptUrl = await ask('script 地址 [https://cloud.umami.is/script.js]：', 'https://cloud.umami.is/script.js');
    }
    if (!siteId) {
      siteId = await ask('website-id（Umami 后台 → 设置 → 网站 → Website ID，UUID 形状）：');
    }
    console.log('');
  }

  if (!scriptUrl || !siteId) {
    die(
      '用法：npm run setup:umami -- <script 地址> <website-id>\n' +
        '  例：npm run setup:umami -- https://cloud.umami.is/script.js 1f2e3d4c-5b6a-...\n' +
        '  不带参数跑，会逐项问你。'
    );
  }
  // 交互输入同样可能是粘错的占位符，形状检查之前统一再认一次
  for (const v of [scriptUrl, siteId]) {
    if (looksPlaceholder(v)) die(`「${v}」是占位符，不是真实值。`);
  }

  let u;
  try {
    u = new URL(scriptUrl);
  } catch {
    die(`script 地址不完整：${scriptUrl.slice(0, 60)}（要带 https://，且指向 script.js）`);
  }
  if (u.protocol !== 'https:') die(`script 必须是 https，当前是 ${u.protocol}`);

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(siteId)) {
    die(`website-id 形状不对：${siteId.slice(0, 20)}…（应该是 UUID，五段、带连字符）`);
  }
  console.log('  website-id 形状正常（UUID）');

  console.log('\n—— 拉一次脚本，确认地址真的指向 umami ——');
  let js = '';
  try {
    const r = await fetch(scriptUrl, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) die(`脚本地址返回 HTTP ${r.status}，不是 200。检查是不是把控制台地址当成了 script 地址。`);
    js = await r.text();
  } catch (e) {
    die(`脚本拉不下来：${e.message}\n  常见原因：地址拼错、实例还没起来、本机网络不通。`);
  }
  if (!/data-website-id|umami/i.test(js.slice(0, 4000))) {
    die('这个地址返回的内容不像 umami 的 script.js。\n  Cloud 的地址是 https://cloud.umami.is/script.js；自托管是 <你的域名>/script.js。');
  }
  console.log(`  ok  脚本可用（${(js.length / 1024).toFixed(1)}KB）`);

  /* 采集端未必和脚本同域：Cloud 的脚本在 cloud.umami.is，上报打到 gateway.umami.is。
     这个不一致如果只改 vars 不管 CSP，表现是「脚本加载了、控制台没报错、后台没数据」。 */
  const isCloud = /(^|\.)umami\.is$/.test(u.hostname);
  const collect = isCloud ? 'https://gateway.umami.is/api/send' : u.origin + '/api/send';
  console.log(`  采集端：${collect}${isCloud ? '（Cloud 的脚本与采集不同域，CSP 会一起放行）' : ''}`);

  if (noProbe) {
    console.log('\n—— 跳过 website-id 探测（--no-probe）——');
    console.log('  id 只做了形状检查，没有向实例确认它存在。上线后看后台有没有数据。');
  } else {
  console.log('\n—— 用一条假事件验 website-id ——');
  /* hostname 必须写站点的真域名。用 probe.invalid 这种假域名的话，
     实例若配了域名白名单会直接拒收，而它拒收时回的错误和「id 不存在」是同一句
     Invalid website ID —— 那样会把一个正确的配置判成错的。
     代价是这次探测会记一条 PV，所以路径标成 /__setup_probe__，后台一眼能认出来。 */
  const siteHost = (() => {
    try {
      const m = readFileSync('wrangler.jsonc', 'utf8').match(/"SITE_ORIGIN"\s*:\s*"https:\/\/([^"/]+)"/);
      return m ? m[1] : '';
    } catch {
      return '';
    }
  })();
  const probeHost = siteHost || u.hostname;
  let sent = false;
  try {
    const r = await fetch(collect, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'event',
        payload: { website: siteId, hostname: probeHost, url: '/__setup_probe__', referrer: '' },
      }),
      signal: AbortSignal.timeout(10000),
    });
    const text = (await r.text()).slice(0, 200);
    if (r.ok) {
      sent = true;
      console.log(`  ok  website-id 被接受（HTTP ${r.status}）`);
    } else if (/invalid website id/i.test(text)) {
      die(
        `website-id 不被认可：${text}\n` +
          '  这个 id 不属于该实例，或者已被删除。去 Umami 后台 → 设置 → 网站 → 复制 Website ID。'
      );
    } else {
      /* 错误不是「id 无效」就说明 id 这一步过了，卡在后面（域名白名单、限流之类）。
         那不是本脚本能替对方改的配置，但也不该拦着部署。 */
      console.log(`  ok  website-id 被认可（后续一步被拒，属正常：${text.slice(0, 80)}）`);
    }
  } catch (e) {
    die(`连不上采集端：${e.message}`);
  }
  if (sent) {
    console.log(`     注意：刚才那条事件会记进统计（hostname ${probeHost}、路径 /__setup_probe__），`);
    console.log('     在后台按路径过滤一下就能排除，不影响真实数字。');
  }
  }

  console.log('\n—— 写进 wrangler.jsonc 的 vars ——');
  const path = 'wrangler.jsonc';
  const src = readFileSync(path, 'utf8');
  // 注释行不能进 join：那边会给每一项补逗号，`... /api/pv,` 这种注释看着像写错了
  const note = '// 外部统计：两个都填才生效，缺一个整体退回自建 /api/pv';
  const lines = [`"UMAMI_SCRIPT": "${scriptUrl}"`, `"UMAMI_SITE_ID": "${siteId}"`];
  let out = src;
  const hasScript = /"UMAMI_SCRIPT"\s*:\s*"[^"]*"/.test(out);
  const hasId = /"UMAMI_SITE_ID"\s*:\s*"[^"]*"/.test(out);

  if (hasScript && hasId) {
    out = out.replace(/"UMAMI_SCRIPT"\s*:\s*"[^"]*"/, lines[0]).replace(/"UMAMI_SITE_ID"\s*:\s*"[^"]*"/, lines[1]);
    console.log('  ok  两个键都已存在，替换为新值');
  } else if (hasScript || hasId) {
    die('wrangler.jsonc 里只有其中一个键，配置处于半写状态，不敢自动改。手动补齐或先删掉再跑。');
  } else {
    const anchor = /(\n(\s*)"R2_PUBLIC_BASE":\s*"[^"]*")(,?)/;
    if (!anchor.test(src)) die('wrangler.jsonc 里找不到 "R2_PUBLIC_BASE"，不敢乱插，停手。');
    out = src.replace(
      anchor,
      (m, keep, indent, comma) =>
        `${keep}${comma || ','}\n${indent}${note}\n${indent}${lines.join(',\n' + indent)}`
    );
    console.log('  ok  已插入 vars');
  }

  const stripped = out.replace(/^\s*\/\/.*$/gm, '');
  try {
    JSON.parse(stripped);
  } catch (e) {
    die(`改完之后 wrangler.jsonc 不是合法 JSON（${e.message}）。文件没有保存，原样未动。`);
  }
  if (dry) {
    console.log('  --  不落盘（--dry），改完会是这几行：');
    for (const l of out.split('\n').filter((l) => /UMAMI_|R2_PUBLIC_BASE/.test(l))) console.log(`      ${l.trim()}`);
  } else {
    writeFileSync(path, out);
  }

  console.log('\n—— 部署 ——');
  console.log('  npm run deploy');
  console.log('\n部署后：');
  console.log('  1. 打开站点，Console 里应有 1 条到 ' + new URL(collect).origin + ' 的 POST，状态 200；');
  console.log('  2. 看那份响应有没有 CSP 字样 —— 有就是被 connect-src 拦了（本项目的 CSP 已按端口分别放行）；');
  console.log('  3. Umami 后台实时面板应在 10 秒内出现这次访问。');
  console.log('\n注意：启用 umami 后自建上报会停（__PV_OFF__），/admin/stats 不再增长，历史数据还在。');
}

if (cmd === 'webhook') await setupWebhook();
else if (cmd === 'turnstile') await setupTurnstile();
else if (cmd === 'umami') await setupUmami();
else {
  console.log('用法：');
  console.log('  npm run setup:webhook   -- <webhook 地址>');
  console.log('  npm run setup:turnstile -- <SITE_KEY> <SECRET>');
  console.log('  npm run setup:umami     -- <script 地址> <website-id>');
  console.log('  不带值的项会交互式问你（直接在终端里跑时）。');
  process.exitCode = 1;
}
// 共享的那个 readline 不关，进程会挂着不退
if (rl) rl.close();
