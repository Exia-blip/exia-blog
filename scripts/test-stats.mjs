// 访问统计：好数字来自几条容易被忽略的规则，逐条钉住。
// 这些规则不会被页面渲染暴露出来 —— UV 多算一个少算一个，页面上看不出对错。
import assert from 'node:assert/strict';
import { dayCN, deviceOf, refHost, BOT_RE, renderStats } from '../src/stats.js';

let pass = 0;
const t = (name, fn) => {
  fn();
  pass++;
  console.log('  ok  ' + name);
};

/* ---------- 切日 ---------- */
t('dayCN 按北京时间切日，不是 UTC', () => {
  // 北京时间 2026-11-14 02:00 = UTC 2026-11-13 18:00，两者日期不同
  const utc = new Date('2026-11-13T18:00:00Z');
  const real = Date.now;
  Date.now = () => utc.getTime();
  try {
    assert.equal(dayCN(), '2026-11-14');
  } finally {
    Date.now = real;
  }
});

t('dayCN 能往前推 N 天，跨月也对', () => {
  const real = Date.now;
  Date.now = () => new Date('2026-12-02T04:00:00Z').getTime(); // 北京 12-02 12:00
  try {
    assert.equal(dayCN(1), '2026-12-01');
    assert.equal(dayCN(29), '2026-11-03');
  } finally {
    Date.now = real;
  }
});

/* ---------- 设备 ---------- */
t('iPhone / Android 手机记为 mobile', () => {
  assert.equal(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)'), 'mobile');
  assert.equal(deviceOf('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile'), 'mobile');
});

t('iPad 记成 tablet 而不是 mobile', () => {
  // iPad 的 UA 里也带 Mobile 字样，判断顺序反了就会把它算进手机
  assert.equal(deviceOf('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Mobile/15E148'), 'tablet');
});

t('桌面浏览器算 pc', () => {
  assert.equal(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'pc');
});

/* ---------- 来源 ---------- */
t('站内跳转不算外部来源', () => {
  assert.equal(refHost('https://exia.de5.net/p/a', 'exia.de5.net'), '');
});

t('外站只留域名，路径和参数一律丢掉', () => {
  assert.equal(refHost('https://www.google.com/search?q=secret+token', 'exia.de5.net'), 'www.google.com');
});

t('空来源、非法来源、非 http(s) 都返回空串', () => {
  assert.equal(refHost('', 'exia.de5.net'), '');
  assert.equal(refHost('不是网址', 'exia.de5.net'), '');
  assert.equal(refHost('javascript:alert(1)', 'exia.de5.net'), '');
  assert.equal(refHost('ftp://example.com/x', 'exia.de5.net'), '');
});

t('超长域名截到 80 字符，不让脏数据撑爆列', () => {
  const long = 'https://' + 'a'.repeat(200) + '.com/x';
  assert.equal(refHost(long, 'exia.de5.net').length, 80);
});

/* ---------- 爬虫 ---------- */
t('常见爬虫与无头浏览器被识别', () => {
  for (const ua of [
    'Mozilla/5.0 (compatible; Googlebot/2.1)',
    'Mozilla/5.0 (compatible; bingbot/2.0)',
    'HeadlessChrome/120.0.0.0',
    'curl/8.4.0',
    'python-requests/2.31.0',
  ]) {
    assert.ok(BOT_RE.test(ua), ua);
  }
});

t('正常浏览器不会被误杀', () => {
  for (const ua of [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile Safari/604.1',
    'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
  ]) {
    assert.ok(!BOT_RE.test(ua), ua);
  }
});

/* ---------- 报表渲染 ---------- */
const day = (d, pv, uv) => ({ day: d, pv, uv });

t('报表把三个区间的人数照原样显示，不四舍五入', () => {
  const h = renderStats({
    user: { login: 'exia' },
    t1: { pv: 3, uv: 2 },
    t7: { pv: 41, uv: 17 },
    t30: { pv: 260, uv: 88 },
    dailyRows: [day('2026-11-14', 3, 2), day('2026-11-13', 9, 5)],
    top: { results: [{ path: '/p/oauth-device-flow', c: 12 }] },
    refs: { results: [{ ref: 'www.google.com', c: 4 }] },
    kinds: { results: [{ kind: 'mobile', c: 30 }] },
    total: { c: 260, first: '2026-11-01' },
  });
  assert.match(h, />41</);
  assert.match(h, /独立访客 17/);
  assert.match(h, /\/p\/oauth-device-flow/);
  assert.match(h, /www\.google\.com/);
  assert.match(h, /mobile/);
  assert.match(h, /2026-11-01/);
});

t('没有数据时不报错，给一句「还没有数据」', () => {
  const h = renderStats({
    user: { login: 'exia' },
    t1: null,
    t7: null,
    t30: null,
    dailyRows: [],
    top: { results: [] },
    refs: { results: [] },
    kinds: { results: [] },
    total: null,
  });
  assert.match(h, /还没有数据/);
  assert.match(h, />0</);
  assert.match(h, /起于 —/);
});

t('路径与来源里的尖括号一律转义，脏数据变不成标签', () => {
  const h = renderStats({
    user: { login: 'exia' },
    t1: { pv: 1, uv: 1 },
    t7: { pv: 1, uv: 1 },
    t30: { pv: 1, uv: 1 },
    dailyRows: [day('2026-11-14', 1, 1)],
    top: { results: [{ path: '/<img src=x onerror=alert(1)>', c: 1 }] },
    refs: { results: [{ ref: '<script>alert(1)</script>', c: 1 }] },
    kinds: { results: [] },
    total: { c: 1, first: '2026-11-14' },
  });
  assert.ok(!/<img src=x onerror/.test(h), '路径没被转义');
  assert.ok(!/<script>alert/.test(h), '来源没被转义');
  assert.match(h, /&lt;img src=x/);
});

t('柱状图高度封顶 100%，不会把最高那根撑出容器', () => {
  const h = renderStats({
    user: { login: 'exia' },
    t1: { pv: 5, uv: 1 },
    t7: { pv: 5, uv: 1 },
    t30: { pv: 5, uv: 1 },
    dailyRows: [day('2026-11-14', 5, 1), day('2026-11-13', 0, 0)],
    top: { results: [] },
    refs: { results: [] },
    kinds: { results: [] },
    total: { c: 5, first: '2026-11-14' },
  });
  for (const m of h.matchAll(/height:(\d+)%/g)) {
    assert.ok(Number(m[1]) <= 100, m[1]);
  }
});

console.log(`\n${pass} 条通过`);
