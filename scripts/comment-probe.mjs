/* 待审渲染探针：造一条 pending 评论 → 抓后台 HTML 核对 → 删掉 → 再核对。
   用来验「有 1 条待审时，侧栏徽章 / 待办条 / 评论页三处都跟着动」——
   这三处以前有一处漏传 counts（stats 页），界面上完全看不出来。

   **验的是渲染，不是 pending 链路**：管理员发评论豁免先审后发，
   非管理员过不了 Turnstile，所以 pending 只能改库构造。别把这条读成「提交链路已验」。

   三条硬边界（别改）：
   ① 只 INSERT 自己这一行，绝不 UPDATE 现有行 —— 改真实数据再改回去，存在改不回去的可能；
   ② DELETE 走 `WHERE id=? AND name=?` 双条件，不用 `WHERE status='pending'`（会连真待审一起删）；
   ③ 造出来的行 `notify_status='ok'`，让每 20 分钟一轮的 cron 补推跳过它
      （补推只捞 ''/fail），免得探针往群里发消息。

   默认 dry：只报当前基数，不写库。加 --apply 才真造（会短暂写一行，退出前必删）。

   D1 查询一律走 lib/d1.mjs（不内联 spawn）。理由不是洁癖：`execFileSync('npx')`
   在 Windows 上进程根本起不来（npx 是 .cmd），而报错只写 spawnSync；退化成
   `shell: true` 又把带空格的 SQL 拆成十几个参数，最后由 SQL 解析器报语法错 ——
   两种情况都会把人送到错的地方去改（P-083）。 */
import { adminCookie } from './lib/session.mjs';
import { d1Query, sqlStr } from './lib/d1.mjs';

const argv = process.argv.slice(2);
const arg = (k, d = '') => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const LOCAL = argv.includes('--local');
const APPLY = argv.includes('--apply');
const ORIGIN = arg('origin', LOCAL ? 'http://127.0.0.1:8788' : 'https://miu.sryze.cc').replace(/\/$/, '');
const UID = Number(arg('uid', '1')) || 1;

const MARK = '__pending-probe';
const CONTENT = '这是一条用于验证后台待审徽章渲染的临时探针，验完即删，对访客不可见。';

let failed = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else {
    console.log(`  FAIL ${msg}`);
    failed++;
  }
};

/* 从页面里抠一个数字。先按 id 截出那个 <a> 的片段再在片段里找 sv-pill ——
   直接在整页里正则 + N 个字符窗口，会串到相邻那一项上去（两项都带徽章时静默取错）。 */
const segOf = (html, id) => {
  const i = html.indexOf(`id="${id}"`);
  if (i < 0) return '';
  const j = html.indexOf('</a>', i);
  return html.slice(i, j < 0 ? i + 400 : j);
};
const pillOf = (html, id) => {
  const m = segOf(html, id).match(/sv-pill[^>]*>([^<]*)</);
  return m ? Number(m[1]) : 0;
};
const todoCellOf = (html) => {
  const m = html.match(/待审评论\s*<a[^>]*>([^<]*)</);
  return m ? Number(m[1]) : NaN;
};
const reviewPillOf = (html) => {
  const m = html.match(/待审评论\s*(\d+)\s*条/);
  return m ? Number(m[1]) : NaN;
};

const countPending = () =>
  Number(d1Query("SELECT COUNT(*) AS c FROM comments WHERE status='pending'", { local: LOCAL })[0].c);

console.log(`待审渲染探针：${ORIGIN} · ${LOCAL ? '本地库' : '线上库'} · ${APPLY ? '真造（退出前必删）' : 'dry（不写库）'}`);

const base = countPending();
const leftover = Number(d1Query(`SELECT COUNT(*) AS c FROM comments WHERE name=${sqlStr(MARK)}`, { local: LOCAL })[0].c);
console.log(`当前待审计数：${base}${leftover ? ` · ⚠ 有 ${leftover} 条上次残留的探针` : ''}`);

if (!APPLY) {
  console.log('\n（dry：什么都没写。要真造一条看渲染，加 --apply。造的那条会在退出前删掉。）');
  process.exit(0);
}

const cred = await adminCookie({ origin: ORIGIN, uid: UID, ttl: 120 });
if (!cred.cookie) {
  console.error(`\n✗ 没有会话票：缺 ${cred.need}（${cred.local ? '本地' : '线上'}密钥不同源时会 401）`);
  process.exit(1);
}

const grab = async (p) => {
  const r = await fetch(`${ORIGIN}${p}`, { headers: { cookie: cred.cookie }, signal: AbortSignal.timeout(20000) });
  return { status: r.status, html: await r.text() };
};

let id = 0;
try {
  /* 上次异常中断留下的行先清掉，否则「+1」算不准。只按自己的 name 清。 */
  if (leftover) {
    d1Query(`DELETE FROM comments WHERE name=${sqlStr(MARK)}`, { local: LOCAL });
    console.log(`已清理 ${leftover} 条残留探针`);
  }

  const post = d1Query(
    `SELECT id FROM posts WHERE is_private=0 AND hidden=0 AND review_status='approved'
       AND published_at<=datetime('now') ORDER BY published_at DESC LIMIT 1`,
    { local: LOCAL }
  )[0];
  if (!post) throw new Error('找不到已发布文章，无法挂评论');

  d1Query(
    `INSERT INTO comments (post_id,name,email,website,content,is_admin,ip,created_at,status,notify_status,notify_note,notified_at)
     VALUES (${Number(post.id)},${sqlStr(MARK)},'probe@example.invalid','',${sqlStr(CONTENT)},0,'127.0.0.1',
             datetime('now'),'pending','ok','探针（不投递）',datetime('now'))`,
    { local: LOCAL }
  );
  id = Number(d1Query(`SELECT id FROM comments WHERE name=${sqlStr(MARK)} ORDER BY id DESC LIMIT 1`, { local: LOCAL })[0].id);
  console.log(`\n已插入 pending 探针：#${id}（挂在 post_id=${post.id}）`);

  const expect = base + 1;
  const d1 = await grab('/admin');
  const d2 = await grab('/admin/comments');
  check(d1.status === 200, `概览页 HTTP 200（实得 ${d1.status}）`);
  check(d2.status === 200, `评论页 HTTP 200（实得 ${d2.status}）`);

  check(todoCellOf(d1.html) === expect, `概览待办条「待审评论」= ${expect}（实得 ${todoCellOf(d1.html)}）`);
  check(pillOf(d1.html, 'nav-cmts') === expect, `侧栏 nav-cmts 徽章 = ${expect}（实得 ${pillOf(d1.html, 'nav-cmts')}）`);
  check(reviewPillOf(d2.html) === expect, `评论页顶部待审 = ${expect}（实得 ${reviewPillOf(d2.html)}）`);
  check(d2.html.includes(MARK), '评论列表里能看到这条探针');
} finally {
  if (id) {
    d1Query(`DELETE FROM comments WHERE id=${id} AND name=${sqlStr(MARK)}`, { local: LOCAL });
    const left = Number(d1Query(`SELECT COUNT(*) AS c FROM comments WHERE name=${sqlStr(MARK)}`, { local: LOCAL })[0].c);
    console.log(`\n清理：DELETE WHERE id=${id} AND name='${MARK}' → 残留 ${left} 条`);
    if (left !== 0) {
      console.log('✗ 残留未清干净，需人工处理（DELETE 带了 id + name 双条件仍有剩，说明还有别的行）');
      failed++;
    }

    /* 删后再抓一次：徽章消失才证明数字是数据驱动的，不是一次快照。
       这一步是探针和「截图存档」的区别。 */
    if (left === 0) {
      const after = await grab('/admin');
      check(after.status === 200, `删后概览页 HTTP 200（实得 ${after.status}）`);
      check(todoCellOf(after.html) === base, `删后「待审评论」回到 ${base}（实得 ${todoCellOf(after.html)}）`);
      check(pillOf(after.html, 'nav-cmts') === base, `删后侧栏徽章回到 ${base}（实得 ${pillOf(after.html, 'nav-cmts')}）`);
    }
  }
}

console.log(`\n${failed ? `✗ ${failed} 项未通过` : '✓ 待审渲染链路通过（验的是渲染，不是 pending 提交链路）'}`);
process.exit(failed ? 1 : 0);
