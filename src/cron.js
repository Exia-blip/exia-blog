import { nowISO } from './utils.js';

const UA =
  'Mozilla/5.0 (compatible; BlogFriendCheck/1.0; +https://developers.cloudflare.com/workers/)';

async function check(url) {
  const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const res = await fetch(target, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(8000),
      cf: { cacheTtl: 0 },
    });
    return res.status >= 200 && res.status < 400 ? 1 : 0;
  } catch {
    return 0;
  }
}

export async function checkFriends(env) {
  const { results } = await env.DB.prepare('SELECT id, url FROM friends').all();
  if (!results || !results.length) return { checked: 0 };

  const stamp = nowISO();
  const jobs = results.map(async (f) => {
    const status = await check(f.url);
    await env.DB.prepare('UPDATE friends SET status = ?, checked_at = ? WHERE id = ?')
      .bind(status, stamp, f.id)
      .run();
    return status;
  });

  // 并发限流，每批 10 个
  for (let i = 0; i < jobs.length; i += 10) {
    await Promise.all(jobs.slice(i, i + 10));
  }

  return { checked: results.length };
}
