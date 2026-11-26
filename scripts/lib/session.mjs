// 后台会话凭据的取法：dev 认 SESSION_SECRET，线上认 LIVE_SESSION_SECRET。
//
// 抽出来是因为有两个调用方（admin-autologin 验收、notify-resend 补发），
// 各抄一份的结果是「一处认错版本」，而症状是 401/302 —— 会被读成签名坏了。
// 不做「缺一版就回退另一版」：那让「配错环境」和「登录失败」长成同一个样子。
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const isLocalHost = (origin) => {
  try {
    const h = new URL(origin).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
};

/* 只读 .dev.vars，不写、不打印。文件本身在 .gitignore 里，见第 5 行的注释。 */
export const loadKv = () => {
  const p = join(ROOT, '.dev.vars');
  if (!existsSync(p)) return {};
  return Object.fromEntries(
    readFileSync(p, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      })
  );
};

/* env 优先于文件：临时换一版不用改文件。want 一并返回，报错时能说清缺的是哪一版。 */
export const pickSecret = (local, env, kv) => {
  const want = local ? 'SESSION_SECRET' : 'LIVE_SESSION_SECRET';
  const fromEnv = String((env && env[want]) || '').trim();
  if (fromEnv) return { secret: fromEnv, from: `env ${want}`, want };
  const fromFile = String((kv && kv[want]) || '').trim();
  if (fromFile) return { secret: fromFile, from: `.dev.vars ${want}`, want };
  return { secret: '', from: '', want };
};

/* 签一张短效管理员票。token 只活在调用方内存里，返回值不打印、不落盘。 */
export async function adminCookie({ origin, uid = 1, ttl = 120 } = {}) {
  const { signToken } = await import('../../src/utils.js');
  const local = isLocalHost(origin);
  const picked = pickSecret(local, process.env, loadKv());
  const sid = String(process.env.ADMIN_SID || '').trim();
  if (sid) return { cookie: `sid=${encodeURIComponent(sid)}`, local, from: 'env ADMIN_SID（现成会话）', want: 'ADMIN_SID', ttl: 0 };
  return {
    need: picked.want,
    secret: picked.secret,
    local,
    from: picked.from,
    ttl,
    cookie: picked.secret ? `sid=${encodeURIComponent(await signToken(picked.secret, { uid, admin: 1 }, ttl))}` : '',
  };
}
