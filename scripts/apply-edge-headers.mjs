#!/usr/bin/env node
/**
 * 给站点补一条边缘响应头规则（Cloudflare Transform Rule / rulesets API）。
 *
 * 为什么需要：Worker 侧 securityHeaders() 已经覆盖所有正常响应，但 Cloudflare
 * 自己的错误页（1101 / 52x）和 /cdn-cgi/* 不经过 Worker，那些响应上没有
 * nosniff / Referrer-Policy / X-Frame-Options。这条规则补的就是这部分。
 *
 * 用法：
 *   node scripts/apply-edge-headers.mjs                    # 预览
 *   node scripts/apply-edge-headers.mjs --apply            # 写入
 *   node scripts/apply-edge-headers.mjs --verify           # 只验证 token 权限，不读不写规则
 *   node scripts/apply-edge-headers.mjs --token=xxxx       # 直接带 token（等价 CF_API_TOKEN）
 *
 * Token 来源优先级：--token= > CF_API_TOKEN > .cf-token 文件 > CLOUDFLARE_API_TOKEN
 * 也支持 Global API Key：CF_EMAIL=.. CF_GLOBAL_KEY=..（不推荐，权限过大）
 *
 * Token 权限：Zone → Transform Rules → Edit，加 Zone → Zone → Read。
 * 注意：wrangler login 拿到的 OAuth token 没有这个权限，永远 403，必须建 API Token。
 *
 * 不碰 content-security-policy（里面有每次请求的 nonce，写死会拦掉站内内联脚本），
 * 也不碰 strict-transport-security（会覆盖掉 includeSubDomains; preload）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const ZONE_NAME = process.env.CF_ZONE || 'exia.de5.net';
const APPLY = process.argv.includes('--apply');
const VERIFY = process.argv.includes('--verify');
const RULE_DESC = 'security-baseline';

const argToken = (process.argv.find((a) => a.startsWith('--token=')) || '').slice(8).trim();
const fileTokenPath = join(ROOT, '.cf-token');
const fileToken = existsSync(fileTokenPath) ? readFileSync(fileTokenPath, 'utf8').trim() : '';
const TOKEN = argToken || process.env.CF_API_TOKEN || fileToken || process.env.CLOUDFLARE_API_TOKEN || '';
const EMAIL = process.env.CF_EMAIL || '';
const GLOBAL_KEY = process.env.CF_GLOBAL_KEY || '';
const GLOBAL = !TOKEN && EMAIL && GLOBAL_KEY;

const HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
};

const API = 'https://api.cloudflare.com/client/v4';

if (!TOKEN && !GLOBAL) {
  console.error(`
缺凭据。三选一：

  A. 直接把 token 存本地（推荐，之后所有命令都不用再带）
     echo 'cf_你的token' > ${fileTokenPath}

  B. 环境变量
     CF_API_TOKEN=cf_你的token node scripts/apply-edge-headers.mjs --apply

  C. 命令行参数
     node scripts/apply-edge-headers.mjs --token=cf_你的token --apply

Token 建法：dash.cloudflare.com → My Profile → API Tokens → Create Token
→ Custom token，权限两项：
     Zone · Transform Rules · Edit
     Zone · Zone · Read
Zone Resources 选 exia.de5.net 即可。

（wrangler login 的 OAuth token 不行，它没有 Transform Rules 权限，只会 403。）
`);
  process.exit(1);
}

function authHeaders() {
  if (GLOBAL) return { 'x-auth-email': EMAIL, 'x-auth-key': GLOBAL_KEY, 'content-type': 'application/json' };
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
}

function diagnose(status, body, what) {
  const err = body?.errors?.[0];
  const msg = err?.message || `HTTP ${status}`;
  const code = err?.code;

  if (status === 401 || code === 10000) {
    console.error(`
读取${what}失败：${msg}（code ${code}）

这是权限问题，不是脚本问题。对照检查：
  1. token 是否原样复制（cf_ 开头，40 位左右，末尾别带空格/换行）
  2. 权限是否含 Zone · Transform Rules · Edit
  3. Zone Resources 是否包含 ${ZONE_NAME}
  4. 如果这是 wrangler login 的 OAuth token —— 它没有 Transform Rules 权限，换 API Token
`);
    return;
  }
  console.error(`读取${what}失败：${msg}（HTTP ${status}${code ? ` / code ${code}` : ''}）`);
}

async function cf(path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers || {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${res.status} 非 JSON 响应：${text.slice(0, 200)}`);
  }
  return { status: res.status, body };
}

/* ---------- 1. 定位 zone ---------- */
const zone = await cf(`/zones?name=${encodeURIComponent(ZONE_NAME)}`);
if (!zone.body.success || !zone.body.result?.length) {
  diagnose(zone.status, zone.body, ' zone 信息');
  console.error(`找不到 zone：${ZONE_NAME}`);
  process.exit(1);
}
const zoneId = zone.body.result[0].id;
console.log(`zone    : ${ZONE_NAME} → ${zoneId} (${zone.body.result[0].status})`);

/* ---------- 2. 读现有规则集 ---------- */
const phase = 'http_response_headers_transform';
const epPath = `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`;
const ep = await cf(epPath);

let rules = [];
if (ep.status === 404) {
  console.log('rulesets: 该 phase 下还没有规则集，将新建');
} else if (!ep.body.success) {
  diagnose(ep.status, ep.body, ' Transform Rules 规则集');
  process.exit(1);
} else {
  rules = ep.body.result?.rules || [];
  console.log(`rulesets: 现有 ${rules.length} 条规则`);
  for (const r of rules) {
    console.log(`  - [${r.enabled === false ? 'off' : 'on '}] ${r.description || '(无描述)'} · ${r.expression}`);
  }
}

if (VERIFY) {
  console.log(`\n权限验证通过：能读 zone、能读 ${phase} 规则集${GLOBAL ? '（Global API Key 模式）' : ''}。`);
  console.log('要写入请加 --apply。');
  process.exit(0);
}

/* ---------- 3. 组装规则（幂等：同名原地替换） ---------- */
const headerParams = Object.fromEntries(
  Object.entries(HEADERS).map(([k, v]) => [k, { operation: 'set', value: v }])
);

const ours = {
  action: 'rewrite',
  action_parameters: { headers: headerParams },
  expression: 'true',
  description: RULE_DESC,
  enabled: true,
};

const idx = rules.findIndex((r) => r.description === RULE_DESC);
if (idx >= 0) {
  rules[idx] = { ...rules[idx], ...ours };
  console.log(`\n替换已有规则「${RULE_DESC}」`);
} else {
  rules.push(ours);
  console.log(`\n追加规则「${RULE_DESC}」`);
}

// 服务端只读字段必须剥离，否则 PUT 会 400
const payload = {
  rules: rules.map(({ id, version, last_updated, ref, ...rest }) => rest),
};

console.log('将写入的完整规则集：');
console.log(JSON.stringify(payload, null, 2));

if (!APPLY) {
  console.log('\n预览模式，未写入。加 --apply 才生效。');
  process.exit(0);
}

/* ---------- 4. 写入 ---------- */
const put = await cf(epPath, { method: 'PUT', body: JSON.stringify(payload) });
if (!put.body.success) {
  console.error('\n写入失败：', JSON.stringify(put.body.errors, null, 2));
  process.exit(1);
}
console.log(`\n已写入，ruleset ${put.body.result.id}，版本 ${put.body.result.version}`);
console.log('验证：node scripts/check-headers.mjs');
