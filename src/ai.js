// 文章 AI 摘要
// 优先级：Workers AI（env.AI 绑定）→ 外部 OpenAI 兼容接口（AI_API_KEY）→ 抽取式兜底
// 全程 try/catch：生成失败绝不影响保存

const SYS = `你在为个人博客生成导读摘要。读标题和正文，写一段 60~110 字的中文摘要。
要求：
1. 直接说这篇文章讲了什么、给了哪些结论或做法；
2. 不要用「本文」「这篇文章」「作者」开头，不要分点，不要复述标题；
3. 不要加引号、不要写「摘要：」，只输出摘要正文。`;

const MAX_INPUT = 2600;

/* 正文清洗：去掉代码块、图片、链接语法、标题符号、HTML 标签、多余空行 */
export function plainText(content = '') {
  return String(content)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/[*_~>|]/g, ' ')
    .replace(/#[\p{L}\p{N}_-]{1,24}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* 内容指纹：判断"正文有没有实质变化"，避免每次保存都重新烧 token */
export function contentHash(content = '') {
  const s = plainText(content);
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = (h1 ^ c) * 0x01000193;
    h2 = (h2 + c * (i + 1)) % 0x7fffffff;
    h1 >>>= 0;
  }
  return `${s.length.toString(36)}-${(h1 >>> 0).toString(36)}-${h2.toString(36)}`;
}

function tidy(text) {
  let s = String(text || '')
    .replace(/^[\s"'“”‘’「」『』]+/, '')
    .replace(/[\s"'“”‘’「」『』]+$/, '')
    .replace(/^(摘要|导读|总结)[:：]\s*/i, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > 180) {
    const cut = s.slice(0, 180);
    const dot = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'));
    s = dot > 60 ? cut.slice(0, dot + 1) : cut + '…';
  }
  return s;
}

export function hasAI(env) {
  return !!(env && (env.AI || env.AI_API_KEY));
}

/* Workers AI
   默认模型：qwen3-30b-a3b（中文好、3 秒左右）；失败退到 llama-3.3-70b。
   注意：qwen3 这类带思考的模型要留足 max_tokens，否则 content 会是 null。 */
const DEFAULT_MODELS = [
  '@cf/qwen/qwen3-30b-a3b-fp8',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-3.1-8b-instruct-fp8',
];

function pickText(out) {
  if (!out) return '';
  if (typeof out === 'string') return out;
  if (typeof out.response === 'string' && out.response.trim()) return out.response;
  const c = out.choices?.[0]?.message?.content;
  if (typeof c === 'string' && c.trim()) return c;
  if (typeof out.result?.response === 'string') return out.result.response;
  return '';
}

async function viaWorkersAI(env, prompt) {
  if (!env.AI) return '';
  const models = env.AI_MODEL ? [env.AI_MODEL, ...DEFAULT_MODELS] : DEFAULT_MODELS;
  for (const model of models) {
    try {
      const out = await env.AI.run(model, {
        messages: [
          { role: 'system', content: SYS },
          { role: 'user', content: prompt },
        ],
        max_tokens: 1400,
        temperature: 0.3,
      });
      const text = pickText(out);
      if (text) return text;
      console.warn('workers-ai empty content', model);
    } catch (e) {
      console.warn('workers-ai failed', model, e.message);
    }
  }
  return '';
}

/* 外部 OpenAI 兼容接口（DeepSeek / Moonshot / OpenAI / 自建网关都行） */
async function viaHttp(env, prompt) {
  if (!env.AI_API_KEY) return '';
  const base = String(env.AI_API_BASE || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  const model = env.AI_MODEL_HTTP || env.AI_MODEL || 'deepseek-chat';
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.AI_API_KEY}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYS },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 400,
      }),
    });
    if (!r.ok) {
      console.warn('ai http failed', r.status, (await r.text()).slice(0, 200));
      return '';
    }
    const data = await r.json();
    return data?.choices?.[0]?.message?.content || '';
  } catch (e) {
    console.warn('ai http error', e.message);
    return '';
  }
}

/**
 * 生成摘要
 * @returns {Promise<{summary:string, src:'ai'|'fallback'|'', hash:string}>}
 */
export async function generateSummary(env, { title = '', content = '' }) {
  const plain = plainText(content);
  const hash = contentHash(content);

  if (plain.length < 80) return { summary: '', src: '', hash };

  const prompt = `标题：${title || '无标题'}\n\n正文：\n${plain.slice(0, MAX_INPUT)}`;

  let raw = '';
  try {
    raw = await viaWorkersAI(env, prompt);
    if (!raw) raw = await viaHttp(env, prompt);
  } catch (e) {
    console.warn('summary gen error', e.message);
  }

  const summary = tidy(raw);
  if (summary.length >= 20) return { summary, src: 'ai', hash };

  // 兜底：抽取式，取正文前两段
  const fallback = tidy(plain.slice(0, 150));
  return { summary: fallback, src: 'fallback', hash };
}

/* 后台任务：生成并写库（不阻塞响应） */
export async function refreshSummary(env, db, postId, { title, content, force = false } = {}) {
  try {
    const post = await db
      .prepare('SELECT id, title, content, summary, summary_src, summary_hash FROM posts WHERE id = ?')
      .bind(postId)
      .first();
    if (!post) return null;

    const t = title !== undefined ? title : post.title;
    const c = content !== undefined ? content : post.content;
    const hash = contentHash(c);

    // 手动写过的摘要不覆盖
    if (post.summary_src === 'manual' && post.summary) return null;
    // 正文没变就不重复生成
    if (!force && post.summary && post.summary_hash === hash) return null;

    const { summary, src } = await generateSummary(env, { title: t, content: c });
    if (!summary) return null;

    await db
      .prepare('UPDATE posts SET summary = ?, summary_src = ?, summary_hash = ? WHERE id = ?')
      .bind(summary, src, hash, postId)
      .run();
    return { summary, src };
  } catch (e) {
    console.warn('refreshSummary failed', e.message);
    return null;
  }
}
