/* 评论防滥用。
 *
 * 三层，从便宜到贵，命中任何一层就拒：
 *   1) 蜜罐字段 —— 表单里有一个真人看不见的输入框，被填了就说明是脚本填表。
 *   2) 频率限制 —— D1 记「IP」和「设备 cookie」两把钥匙的额度：
 *      同 IP 60 秒一条、每天 10 条；同设备（cookie）每天 10 条。
 *      设备 cookie 是服务端发的，清掉了也只是换一把钥匙，IP 那把还在。
 *   3) Turnstile —— 只有配了 TURNSTILE_SECRET 才启用，Worker 侧拿 token 去
 *      siteverify 校验，前端无法伪造。没配就整层跳过，页面不会多一个第三方请求。
 *
 * 管理员自己发言不走这一层：调样式时最容易连发，先把自己限流住很蠢。
 *
 * 时区：日额度按 UTC+8 换天，和作者的生活时间对齐，而不是 UTC 零点。
 */

import { parseCookies, clientIp } from './utils.js';

export const MIN_GAP_SEC = 60; // 同 IP 相邻两条的最小间隔
export const DAY_MAX = 10; // 每天上限（IP 与设备各算各的）
const TZ_OFFSET = 8 * 3600;
const DID_COOKIE = 'cmt_did';
export const DID_MAX_AGE = 400 * 24 * 3600;

/** 当天日期键，按 UTC+8 切 */
export function dayKey(sec) {
  return new Date((sec + TZ_OFFSET) * 1000).toISOString().slice(0, 10);
}

/** 距下一个「本地零点」还有多少秒，给 429 的 retry-after 用 */
export function secsToNextDay(sec) {
  const local = sec + TZ_OFFSET;
  return 86400 - (local % 86400);
}

/**
 * 纯函数：拿库里的一行判断放不放行。
 * 抽出来是为了能单测，不用起 D1。
 */
export function judge(rec, nowSec, { minGap = MIN_GAP_SEC, dayMax = DAY_MAX, checkGap = true } = {}) {
  if (!rec) return { ok: true };
  if (Number(rec.banned) === 1) {
    return { ok: false, status: 403, error: '这个来源被拦下了，如果误伤请联系博主', retry: 3600 };
  }
  const hits = rec.day === dayKey(nowSec) ? Number(rec.hits) : 0;
  if (hits >= dayMax) {
    return {
      ok: false,
      status: 429,
      error: `今天已经发了 ${dayMax} 条，明天再来`,
      retry: secsToNextDay(nowSec),
    };
  }
  if (checkGap && rec.last_ts) {
    const gap = nowSec - Number(rec.last_ts);
    if (gap < minGap) {
      return { ok: false, status: 429, error: '发得太快了，隔一分钟再发', retry: minGap - gap };
    }
  }
  return { ok: true };
}

export function newDeviceId() {
  return crypto.randomUUID().replace(/-/g, '');
}

/**
 * 读限额 → 判断。不写库，真正计数在 record() 里，评论插入成功后才记。
 * 返回 { ok, status, error, retry, ip, did, fresh }，fresh 表示 did 是这次新发的。
 */
export async function guard(db, request, nowSec) {
  const ip = request.headers.get('cf-connecting-ip') || '0.0.0.0';
  const raw = parseCookies(request)[DID_COOKIE] || '';
  const did = /^[a-f0-9]{24,64}$/i.test(raw) ? raw.toLowerCase() : '';
  const fresh = !did;
  const id = did || newDeviceId();

  const keys = fresh ? [`ip:${ip}`] : [`ip:${ip}`, `dev:${id}`];
  const { results } = await db
    .prepare(`SELECT k, day, hits, last_ts, banned FROM comment_guard WHERE k IN (${keys.map(() => '?').join(',')})`)
    .bind(...keys)
    .all();
  const byKey = new Map(results.map((r) => [r.k, r]));

  const ipVerdict = judge(byKey.get(`ip:${ip}`), nowSec);
  if (!ipVerdict.ok) return { ...ipVerdict, ip, did: id, fresh };

  if (!fresh) {
    const devVerdict = judge(byKey.get(`dev:${id}`), nowSec, { checkGap: false });
    if (!devVerdict.ok) return { ...devVerdict, ip, did: id, fresh };
  }

  return { ok: true, ip, did: id, fresh };
}

/** 评论真的落库之后才记这一笔，被 400 拒掉的不占额度 */
export async function record(db, ip, did, nowSec) {
  const day = dayKey(nowSec);
  const upsert = `INSERT INTO comment_guard (k, day, hits, last_ts) VALUES (?, ?, 1, ?)
    ON CONFLICT(k) DO UPDATE SET
      hits = CASE WHEN comment_guard.day = ? THEN comment_guard.hits + 1 ELSE 1 END,
      day = ?,
      last_ts = ?`;
  await db.batch([
    db.prepare(upsert).bind(`ip:${ip}`, day, nowSec, day, day, nowSec),
    db.prepare(upsert).bind(`dev:${did}`, day, nowSec, day, day, nowSec),
  ]);
}

/* ---------------- 登录限流 ----------------
   复用 comment_guard 表，key 前缀 auth:。和评论额度**分两个桶**：
   评论被刷不该连累登录，登录被试探也不该消耗评论额度（P-033）。

   和评论的一处关键差别，别改回去：
   - 评论的额度在「落库成功」后才记，被 400 拒掉的不占额度；
   - 登录的额度在「发起尝试」时立刻记 —— 每次尝试都要向 GitHub POST 一次 token
     交换，有真实的出站成本。失败必须计数，否则用无效 code 无限刷永远不耗额度。

   口径：只做日上限，不做相邻间隔。登录重试是正常行为（输错、清 Cookie、换域名），
   卡 60 秒间隔会误伤；日上限 60 已经让爆破无利可图（GitHub 的 code 是一次性的，
   猜不出来，限流挡的是出站放大和 client_id 滥用，不是猜码）。 */
export const LOGIN_DAY_MAX = 60;
const LOGIN_KEY = (ip) => `auth:ip:${ip || 'unknown'}`;

/** 读登录额度。不写库；通过后由 recordLogin() 立刻记一笔。 */
export async function guardLogin(db, request, nowSec) {
  const ip = clientIp(request);
  const rec = await db
    .prepare('SELECT k, day, hits, last_ts, banned FROM comment_guard WHERE k = ?')
    .bind(LOGIN_KEY(ip))
    .first();
  const v = judge(rec, nowSec, { dayMax: LOGIN_DAY_MAX, checkGap: false });
  return { ...v, ip };
}

/** 登录尝试计数：判定通过就记，不等 token 结果。 */
export async function recordLogin(db, ip, nowSec) {
  const day = dayKey(nowSec);
  await db
    .prepare(
      `INSERT INTO comment_guard (k, day, hits, last_ts) VALUES (?, ?, 1, ?)
       ON CONFLICT(k) DO UPDATE SET
         hits = CASE WHEN comment_guard.day = ? THEN comment_guard.hits + 1 ELSE 1 END,
         day = ?,
         last_ts = ?`
    )
    .bind(LOGIN_KEY(ip), day, nowSec, day, day, nowSec)
    .run();
}

/** 拉黑一个 IP（管理员点「封 IP」时调） */export async function banIp(db, ip) {
  const day = dayKey(Math.floor(Date.now() / 1000));
  await db
    .prepare(
      `INSERT INTO comment_guard (k, day, hits, last_ts, banned) VALUES (?, ?, 0, 0, 1)
       ON CONFLICT(k) DO UPDATE SET banned = 1`
    )
    .bind(`ip:${ip}`, day)
    .run();
}

/**
 * Turnstile 的四种配置状态。半配比不配更危险：
 * 只配 sitekey 时前端会老老实实弹验证框、服务端却无从校验 —— 那层防护是假的。
 * 所以 site-only 一律按失败处理（宁可评论挂掉被发现，也别假装有验证）。
 * 反过来 secret-only 等于前端根本没组件，谁也给不出 token，只能当没开。
 */
export function turnstileMode(env = {}) {
  const site = !!(env && env.TURNSTILE_SITE_KEY);
  const secret = !!(env && env.TURNSTILE_SECRET);
  if (site && secret) return 'on';
  if (site) return 'site-only';
  if (secret) return 'secret-only';
  return 'off';
}

/**
 * Turnstile 校验。没配就整层跳过 —— 这也是默认状态，
 * 页面因此不会引入任何第三方脚本。
 *
 * expect.host / expect.action 是 token 的「出处」核对：
 * siteverify 回 success 只说明「有一枚有效 token 被兑换了」。同一个 sitekey
 * 也能在别人的页面里渲染（sitekey 是公开的），攻击者在自己站上弹一个框、
 * 过了验证，把 token 拿来打你的接口 —— 只要你不看 hostname/action，
 * 这一层就等于「任何人的真人都能替你投票」。两项都在 siteverify 的响应里，
 * 核对它们不用再发一次请求。
 */
export const TURNSTILE_ACTION = 'comment';

export async function verifyTurnstile(env, token, ip, expect = {}) {
  const mode = turnstileMode(env);
  if (mode === 'off') return { ok: true, skipped: true };
  if (mode === 'site-only') {
    // 页面在收 token，服务端却验不了：此时放行等于把假防护当真防护
    console.error('[antispam] 只配了 TURNSTILE_SITE_KEY，缺 TURNSTILE_SECRET，按配置不完整拒收');
    return { ok: false, error: '人机验证配置不完整，暂时无法评论' };
  }
  if (mode === 'secret-only') {
    console.warn('[antispam] 只配了 TURNSTILE_SECRET，前端没有组件，按未启用处理');
    return { ok: true, skipped: true };
  }

  const secret = env.TURNSTILE_SECRET;
  if (!token) return { ok: false, error: '请先完成人机验证' };

  const form = new FormData();
  form.append('secret', secret);
  form.append('response', String(token));
  if (ip) form.append('remoteip', ip);

  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });
    const d = await r.json();
    if (!d.success) return { ok: false, error: '人机验证没通过，刷新页面再试一次' };

    /* 严格比较：响应里没有 hostname / action 一律按不匹配处理。
       缺字段就放行的话，攻击者只要挑一条不返回该字段的路径（旧 token、别的 widget 类型）
       就能整体绕过这条复核。 */
    if (expect.host && d.hostname !== expect.host) {
      console.warn('[antispam] turnstile hostname 不符：', d.hostname, '!=', expect.host);
      return { ok: false, error: '人机验证来源不对，刷新页面再试一次' };
    }
    if (expect.action && d.action !== expect.action) {
      console.warn('[antispam] turnstile action 不符：', d.action, '!=', expect.action);
      return { ok: false, error: '人机验证来源不对，刷新页面再试一次' };
    }
    return { ok: true };
  } catch {
    // 校验服务自己挂了，不能连累评论功能 —— 记一笔降级，放行
    console.warn('[antispam] turnstile siteverify 不可达，本次降级放行');
    return { ok: true, degraded: true };
  }
}
