// 请求体闸门 + Turnstile 出处复核回归。
// 用法：node scripts/test-body-limit.mjs
//
// 这里守的是两件容易在后续改动里悄悄退化的事：
//   1) readJsonLimited 超限就断流 —— 以后谁把它换回 request.json()，BL-04 会红；
//   2) siteverify 的 hostname / action 必须严格相等 —— 谁把 `!==` 放松成「有就比」，
//      BL-09/10 会红。
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { readJsonLimited, readFormLimited, bodyTooLarge, BODY_LIMIT_JSON } from '../src/utils.js';
import { handleApi, bodyCapFor } from '../src/api.js';
import { verifyTurnstile } from '../src/antispam.js';

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

const enc = (s) => new TextEncoder().encode(s);

/** 造一个不带 content-length 的流式请求：用来模拟谎报长度/she 分块上传 */
function streamingReq(totalBytes, chunk = 8192) {
  let sent = 0;
  let pulls = 0;
  const stream = new ReadableStream({
    pull(c) {
      pulls++;
      if (sent >= totalBytes) {
        c.close();
        return;
      }
      const n = Math.min(chunk, totalBytes - sent);
      sent += n;
      c.enqueue(new Uint8Array(n).fill(0x20));
    },
  });
  const req = new Request('https://x.test/api/comments', {
    method: 'POST',
    body: stream,
    duplex: 'half',
    headers: { 'content-type': 'application/json' },
  });
  return { req, pulls: () => pulls };
}

/* ---------- 闸门 ---------- */

t('BL-01 正常 JSON 原样解析', async () => {
  const req = new Request('https://x.test/', { method: 'POST', body: '{"a":1}' });
  const r = await readJsonLimited(req);
  assert.deepEqual(r.body, { a: 1 });
});

t('BL-02 坏 JSON 归 bad，不抛', async () => {
  const req = new Request('https://x.test/', { method: 'POST', body: '{oops' });
  assert.equal((await readJsonLimited(req)).bad, true);
});

t('BL-03 content-length 诚实地超限：一个字节都不读', async () => {
  const req = new Request('https://x.test/', {
    method: 'POST',
    body: 'x',
    headers: { 'content-length': String(BODY_LIMIT_JSON + 1) },
  });
  assert.equal((await readJsonLimited(req)).tooBig, true);
});

t('BL-04 不给 content-length 也拦得住：读到超限立即断流', async () => {
  const { req, pulls } = streamingReq(1024 * 1024); // 1MB 的流
  const r = await readJsonLimited(req);
  assert.equal(r.tooBig, true);
  // 64KB / 8KB ≈ 9 次，给一两次余量；关键是远小于 128 次（读完 1MB 的次数）
  assert.ok(pulls() <= 12, `读了 ${pulls()} 块，说明没有及时断流`);
});

t('BL-05 恰好等于上限放行（边界不该被 off-by-one 挡住）', async () => {
  // {"a":"<填充>"} 撑到正好 BODY_LIMIT_JSON 字节
  const head = '{"a":"';
  const tail = '"}';
  const payload = head + 'x'.repeat(BODY_LIMIT_JSON - head.length - tail.length) + tail;
  assert.equal(payload.length, BODY_LIMIT_JSON);
  const req = new Request('https://x.test/', { method: 'POST', body: payload });
  const r = await readJsonLimited(req);
  assert.equal(r.tooBig, undefined);
  assert.equal(r.body.a.length, BODY_LIMIT_JSON - head.length - tail.length);
});

t('BL-06 bodyTooLarge 没有 content-length 时视为不超限', async () => {
  const { req } = streamingReq(64);
  assert.equal(bodyTooLarge(req), false);
});

t('BL-07 路由上限：评论 64KB / 正文 1MB / 上传 8MB', () => {
  assert.equal(bodyCapFor('/comments'), BODY_LIMIT_JSON);
  assert.equal(bodyCapFor('/pv'), BODY_LIMIT_JSON);
  assert.equal(bodyCapFor('/posts/12'), 1024 * 1024);
  assert.equal(bodyCapFor('/posts'), 1024 * 1024);
  assert.equal(bodyCapFor('/upload'), 8 * 1024 * 1024);
  assert.equal(bodyCapFor('/settings/avatar'), 8 * 1024 * 1024);
});

/* ---------- 分支级闸门：这道才是没人守的那一半 ----------
 * 顶层 `bodyTooLarge()` 只认 content-length。谎报一个 3、或者分块上传不给这个头，
 * 顶层直接放行，请求一路走到分支里。只要分支里还写着 `await request.json()`，
 * 整个包就被读进 isolate —— 闸门看着在，实际只管住了一半。
 * 所以分支统一走 readBody()，下面两条把这条规矩钉在机器上。 */
t('[P-037] BL-14 元断言：src/ 里不许再出现裸 request.json()（注释不算）', () => {
  const dir = new URL('../src/', import.meta.url);
  const strip = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\w])\/\/[^\n]*/g, '$1');
  const bad = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    const code = strip(readFileSync(new URL(f, dir), 'utf8'));
    if (/\b(?:request|req)\.json\s*\(/.test(code)) bad.push(f);
  }
  assert.deepEqual(bad, [], `这些文件还绕过 readBody 直接解析请求体：${bad.join(', ')}`);
});

t('[P-037] BL-15 谎报 content-length 的 1MB 请求：写分支收到 413，且没进库', async () => {
  // content-length: 3，实际推 1MB 分块体 —— 顶层闸门必放行，只能靠分支里按流数
  let sent = 0;
  const stream = new ReadableStream({
    pull(c) {
      if (sent >= 1024 * 1024) return c.close();
      sent += 64 * 1024;
      c.enqueue(new Uint8Array(64 * 1024).fill(0x20));
    },
  });
  const req = new Request('https://exia.de5.net/api/comments', {
    method: 'POST',
    body: stream,
    duplex: 'half',
    headers: { 'content-type': 'application/json', 'content-length': '3' },
  });
  // env 里没有 DB：真读进来就会在 posts 查询处抛，能拿到 413 就证明提前结束了
  const res = await handleApi({}, req, new URL('https://exia.de5.net/api/comments'), {});
  assert.equal(res.status, 413);
  assert.match(res.headers.get('cache-control') || '', /no-store/);
  assert.ok(sent < 1024 * 1024, `读了 ${sent} 字节，说明没有在超限处断流`);
});

t('[P-037] BL-16 multipart 同样按流数：伪报长度时 formData 不接管', async () => {
  // request.formData() 与 request.json() 是同一个坑，只是长得像「浏览器帮我解析」
  const boundary = '----probe';
  const mp =
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n` +
    `Content-Type: text/plain\r\n\r\nhello\r\n--${boundary}--\r\n`;
  const ok = await readFormLimited(
    new Request('https://x.test/api/upload', {
      method: 'POST',
      body: mp,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    }),
    1024
  );
  assert.equal(ok.form.get('file').name, 'a.txt', '小表单应正常解析');

  let sent = 0;
  const stream = new ReadableStream({
    pull(c) {
      if (sent >= 2 * 1024 * 1024) return c.close();
      sent += 64 * 1024;
      c.enqueue(new Uint8Array(64 * 1024).fill(0x20));
    },
  });
  const big = await readFormLimited(
    new Request('https://x.test/api/upload', {
      method: 'POST',
      body: stream,
      duplex: 'half',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': '3' },
    }),
    64 * 1024
  );
  assert.equal(big.tooBig, true);
  assert.ok(sent < 2 * 1024 * 1024, `读了 ${sent} 字节，说明没有在超限处断流`);
});

t('[P-037] BL-17 元断言：src/ 里不许再出现裸 request.formData()（注释不算）', () => {
  const dir = new URL('../src/', import.meta.url);
  const strip = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\w])\/\/[^\n]*/g, '$1');
  const bad = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    const code = strip(readFileSync(new URL(f, dir), 'utf8'));
    if (/\b(?:request|req)\.formData\s*\(/.test(code)) bad.push(f);
  }
  assert.deepEqual(bad, [], `这些文件绕过了 readForm 直接解析表单：${bad.join(', ')}`);
});

/* ---------- Turnstile 出处复核 ---------- */

const onEnv = { TURNSTILE_SITE_KEY: 'k', TURNSTILE_SECRET: 's' };
const realFetch = globalThis.fetch;
const realWarn = console.warn;

/** 把 siteverify 的响应钉死成 d，跑一次 verifyTurnstile */
async function withSiteverify(d, fn) {
  globalThis.fetch = async () => new Response(JSON.stringify(d), { headers: { 'content-type': 'application/json' } });
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  }
}

t('BL-08 没配 key 就整层跳过，不发请求', async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error('不该发请求');
  };
  try {
    const r = await verifyTurnstile({}, 'tok', '1.2.3.4', { host: 'exia.de5.net', action: 'comment' });
    assert.equal(r.skipped, true);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

t('BL-09 host 与 action 都匹配才放行', async () => {
  const r = await withSiteverify({ success: true, hostname: 'exia.de5.net', action: 'comment' }, () =>
    verifyTurnstile(onEnv, 'tok', '1.2.3.4', { host: 'exia.de5.net', action: 'comment' })
  );
  assert.equal(r.ok, true);
});

t('BL-10 别站签发的 token（hostname 不符）拒收', async () => {
  const r = await withSiteverify({ success: true, hostname: 'evil.example', action: 'comment' }, () =>
    verifyTurnstile(onEnv, 'tok', '1.2.3.4', { host: 'exia.de5.net', action: 'comment' })
  );
  assert.equal(r.ok, false);
});

t('BL-11 同一 sitekey 的别的 widget（action 不符）拒收', async () => {
  const r = await withSiteverify({ success: true, hostname: 'exia.de5.net', action: 'login' }, () =>
    verifyTurnstile(onEnv, 'tok', '1.2.3.4', { host: 'exia.de5.net', action: 'comment' })
  );
  assert.equal(r.ok, false);
});

t('BL-12 响应里缺 hostname / action 一律按不匹配处理，不放行', async () => {
  const r = await withSiteverify({ success: true }, () =>
    verifyTurnstile(onEnv, 'tok', '1.2.3.4', { host: 'exia.de5.net', action: 'comment' })
  );
  assert.equal(r.ok, false);
});

t('BL-13 siteverify 不可达时仍降级放行（可用性优先于这层）', async () => {
  globalThis.fetch = async () => {
    throw new Error('network');
  };
  console.warn = () => {};
  try {
    const r = await verifyTurnstile(onEnv, 'tok', '1.2.3.4', { host: 'exia.de5.net', action: 'comment' });
    assert.equal(r.ok, true);
    assert.equal(r.degraded, true);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  }
});

let pass = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${pass}/${cases.length} passed`);
