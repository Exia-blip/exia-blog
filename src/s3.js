// Cloudflare R2 的 S3 兼容接口 presigned PUT，纯 WebCrypto 实现 SigV4
const enc = new TextEncoder();

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sha256(data) {
  return hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, typeof data === 'string' ? enc.encode(data) : data));
}

function amzDate(d = new Date()) {
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amz: iso, date: iso.slice(0, 8) };
}

// RFC3986 编码，保留 /
const uriEncode = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** SigV4 签名密钥派生（可单测） */
export async function deriveSigningKey(secretKey, date, region, service) {
  let k = await hmac(enc.encode(`AWS4${secretKey}`), date);
  k = await hmac(k, region);
  k = await hmac(k, service);
  k = await hmac(k, 'aws4_request');
  return k;
}

export { hmac as _hmac, hex as _hex, sha256 as _sha256 };

/**
 * 生成 presigned PUT URL
 * @returns {Promise<string>}
 */
export async function presignPut(env, key, expires = 900) {
  const accountId = env.R2_ACCOUNT_ID;
  const accessKey = env.R2_ACCESS_KEY_ID;
  const secretKey = env.R2_SECRET_ACCESS_KEY;
  const bucket = env.R2_BUCKET_NAME || 'blog-images';

  if (!accountId || !accessKey || !secretKey) {
    throw new Error('R2 S3 凭据未配置');
  }

  const host = `${accountId}.r2.cloudflarestorage.com`;
  const { amz, date } = amzDate();
  const scope = `${date}/auto/s3/aws4_request`;

  const canonicalUri = `/${bucket}/${key.split('/').map(uriEncode).join('/')}`;
  const query = [
    `X-Amz-Algorithm=AWS4-HMAC-SHA256`,
    `X-Amz-Credential=${encodeURIComponent(`${accessKey}/${scope}`)}`,
    `X-Amz-Date=${amz}`,
    `X-Amz-Expires=${expires}`,
    `X-Amz-SignedHeaders=host`,
  ].join('&');

  const canonicalRequest = ['PUT', canonicalUri, query, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amz, scope, await sha256(canonicalRequest)].join('\n');

  const k = await deriveSigningKey(secretKey, date, 'auto', 's3');
  const sig = hex(await hmac(k, stringToSign));

  return `https://${host}${canonicalUri}?${query}&X-Amz-Signature=${sig}`;
}

export const IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
};

export function makeKey(name) {
  const ext = (String(name || '').split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
  const d = new Date();
  const ym = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  return `u/${ym}/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${ext}`;
}
