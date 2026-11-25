// setup.mjs 的失败分支测试。
//
// 重点不是「正常值能写进去」（那条跑一次就够），而是三条会静默走错的路：
//   1. 占位符被当成真实值写进配置 —— 写进去之后 CSP 放行一个不存在的源，
//      而自建上报已被 __PV_OFF__ 关掉，两边都没数据；
//   2. 占位符带尖括号时根本不是参数，是重定向，命令在脚本启动前就断了；
//   3. --dry 说不落盘就必须一个字都不改。
// 每一条都用真实子进程跑，不 import 内部函数 —— 这脚本的价值在于「跑起来会怎样」。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { notifyComment } from '../src/webhook.js';

/* Worker 真发那段在本进程内直接 fetch 本地自签 mock：父进程的代理会把 localhost
   送出去，证书也会被拒。run() 的子进程已单独清过代理，这里只管本进程。 */
for (const k of ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY']) delete process.env[k];
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const run = (args, env = {}) =>
  spawnSync(process.execPath, ['scripts/setup.mjs', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
    env: {
      ...process.env,
      https_proxy: '', HTTPS_PROXY: '', http_proxy: '', HTTP_PROXY: '',
      ...env,
    },
  });

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

const UUID = '1f2e3d4c-5b6a-4978-8c9d-0e1f2a3b4c5d';
const SCRIPT = 'https://cloud.umami.is/script.js';

t('尖括号占位符被拒，且不碰配置文件', () => {
  const before = readFileSync('wrangler.jsonc', 'utf8');
  const r = run(['umami', SCRIPT, '<你的-website-id>']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /占位符/);
  assert.equal(readFileSync('wrangler.jsonc', 'utf8'), before);
});

t('只写了「你的key」的 webhook 也被拒', () => {
  const r = run(['webhook', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=你的key']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /占位符/);
});

t('省略号形式的 turnstile 密钥被拒', () => {
  const r = run(['turnstile', '0x4AAAAAAA...', `0x4AAAAAAA${'b'.repeat(24)}`]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /占位符/);
});

t('xxxx 形式的 id 被拒（形状对但不是真值）', () => {
  const r = run(['umami', SCRIPT, 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /占位符/);
});

t('--dry 跑完成功路径但不落盘', () => {
  const before = readFileSync('wrangler.jsonc', 'utf8');
  const r = run(['umami', SCRIPT, UUID, '--dry', '--no-probe']);
  // 这条用例真正要守的是「--dry 一个字都不改」，它跟网络无关，先断言。
  assert.equal(readFileSync('wrangler.jsonc', 'utf8'), before, '--dry 之后 wrangler.jsonc 被改了');
  if (r.status === 0) {
    assert.match(r.stdout, /已插入 vars|替换为新值/);
    assert.match(r.stdout, /不落盘/);
    return;
  }
  // 拉脚本那一步要访问 cloud.umami.is。有些网络（公司出口 / 特定地区）整段域名不可达，
  // 这时脚本会停在联网校验上。那是环境问题，不是 --dry 把配置写坏了——
  // 所以只放行这一种失败，且上面「文件没变」的断言已经过了；其它失败照旧算 bug。
  assert.match(r.stderr, /脚本拉不下来/, `--dry 意外失败：${r.stdout}${r.stderr}`);
  console.log('        （本机连不上 cloud.umami.is，本次只验了 --dry 不落盘）');
});

/* 2026-11-25 实测：CF 新建 widget 的真 sitekey/secret 含连字符，
   旧正则 [0-9A-Za-z] 把真值判成非法。这里用一个形状正确但必然验不过的 secret，
   判据是「没停在形状校验」——会继续走到 siteverify 并报 SECRET 无效。 */
t('带连字符的密钥形状被接受（CF 真值形态）', () => {
  const r = run(['turnstile', '0x4AAAAAAA-test-shape-key', '0x4AAAAAAA-test-shape-secret', '--dry']);
  assert.doesNotMatch(r.stderr, /形状不对/, r.stderr);
  assert.match(r.stderr, /SECRET 无效|连不上 siteverify|没见过的结果/);
});

t('非终端 + 没给参数 → 用法提示而不是挂住', () => {
  // stdio 里 stdin 是 ignore（等同 EOF），没有 TTY，应该直接退而不是等输入
  const r = run(['umami']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /用法/);
});

/* 冒烟回打的本地 HTTPS mock：第一次请求（落库前的测试消息）成功，
   第二次（写入后的冒烟）回 93000。这样才能验到冒烟那一步，
   而不是在前置测试消息就 die。假 wrangler 顶掉 put，测试不写线上 secret。 */
const withSmokeMock = async (fn, { mode = 'smoke' } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'setup-smoke-'));
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  const g = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  if (g.status !== 0) throw new Error('openssl 不可用，冒烟 mock 起不来');
  const fakeWrangler = join(dir, 'fake-wrangler.mjs');
  const nameFile = join(dir, 'secret-name');
  const valueFile = join(dir, 'secret-value');
  /* 假 wrangler 不再直接 exit：它把「写入的名字 + 写入的值」落到文件。
     Worker 侧真发断言要拿这个捕获值当 env.WEBHOOK_URL —— 否则回打仍用本地 url，
     等于没验「写进去的值」和「Worker 读到的值」是不是同一个。 */
  writeFileSync(fakeWrangler, `
import { writeFileSync } from 'node:fs';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  writeFileSync(${JSON.stringify(nameFile)}, process.argv.slice(2).join(' '));
  writeFileSync(${JSON.stringify(valueFile)}, input);
});
`);
  /* mock 必须在独立进程：run() 用 spawnSync 阻塞父进程事件循环，
     同进程的 server 永远收不到请求（实测 hits=0、请求 timeout）。 */
  const mockScript = join(dir, 'mock.mjs');
  const hitFile = join(dir, 'hits');
  const bodyFile = join(dir, 'bodies');
  writeFileSync(mockScript, `
import { createServer } from 'node:https';
import { readFileSync, appendFileSync } from 'node:fs';
const mode = process.argv[3];
let hits = 0;
createServer({ key: readFileSync(${JSON.stringify(key)}), cert: readFileSync(${JSON.stringify(cert)}) }, (req, res) => {
  hits++;
  appendFileSync(${JSON.stringify(hitFile)}, hits + '\\n');
  let chunks = '';
  req.on('data', (d) => { chunks += d; });
  req.on('end', () => {
    appendFileSync(${JSON.stringify(bodyFile)}, chunks + '\\n');
    if (mode === 'chain') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"errcode":0,"errmsg":"ok"}');
      return;
    }
    /* 第二次（冒烟）必须复用 webhookPayload 的真形状：emoji + 换行 + 够长。
       写成 { text: 'test' } 会在演练里全过、真发时被 sink 的形状校验拒。 */
    let text = '';
    try { text = JSON.parse(chunks).text || ''; } catch {}
    const shaped = hits === 1 || (/[\\u{1F300}-\\u{1FAFF}]/u.test(text) && text.includes('\\n') && text.length > 40);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(!shaped ? '{"errcode":93001,"errmsg":"payload shape"}' :
      hits === 1 ? '{"errcode":0,"errmsg":"ok"}' : '{"errcode":93000,"errmsg":"invalid token"}');
  });
}).listen(Number(process.argv[2]), '127.0.0.1', () => console.log('READY'));
`);
  const port = await new Promise((resolve) => {
    const probe = createNetServer();
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  const child = spawn(process.execPath, [mockScript, String(port), mode], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock server 未就绪')), 10000);
    child.stdout.on('data', (d) => {
      log += d;
      if (log.includes('READY')) { clearTimeout(timer); resolve(); }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  try {
    await fn({
      url: `https://localhost:${port}/hook`,
      fakeWrangler,
      hits: () => {
        try { return readFileSync(hitFile, 'utf8').trim().split('\n').filter(Boolean).length; }
        catch { return 0; }
      },
      secretName: () => {
        try { return readFileSync(nameFile, 'utf8'); } catch { return ''; }
      },
      secretValue: () => {
        try { return readFileSync(valueFile, 'utf8'); } catch { return ''; }
      },
      bodies: () => {
        try {
          return readFileSync(bodyFile, 'utf8').trim().split('\n').filter(Boolean).map((s) => JSON.parse(s));
        } catch { return []; }
      },
    });
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
};

t('冒烟：写入后回打拿到 93000 时应 die，不静默成功', async () => {
  await withSmokeMock(async ({ url, fakeWrangler, hits }) => {
    const r = run(['webhook', url], {
      WRANGLER_BIN: fakeWrangler,
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /冒烟：写入后回打不通/);
    assert.match(r.stderr, /93000/);
    assert.equal(hits(), 2, '前置测试 + 冒烟回打应各一次');
    assert.match(r.stderr, /token 无效或已被轮换/);
    assert.doesNotMatch(r.stderr, /完成。新评论会推到刚才那个群/);
  });
});

t('--dry 冒烟显式跳过并写明原因（不留静默）', async () => {
  await withSmokeMock(async ({ url }) => {
    const r = run(['webhook', url, '--dry'], { NODE_TLS_REJECT_UNAUTHORIZED: '0' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /跳过冒烟回打/);
    assert.match(r.stdout, /未落库/);
    assert.doesNotMatch(r.stderr, /冒烟：写入后回打不通/);
  });
});

t('调用点与 dry 跳过分支：行首锚定 + 唯一计数', () => {
  const src = readFileSync('scripts/setup.mjs', 'utf8');
  const at = (re) => (src.match(re) || []).length;
  assert.equal(at(/^  putSecret\('WEBHOOK_URL', url\);$/gm), 1, 'putSecret 调用点应唯一');
  assert.equal(at(/^  await smokeWebhook\(url\);$/gm), 1, '冒烟调用点应唯一且紧跟 putSecret');
  assert.equal(at(/^  if \(dry\) \{$/gm) >= 1, true, 'dry 分支存在');
  assert.equal(at(/^    console\.log\('  --  跳过冒烟回打（--dry 未落库，没有刚写入的地址可验）'\);$/gm), 1, 'dry 跳过原因应唯一');
});

/* Worker 侧真发：接上「setup 写入 → Worker 读绑定 → 真发到 sink」这一截。
   冒烟回打用的是本地 url 变量，抓不到「写进去的值和 Worker 读到的值不是同一个」；
   这里用假 wrangler 捕获真正写进去的 name/value，再喂给真 webhook.js 的 notifyComment。
   注意：验的是代码链（写值 → 绑定名 → 真代码 → sink 接受），不是 CF 线上存储的读回——
   CF secrets 只可写不可读，那半仍属「评论端到端未验」，不冒充。 */
t('Worker 侧真发：写入值经 env.WEBHOOK_URL 绑定发出，sink 接受真通知', async () => {
  await withSmokeMock(async ({ url, fakeWrangler, hits, secretName, secretValue, bodies }) => {
    const r = run(['webhook', url], {
      WRANGLER_BIN: fakeWrangler,
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(secretName(), 'secret put WEBHOOK_URL', '写入目标必须是 Worker 读的那个键名');
    assert.equal(secretValue(), url, '写入值不能被包装或改写');
    const before = hits();
    assert.equal(before, 2, '前置测试 + 冒烟回打应各一次');
    await notifyComment({ WEBHOOK_URL: secretValue() }, {
      postTitle: '三层缓存',
      postUrl: 'https://miu.sryze.cc/p/three-layer-cache',
      name: '链路自检',
      content: 'Worker 侧真发断言',
    });
    assert.equal(hits(), before + 1, 'Worker 真代码必须真的发到 sink');
    const last = bodies().at(-1);
    assert.match(last.text, /💬 新评论 · 三层缓存/);
    assert.match(last.text, /链路自检：Worker 侧真发断言/);
    assert.match(last.text, /🔗 https:\/\/miu\.sryze\.cc\/p\/three-layer-cache/);
  }, { mode: 'chain' });
});

let pass = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${String(e.message).split('\n').slice(0, 4).join('\n        ')}`);
    process.exitCode = 1;
  }
}
console.log(`\n${pass}/${cases.length} 通过`);
