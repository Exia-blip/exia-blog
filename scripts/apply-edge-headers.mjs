#!/usr/bin/env node
/**
 * 给站点补一条边缘响应头规则（Cloudflare Transform Rule / rulesets API）。
 *
 * 为什么需要：Worker 侧 securityHeaders() 已经覆盖所有正常响应，但 Cloudflare
 * 自己的错误页（1101 / 52x）和 /cdn-cgi/* 不经过 Worker，那些响应上没有
 * nosniff / Referrer-Policy / X-Frame-Options。这条规则补的就是这部分。
 *
 * 用法：
 *   CF_API_TOKEN=xxx node scripts/apply-edge-headers.mjs            # 预览
 *   CF_API_TOKEN=xxx node scripts/apply-edge-headers.mjs --apply    # 写入
 *
 * Token 权限：Zone → Transform Rules → Edit，加 Zone → Zone → Read。
 * 不碰 content-security-policy（里面有每次请求的 nonce，写死会拦掉站内内联脚本），
 * 也不碰 strict-transport-security（会覆盖掉 includeSubDomains; preload）。
 */

const ZONE_NAME = process.env.CF_ZONE || 'exia.de5.net';
const TOKEN = process.env.CF_API_TOKEN;
const APPLY = process.argv.includes('--apply');
const RULE_DESC = 'security-baseline';

const HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
};

const API = 'https://api.cloudflare.com/client/v4';

if (!TOKEN) {
  console.error('缺 CF_API_TOKEN。面板：My Profile → API Tokens → Create Token（权限 Zone → Transform Rules → Edit + Zone → Zone → Read）');
  process.exit(1);
}

async function cf(path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
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

const zone = await cf(`/zones?name=${encodeURIComponent(ZONE_NAME)}`);
if (!zone.body.success || !zone.body.result?.length) {
  console.error('找不到 zone：', ZONE_NAME, zone.body.errors?.[0]?.message || '');
  process.exit(1);
}
const zoneId = zone.body.result[0].id;
console.log(`zone: ${ZONE_NAME} → ${zoneId}`);

const phase = 'http_response_headers_transform';
const epPath = `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`;
const ep = await cf(epPath);

// 读不到（404）说明这个 zone 还没建过响应头规则集，从空数组起步
let rules = [];
if (ep.status === 404) {
  console.log('该 phase 下还没有规则集，将新建');
} else if (!ep.body.success) {
  console.error('读取现有规则失败：', ep.body.errors?.[0]?.message || ep.status);
  process.exit(1);
} else {
  rules = ep.body.result?.rules || [];
  console.log(`现有规则 ${rules.length} 条`);
}

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

// 幂等：同名规则原地替换，其余规则原样保留（顺序也不动）
const idx = rules.findIndex((r) => r.description === RULE_DESC);
if (idx >= 0) {
  rules[idx] = { ...rules[idx], ...ours };
  console.log(`替换已有规则「${RULE_DESC}」`);
} else {
  rules.push(ours);
  console.log(`追加规则「${RULE_DESC}」`);
}

const payload = { rules: rules.map(({ id, version, last_updated, ref, ...rest }) => rest) };
console.log('\n将写入的完整规则集：');
console.log(JSON.stringify(payload, null, 2));

if (!APPLY) {
  console.log('\n预览模式，未写入。加 --apply 才生效。');
  process.exit(0);
}

const put = await cf(epPath, { method: 'PUT', body: JSON.stringify(payload) });
if (!put.body.success) {
  console.error('写入失败：', JSON.stringify(put.body.errors, null, 2));
  process.exit(1);
}
console.log(`\n已写入，ruleset ${put.body.result.id}，版本 ${put.body.result.version}`);
console.log('验证：node scripts/check-headers.mjs');
