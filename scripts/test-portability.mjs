/* 可搬迁性守门：换域名不该改代码，换账号要能整包搬走。
   两条线：
   1. 运行时源码里不许再出现生产域名（测试脚本里的样例 URL 不算运行时）
   2. 迁移脚本必须 D1 + 配置 + R2 清单齐全，且 secrets 只记名字不记值
*/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const src = read('src/cron.js');
const friends = read('public/friends.html');
const mig = read('scripts/migrate.mjs');
const pkg = JSON.parse(read('package.json'));
const readme = read('README.md');

let n = 0;
let bad = 0;
const t = async (name, fn) => {
  n++;
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { bad++; console.log(`  FAIL ${name}\n       ${e.message.split('\n')[0]}`); }
};

const PROD = /exia\.de5\.net/;

await t('cron：运行时不再硬编码生产域名', () => {
  const runtime = src.split('\n').filter((l) => !/^\s*\*|^\s*\/\/|LEGACY_SELF_HOSTS|DEFAULT_ORIGIN/.test(l)).join('\n');
  assert.ok(!PROD.test(runtime), '运行时代码仍有 exia.de5.net 字面量');
});

await t('cron：UA / 自环集合都从 env 派生', () => {
  assert.ok(src.includes('originOf(env)'), '缺 originOf(env)');
  assert.ok(src.includes('uaOf(env)'), '缺 uaOf(env)');
  assert.ok(src.includes('selfHostsOf(env)'), '缺 selfHostsOf(env)');
  assert.ok(src.includes('probe(f.url, selfHosts, ua)'), 'probe 未接运行时参数');
});

await t('cron：resolveTarget 支持注入 selfHosts（可测）', () => {
  assert.ok(/function resolveTarget\(raw, selfHosts\)/.test(src));
  assert.ok(src.includes('(selfHosts || new Set(LEGACY_SELF_HOSTS))'), '缺无参兜底');
});

await t('friends：友链示例域名从 canonical 派生', () => {
  assert.ok(!PROD.test(friends), 'friends.html 仍有生产域名');
  assert.ok(friends.includes('link[rel="canonical"]'));
  assert.ok(friends.includes('demo.textContent'), '示例应纯文本写入，防站名注入 HTML');
});

await t('migrate：三种子命令齐全', () => {
  for (const c of ['plan', 'export', 'import']) assert.ok(mig.includes(`cmd === '${c}'`), `缺 ${c}`);
  assert.ok(mig.includes("argv.includes('--apply')"), 'import 缺 --apply 保护');
});

await t('migrate：导出 D1 全库而非只导 schema', () => {
  assert.ok(mig.includes("'d1', 'export', cfg.databaseName, '--remote'"));
  assert.ok(!mig.includes('--schema-only'), '只导 schema 会丢正文');
  assert.ok(mig.includes('--no-data') === false, '不能排除数据');
});

await t('migrate：secrets 只记名字，值不导出', () => {
  assert.ok(mig.includes("'secret', 'list'"));
  assert.ok(!/secret\s*,\s*'put'/.test(mig.slice(mig.indexOf("const secretNames"), mig.indexOf("const r2Keys"))),
    '采集阶段不应调 secret put');
  assert.ok(mig.includes('secrets,\n    r2_keys'), 'manifest 应含 secrets 名字清单');
});

await t('migrate：R2 清单含变体后缀', () => {
  assert.ok(mig.includes('(?:\\.[a-z0-9]+)*'), '正则未覆盖 .jpg.w480.avif 这类变体');
  assert.ok(mig.includes('r2-get.sh') && mig.includes('r2-put.sh'));
  assert.ok(mig.includes("[ -s '${tmp}' ]"), '缺空文件保护，404 会把空壳灌进新桶');
});

await t('migrate：import 默认 dry-run', () => {
  const block = mig.slice(mig.indexOf("if (cmd === 'import')"));
  const execIdx = block.indexOf("wrangler(['d1', 'execute'");
  const applyIdx = block.indexOf('if (!apply)');
  assert.ok(applyIdx > 0 && execIdx > applyIdx, '执行应在 dry-run 分支之后');
});

await t('npm scripts 已注册', () => {
  for (const s of ['migrate:plan', 'migrate:export', 'migrate:import']) assert.ok(pkg.scripts[s], `缺 ${s}`);
});

await t('README 说明换域名不搬数据', () => {
  assert.ok(readme.includes('换域名（同一个 Cloudflare 账号）不需要搬数据'));
  assert.ok(readme.includes('migrate:export'));
});

/* 动态验证：光看源码写了 env 派生不够，得真跑一轮 checkFriends，
   确认「新域名的友链」被判 self（status=1, 0ms），且没有真的发出 fetch。
   若仍用旧硬编码集合，这条会去外网探测 → status 0，测试立刻红。 */
const { checkFriends } = await import('../src/cron.js');
let fetches = 0;
const oldFetch = globalThis.fetch;
globalThis.fetch = async () => { fetches++; throw new Error('不该发出的探测请求'); };

const mkEnv = (origin) => {
  const binds = [];
  return {
    env: {
      SITE_ORIGIN: origin,
      DB: {
        prepare: () => ({
          bind: (...args) => ({
            all: async () => ({ results: [{ id: 7, url: 'https://brand-new.example.org/' }] }),
            run: async () => {},
            _args: args,
          }),
        }),
        batch: async (stmts) => {
          for (const s of stmts) binds.push(s);
        },
      },
    },
    binds,
  };
};

await t('动态：新 SITE_ORIGIN 下的本站友链判 self，不探测', async () => {
  const { env, binds } = mkEnv('https://brand-new.example.org');
  const r = await checkFriends(env);
  assert.equal(r.checked, 1);
  assert.equal(fetches, 0, `发出了 ${fetches} 次本不该有的外网探测`);
  // UPDATE 的 bind 参数：[status, code, ms, stamp, id]，self = status 1 / code 0 / ms 0
  assert.ok(binds.length > 0, '没有写出探测结果');
});
await t('动态：无关的第三方域名仍会走探测（不被误判 self）', async () => {
  fetches = 0;
  const { env } = mkEnv('https://brand-new.example.org');
  // 换一条外链：直接改 prepare 的返回
  env.DB.prepare = () => ({
    bind: () => ({
      all: async () => ({ results: [{ id: 8, url: 'https://third-party.example.net/' }] }),
      run: async () => {},
    }),
  });
  await checkFriends(env);
  assert.equal(fetches, 1, '外链应被探测一次');
});
globalThis.fetch = oldFetch;

console.log(`\n${n - bad}/${n} 通过\n`);
process.exit(bad ? 1 : 0);
