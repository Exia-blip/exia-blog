#!/usr/bin/env node
/**
 * 评论巡检的手动入口：补推没送到的通知、按打分删机械可判定的垃圾评论。
 *
 * 真正的「自动」在 cron 里（每 20 分钟一轮，与友链巡检同一个触发器），跑的是
 * 同一个 sweepComments。这个脚本只做两件事：看现在会删谁、必要时立刻执行一次。
 *
 * 用法：
 *   npm run comment:sweep                 # 只看（默认 dry：不发消息、不删行）
 *   npm run comment:sweep -- --apply      # 真跑一次（补推 + 删除）
 *   npm run comment:sweep -- --origin=http://127.0.0.1:8788
 *
 * 默认 dry 是刻意的：自动删除的风险不在「删错一条」，在「删错一批没人知道」。
 * 先看一眼命中理由，再决定要不要 --apply。
 */
import { adminCookie } from './lib/session.mjs';

const die = (msg, code = 1) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(code);
};
const arg = (k, d = '') => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};

const ORIGIN = arg('origin', 'https://miu.sryze.cc').replace(/\/$/, '');
const uid = Number(arg('uid', '1')) || 1;
const ttl = Math.max(30, Math.min(Number(arg('ttl', '120')) || 120, 3600));
const apply = process.argv.slice(2).includes('--apply');

const cred = await adminCookie({ origin: ORIGIN, uid, ttl });
if (!cred.cookie) {
  die(
    cred.local
      ? `缺 ${cred.need}：本地 .dev.vars 配好，或 export ${cred.need}=... 后重跑。`
      : `缺 ${cred.need}：在本机 .dev.vars 补一行 ${cred.need}=<线上现役 SESSION_SECRET>（已 gitignore）。`
  );
}

console.log(
  `评论巡检：${ORIGIN} · ${cred.local ? 'dev 版' : '线上版'} · 凭据 ${cred.from} · ${
    apply ? '真跑（会补推并删除）' : '只报告（加 --apply 才动手）'
  }`
);

const r = await fetch(`${ORIGIN}/api/comments/sweep`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: cred.cookie },
  body: JSON.stringify({ dry: !apply }),
  signal: AbortSignal.timeout(30000),
});
if (r.status === 401) die('401：票没被认（LIVE_SESSION_SECRET 与线上不同源？）', 3);
if (r.status === 403) die('403：这个 uid 不是管理员，用 --uid=<管理员 id>', 3);
if (!r.ok) die(`HTTP ${r.status}：${(await r.text()).slice(0, 200)}`, 3);

const out = await r.json();

/* 补推 */
if (out.skipped === 'no-webhook') {
  console.log('\n补推：跳过（线上没配 WEBHOOK_URL）');
} else if (!out.retried?.length) {
  console.log('\n补推：没有待补的（该送的都送了）');
} else {
  console.log(`\n补推 ${out.retried.length} 条：`);
  for (const x of out.retried) console.log(`  #${x.id}  ${x.status}${x.note ? ` · ${x.note}` : ''}`);
}

/* 垃圾 */
if (!out.deleted?.length) {
  const ex = Number(out.exempt || 0);
  console.log(
    `\n垃圾：0 条命中（保留 ${out.kept} 条已过打分线${ex ? `，免检跳过 ${ex} 条（管理员/有回复/已拒绝）` : ''}）`
  );
} else {
  console.log(`\n${out.dry ? '待删' : '已删'} ${out.deleted.length} 条：`);
  for (const d of out.deleted) {
    console.log(`  #${d.id}  score=${d.score}  ${d.reasons.join(', ')}  ${d.name}`);
  }
  if (out.dry) console.log('\n（dry：什么都没动。确认无误后加 --apply 真跑一次）');
  else console.log('\n理由已写进 audit_log（action=comment.spam.purge），事后能查是哪条规则删的。');
}
