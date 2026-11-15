#!/usr/bin/env node
/**
 * CI 夹具：本地 D1 是空库，浏览器检查上去全是 404 —— 页面级断言没有靶子。
 * 这里造一组最小但够用的数据，让 check-ux / check-scroll-ui / check-toc-bar 有东西可测：
 *
 *   ci-fixture  有 5 个 h2（目录能出来）、含关键词「缓存」（搜索能命中）、
 *               有一个 240 字符的长代码行（横滚能触发）、正文够长（能滚、能出阅读百分比）
 *   ci-plain    没有任何小标题（验证「无目录时正文不被挤进目录列」）
 *   两条评论     一条 900 字（超过折叠阈值 220px）、一条几分钟前（相对时间不是「刚刚」）
 *
 *   node scripts/seed-ci.mjs            # 建表 + 灌数据（本地 D1）
 *   node scripts/seed-ci.mjs --sql      # 只打印 SQL，不执行
 *   node scripts/seed-ci.mjs --schema   # 只建表
 *
 * 幂等：先按 slug 删旧行再插，重复跑不会堆出重复文章。
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER = join(ROOT, 'node_modules/wrangler/bin/wrangler.js');

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/* 正文：5 个二级标题 + 关键词 + 长代码行 + 足够的段落长度。
   段落必须给足：正文高度减一屏才是进度条的分母，正文太短时「滚到半页」已经读完了，
   阅读百分比会直接显示 100% 而隐藏 —— 那是夹具不够长，不是组件坏了。 */
const FILLER = [
  '这一段是填充，用来把正文撑到足够高，让阅读进度在中段落在 5% 到 95% 之间，而不是一滚到底。',
  '夹具的长度是被断言反推出来的：正文高度必须显著大于一屏，否则百分比、目录高亮、回到顶部按钮都测不到位。',
  '缓存这个词在这篇里出现多次，是为了让搜索接口能命中，并且在摘要片段里落进关键词附近，前端高亮才有靶子。',
  '写检查脚本最怕的是「在空数据上跑绿」——页面 404、断言全过，比没有测试更危险。',
];
const para = (section, i) => `${FILLER[i % FILLER.length]}（第 ${section} 节第 ${i + 1} 段）`;

const section = (title, n = 8) => {
  const lines = [`## ${title}`, ''];
  for (let i = 0; i < n; i++) lines.push(para(title, i), '');
  return lines;
};

const BODY = [
  '这篇是 CI 夹具，不给人看，给检查脚本看。它需要同时满足四件事：能出目录、能搜到、能横滚、能滚出阅读百分比。',
  '',
  ...section('为什么需要夹具'),
  ...section('缓存的三种失效方式'),
  '```js',
  "const veryLongLine = '这段故意写得很长，用来把代码块撑出横向滚动条，检查脚本靠 .code-wrap.overflowing 判断是否标成了可横滚。如果这一行不够长，整个断言会静默跳过，所以宁可写长一点也不能刚好卡在边界上。再补一点字数确保它在 800px 宽的正文列里一定超出容器宽度，而不是差几个像素刚好塞进去。';",
  'console.log(veryLongLine.length);',
  '```',
  '',
  ...section('缓存键怎么拼'),
  ...section('增量构建与缓存'),
  ...section('落地清单'),
].join('\n');

/* 无小标题的文章：验证「没有目录时正文不吃列宽」 */
const PLAIN = '这一篇刻意不写小标题，用来确认正文在没有目录时仍然是整宽，而不是被挤进 232px 的目录列。\n\n再看一段普通正文，长度够填满一屏即可。';

const LONG_COMMENT =
  '这是一条故意写长的评论，用来触发折叠。' +
  '折叠阈值是渲染后的高度 220 像素，不是字数——同样四百字，中文十几行、英文混排能到三十行，' +
  '所以夹具必须写到足够长，长到在任何字体下都超过阈值，否则检查会变成「跳过」而不是「通过」。' +
  // CI runner 没装中文字体，回退字形的字宽更窄，同样字数能少排三分之一的行：
  // 438 字在本地是 299px，在 ubuntu runner 只有 190px。所以这里按「最窄字体」留余量。
  '以下内容没有实际意义，只是重复填充：'.repeat(60) +
  '结束。';

const SQL = `
-- 作者。缺失时 LEFT JOIN 出 NULL，页面上作者名是空的，但页面本身不报错——
-- 为了和线上一致，还是补一行。
INSERT INTO users (id, github_id, login, name, avatar, is_admin)
VALUES (1, 'ci', 'ci', 'CI', '', 1)
ON CONFLICT(id) DO NOTHING;

DELETE FROM comments WHERE post_id IN (SELECT id FROM posts WHERE slug IN ('ci-fixture', 'ci-plain'));
DELETE FROM posts WHERE slug IN ('ci-fixture', 'ci-plain');

INSERT INTO posts (slug, title, content, category, summary, published_at, author_id, created_at, updated_at)
VALUES
  ('ci-fixture', ${q('CI 夹具：缓存与增量构建')}, ${q(BODY)}, ${q('log')}, '',
   datetime('now', '-3 days'), 1, datetime('now', '-3 days'), datetime('now', '-3 days')),
  ('ci-plain', ${q('CI 夹具：无小标题')}, ${q(PLAIN)}, ${q('log')}, '',
   datetime('now', '-4 days'), 1, datetime('now', '-4 days'), datetime('now', '-4 days'));

-- 评论：一条 900 字（触发折叠），一条 5 分钟前（相对时间不是「刚刚」）
INSERT INTO comments (post_id, parent_id, name, content, is_admin, ip, created_at)
SELECT id, NULL, '路人甲', ${q(LONG_COMMENT)}, 0, '', datetime('now', '-2 hours') FROM posts WHERE slug = 'ci-fixture';

INSERT INTO comments (post_id, parent_id, name, content, is_admin, ip, created_at)
SELECT id, NULL, 'CI', ${q('夹具评论，用来验证相对时间与折叠按钮。')}, 1, '', datetime('now', '-5 minutes') FROM posts WHERE slug = 'ci-fixture';
`;

function runWrangler(args) {
  execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', 'blog-db', '--local', ...args], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

const argv = process.argv.slice(2);
if (argv.includes('--sql')) {
  process.stdout.write(SQL);
  process.exit(0);
}

console.log('建表（schema.sql）…');
runWrangler(['--file=./schema.sql']);

if (!argv.includes('--schema')) {
  console.log('灌数据…');
  const dir = mkdtempSync(join(tmpdir(), 'seed-ci-'));
  const file = join(dir, 'seed.sql');
  writeFileSync(file, SQL, 'utf8');
  runWrangler([`--file=${file}`]);
  console.log('完成：ci-fixture / ci-plain 两篇 + 两条评论');
}
