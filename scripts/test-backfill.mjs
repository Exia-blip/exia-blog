#!/usr/bin/env node
/* backfill 语义守门：空正文草稿（content=''）不该算欠账。
   线上真有一篇 0 字私密草稿，旧 check 把它计入 missing，
   导致补多少次都仍是 1，每轮验收误报。 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('./backfill-html.mjs', import.meta.url), 'utf8');

assert.match(src, /content\s*<>\s*''/, '--check SQL 必须排除空正文草稿');
assert.match(src, /html_content\s+IS\s+NULL\s+OR\s+html_content=''/, '--check 仍要检出真正的空 html_content');
assert.match(
  src,
  /rows\.filter\(\(r\)\s*=>\s*!r\.html_content\s*&&\s*r\.content\)/,
  '补齐分支也要跳过空正文草稿'
);

console.log('backfill: 3 passed');
