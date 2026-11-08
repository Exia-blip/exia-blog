import { json, err, pageParams, slugify, uniqueSlug, nowISO } from './utils.js';
import { currentUser, requireUser, requireAdmin } from './auth.js';
import { renderBody, extractTags, extractCover, extractExcerpt, readingTime } from '../public/md.js';
import { sanitizeHtml, cleanMarkdown } from './clean.js';
import { coverOf } from './cover.js';
import { bustPaths } from './cache.js';
import { presignPut, makeKey, IMAGE_TYPES } from './s3.js';
import { notifyComment } from './webhook.js';
import { checkFriends } from './cron.js';
import { getSite, setSite, THEME_IDS, MODE_IDS } from './settings.js';
import { refreshSummary, generateSummary, contentHash, hasAI } from './ai.js';
import {
  CATS,
  TAG_SEED,
  TAG_ALIAS,
  normalizeCat,
  catName,
  normalizeTag,
  normalizeTags,
  isSeedTag,
} from './taxonomy.js';

/* ---------- 小工具 ---------- */

/** 同系列的其它文章：正文里嵌着系列目录，一篇变了全组的 HTML 都变 */
async function seriesSiblingSlugs(db, series) {
  if (!series) return [];
  const { results } = await db.prepare('SELECT slug FROM posts WHERE series = ?').bind(series).all();
  return results.map((r) => r.slug);
}

/* 发布 / 修改 / 删除后主动删掉边缘缓存：不用等 TTL 过期 */
function bust(url, slugs = [], cats = []) {
  const paths = ['/', '/archive', '/categories'];
  for (const c of cats.filter(Boolean)) paths.push(`/cat/${encodeURIComponent(c)}`);
  for (const s of slugs.filter(Boolean)) {
    paths.push(`/p/${encodeURIComponent(s)}`, `/${encodeURIComponent(s)}`);
  }
  return bustPaths(url.origin, paths);
}

export async function attachTags(db, posts) {
  if (!posts.length) return posts;
  const ids = posts.map((p) => p.id);
  const ph = ids.map(() => '?').join(',');
  const { results } = await db
    .prepare(`SELECT pt.post_id, t.name FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id IN (${ph})`)
    .bind(...ids)
    .all();

  const map = new Map();
  for (const r of results) {
    if (!map.has(r.post_id)) map.set(r.post_id, []);
    map.get(r.post_id).push(r.name);
  }
  for (const p of posts) p.tags = map.get(p.id) || [];
  return posts;
}

/**
 * 发布时间：第一次进入「非私密」状态时定下，之后来回改成草稿/发布都不再改写。
 * 不这么定的话，草稿写于 10 月、发布在 12 月，页面日期、RSS pubDate、
 * article:published_time 会一起错成 10 月。空串表示还没发布过。
 */
function publishedOf(prev, isPrivate, now) {
  if (prev) return prev;
  return isPrivate ? '' : now;
}

/** 系列名：40 字以内，去掉首尾空白；空串表示单篇 */
const seriesOf = (b) => String(b.series ?? '').trim().slice(0, 40);
const seriesOrderOf = (b) => {
  const n = parseInt(b.series_order, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 999) : 0;
};

function shapePost(p, full = false) {
  const base = {
    id: p.id,
    slug: p.slug,
    title: p.title,
    // 手填封面 → 正文首图 → 预设自动图，永远有值，前端不用再判空
    cover: coverOf(p),
    // 有 AI 摘要就用摘要当导语，没有才截正文
    excerpt: p.summary || extractExcerpt(p.content, 140),
    summary: p.summary || '',
    summary_src: p.summary_src || '',
    tags: p.tags || [],
    category: p.category || '',
    category_name: p.category ? catName(p.category) : '',
    is_private: !!p.is_private,
    hidden: !!p.hidden,
    author: p.author_name || p.login || '',
    author_id: p.author_id,
    avatar: p.avatar || '',
    reading: readingTime(p.content),
    series: p.series || '',
    series_order: p.series_order || 0,
    // 发布时间：草稿转发布那一刻定下。老数据没有这个字段时退回 created_at，
    // 保证 API 里永远是字符串而不是 null，前端不用再写一遍兜底
    published_at: p.published_at || p.created_at || '',
    // 落库原值（未发布就是空串）。编辑器靠它区分「真发布过」和「拿 created_at 兜底」，
    // 否则私密草稿会显示成已发布时间，误导人以为字段已经写进去了
    published_at_raw: p.published_at || '',
    created_at: p.created_at,
    updated_at: p.updated_at,
    comments: p.comment_count ?? undefined,
  };
  if (full) base.content = p.content;
  return base;
}

async function syncTags(db, postId, content) {
  // 正文里手写的 #标签 先过一遍别名表，避免 cf / cfworkers / cloudflare 各存一份
  const names = normalizeTags(extractTags(content));
  await db.prepare('DELETE FROM post_tags WHERE post_id = ?').bind(postId).run();
  for (const name of names) {
    await db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').bind(name).run();
    const t = await db.prepare('SELECT id FROM tags WHERE name = ?').bind(name).first();
    if (t) await db.prepare('INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?,?)').bind(postId, t.id).run();
  }
  return names;
}

const AUTHOR_JOIN = 'LEFT JOIN users u ON u.id = p.author_id';
const AUTHOR_COLS = 'u.name AS author_name, u.login, u.avatar';

/* ---------- 归档数据（接口与 /archive SSR 共用一份，避免两处 SQL 走偏） ---------- */
export async function archiveData(db, year = '') {
  const y = /^\d{4}$/.test(String(year)) ? String(year) : '';
  const where = ['p.is_private = 0', 'p.hidden = 0'];
  const args = [];
  if (y) {
    where.push("substr(COALESCE(NULLIF(p.published_at, ''), p.created_at), 1, 4) = ?");
    args.push(y);
  }

  const { results } = await db
    .prepare(
      `SELECT p.*, ${AUTHOR_COLS}, (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
       FROM posts p ${AUTHOR_JOIN}
       WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(NULLIF(p.published_at, ''), p.created_at) DESC, p.id DESC
       LIMIT 2000`
    )
    .bind(...args)
    .all();

  await attachTags(db, results);

  const yearMap = new Map();
  for (const p of results) {
    const stamp = String(p.published_at || p.created_at || '');
    const yy = stamp.slice(0, 4) || '未知';
    const mm = stamp.slice(5, 7) || '00';
    if (!yearMap.has(yy)) yearMap.set(yy, { year: yy, count: 0, months: new Map() });
    const yb = yearMap.get(yy);
    yb.count += 1;
    if (!yb.months.has(mm)) yb.months.set(mm, { month: mm, label: `${Number(mm) || '?'} 月`, count: 0, posts: [] });
    const mb = yb.months.get(mm);
    mb.count += 1;
    mb.posts.push(shapePost(p));
  }

  const years = [...yearMap.values()].map((v) => ({
    year: v.year,
    count: v.count,
    months: [...v.months.values()],
  }));

  // 全站跨度（不受 year 过滤影响）
  const spanRow = await db
    .prepare(
      `SELECT MIN(COALESCE(NULLIF(published_at, ''), created_at)) AS first_at,
              MAX(COALESCE(NULLIF(published_at, ''), created_at)) AS last_at,
              COUNT(*) AS total
       FROM posts WHERE is_private = 0 AND hidden = 0`
    )
    .first();

  return {
    total: spanRow?.total || 0,
    filtered: results.length,
    year: y,
    first_at: spanRow?.first_at || '',
    last_at: spanRow?.last_at || '',
    years,
  };
}

/* ---------- 标签云（接口与 /categories 的 SSR 共用） ---------- */
export async function tagsData(db) {
  const { results } = await db
    .prepare(
      `SELECT t.name, COUNT(pt.post_id) AS count
       FROM tags t JOIN post_tags pt ON pt.tag_id = t.id
       JOIN posts p ON p.id = pt.post_id AND p.is_private = 0 AND p.hidden = 0
       GROUP BY t.name ORDER BY count DESC, t.name ASC`
    )
    .all();
  return results;
}

/* ---------- 友链（接口与 /friends 的 SSR 共用） ---------- */
export async function friendsData(db) {
  const { results } = await db
    .prepare('SELECT id, name, url, avatar, desc, status, checked_at FROM friends ORDER BY status DESC, id ASC')
    .all();
  return results;
}

/* ---------- 文章列表查询（接口与首页 SSR 共用，避免两份 SQL 走偏） ---------- */
export async function listPosts(db, { page = 1, size = 10, tag = '', cat = '', q = '' } = {}) {
  const offset = (page - 1) * size;
  const where = ['p.is_private = 0', 'p.hidden = 0'];
  const args = [];

  if (tag) {
    where.push('p.id IN (SELECT pt.post_id FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE t.name = ?)');
    args.push(tag);
  }
  if (cat) {
    where.push('p.category = ?');
    args.push(cat);
  }
  if (q) {
    where.push('(p.title LIKE ? OR p.content LIKE ?)');
    args.push(`%${q}%`, `%${q}%`);
  }

  const whereSql = where.join(' AND ');
  const totalRow = await db.prepare(`SELECT COUNT(*) AS c FROM posts p WHERE ${whereSql}`).bind(...args).first();

  const { results } = await db
    .prepare(
      `SELECT p.*, ${AUTHOR_COLS}, (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
       FROM posts p ${AUTHOR_JOIN} WHERE ${whereSql}
       ORDER BY COALESCE(NULLIF(p.published_at, ''), p.created_at) DESC, p.id DESC LIMIT ? OFFSET ?`
    )
    .bind(...args, size, offset)
    .all();

  await attachTags(db, results);
  const total = totalRow?.c || 0;
  return {
    page,
    size,
    total,
    pages: Math.max(1, Math.ceil(total / size)),
    posts: results.map((p) => shapePost(p)),
  };
}

/* ---------- 主路由 ---------- */

export async function handleApi(env, request, url, ctx) {
  const db = env.DB;
  const path = url.pathname.replace(/^\/api/, '') || '/';
  const method = request.method;
  const user = await currentUser(env, request);

  /* ---- 站点信息 ---- */
  if (path === '/site' && method === 'GET') {
    const s = await getSite(env);
    return json({ ok: true, name: s.name, desc: s.desc, theme: s.theme, mode: s.mode, avatar: s.avatar });
  }

  /* ---- 站点设置（管理员读写） ---- */
  if (path === '/settings' && method === 'GET') {
    const { res } = await requireAdmin(env, request);
    if (res) return res;
    const s = await getSite(env);
    return json({ ok: true, name: s.name, desc: s.desc, theme: s.theme, mode: s.mode, avatar: s.avatar });
  }

  if (path === '/settings' && method === 'PUT') {
    const { res } = await requireAdmin(env, request);
    if (res) return res;

    const body = await request.json();
    const name = String(body.name ?? '').trim();
    if (!name) return err('站点名称不能为空');
    if (name.length > 60) return err('站点名称太长（限 60 字）');
    const desc = String(body.desc ?? '').trim();
    if (desc.length > 200) return err('站点介绍太长（限 200 字）');
    if (body.theme !== undefined && !THEME_IDS.includes(String(body.theme))) return err('未知的风格');
    if (body.mode !== undefined && !MODE_IDS.includes(String(body.mode))) return err('未知的外观模式');

    let avatar;
    if (body.avatar !== undefined) {
      avatar = String(body.avatar ?? '').trim();
      if (avatar.length > 500) return err('头像地址太长（限 500 字符）');
      const ok = avatar === '' || avatar.startsWith('/') || /^https?:\/\//i.test(avatar);
      if (!ok) return err('头像地址只能是 http(s) 链接或站内路径');
      if (avatar.startsWith('//')) return err('头像地址不要以 // 开头');
    }

    const s = await setSite(env, {
      name,
      desc,
      theme: body.theme === undefined ? undefined : String(body.theme),
      mode: body.mode === undefined ? undefined : String(body.mode),
      avatar,
    });
    return json({ ok: true, name: s.name, desc: s.desc, theme: s.theme, mode: s.mode, avatar: s.avatar });
  }

  /* ---- 站点头像上传（管理员，直接落 R2 并写入设置） ---- */
  if (path === '/settings/avatar' && method === 'POST') {
    const { res } = await requireAdmin(env, request);
    if (res) return res;

    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') return err('没有文件');

    const type = file.type || '';
    if (!IMAGE_TYPES[type]) return err('只支持 jpg / png / gif / webp / svg / avif');
    if (file.size > 4 * 1024 * 1024) return err('图片别超过 4MB');

    const key = makeKey(`avatar.${IMAGE_TYPES[type]}`);
    await env.BUCKET.put(key, await file.arrayBuffer(), {
      httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' },
    });

    const base = env.R2_PUBLIC_BASE ? env.R2_PUBLIC_BASE.replace(/\/$/, '') : '';
    const publicUrl = base ? `${base}/${key}` : `/img/${key}`;
    const s = await setSite(env, { avatar: publicUrl });
    return json({ ok: true, avatar: s.avatar, key });
  }

  /* ---- 当前用户 ---- */
  if (path === '/me' && method === 'GET') {
    return json({ ok: true, user: user ? { ...user, is_admin: !!user.is_admin } : null });
  }

  /* ---- 文章列表（首页 / 搜索 / 标签） ---- */
  if (path === '/posts' && method === 'GET') {
    const { page, size } = pageParams(url, 10);
    const data = await listPosts(db, {
      page,
      size,
      tag: url.searchParams.get('tag') || '',
      cat: (url.searchParams.get('cat') || '').trim(),
      q: (url.searchParams.get('q') || '').trim(),
    });
    return json({ ok: true, ...data });
  }

  /* ---- 我的文章（含私密与隐藏） ---- */
  if (path === '/mine' && method === 'GET') {
    const { user: u, res } = await requireUser(env, request);
    if (res) return res;
    const { results } = await db
      .prepare(
        `SELECT p.*, ${AUTHOR_COLS} FROM posts p ${AUTHOR_JOIN}
         WHERE p.author_id = ? ORDER BY p.updated_at DESC LIMIT 200`
      )
      .bind(u.id)
      .all();
    await attachTags(db, results);
    return json({
      ok: true,
      posts: results.map((p) => ({ ...shapePost(p, true), is_private: !!p.is_private, hidden: !!p.hidden })),
    });
  }

  /* ---- 标签云 ---- */
  if (path === '/tags' && method === 'GET') {
    return json({ ok: true, tags: await tagsData(db) });
  }

  /* ---- 归档（按年月分组的全部公开文章） ---- */
  if (path === '/archive' && method === 'GET') {
    const year = (url.searchParams.get('year') || '').trim();
    return json({ ok: true, ...(await archiveData(db, year)) });
  }

  /* ---- 栏目（固定四栏，含空栏目；栏目语义见 src/taxonomy.js） ---- */
  if (path === '/categories' && method === 'GET') {
    const { results } = await db
      .prepare(
        `SELECT category, COUNT(*) AS count FROM posts
         WHERE is_private = 0 AND hidden = 0 GROUP BY category`
      )
      .all();

    const counts = new Map();
    let uncategorized = 0;
    for (const r of results) {
      const slug = normalizeCat(r.category);
      if (!slug) {
        uncategorized += Number(r.count) || 0;
        continue;
      }
      counts.set(slug, (counts.get(slug) || 0) + (Number(r.count) || 0));
    }

    return json({
      ok: true,
      categories: CATS.map((c) => ({
        slug: c.slug,
        name: c.name,
        desc: c.desc,
        hint: c.hint,
        count: counts.get(c.slug) || 0,
      })),
      uncategorized,
    });
  }

  /* ---- 栏目 / 标签规范（编辑器用：四选一 + 白名单 + 别名表） ---- */
  if (path === '/taxonomy' && method === 'GET') {
    const { results } = await db
      .prepare(
        `SELECT t.name, COUNT(pt.post_id) AS count FROM tags t
         LEFT JOIN post_tags pt ON pt.tag_id = t.id
         LEFT JOIN posts p ON p.id = pt.post_id AND p.is_private = 0 AND p.hidden = 0
         GROUP BY t.name ORDER BY count DESC, t.name ASC`
      )
      .all();
    return json({
      ok: true,
      categories: CATS,
      seed: TAG_SEED,
      aliases: TAG_ALIAS,
      tags: results,
      offlist: results.filter((r) => !isSeedTag(r.name)).map((r) => r.name),
    });
  }

    /* ---- 系列列表（编辑器下拉 + 文章页系列目录都靠它） ---- */
  if (path === '/series' && method === 'GET') {
    const { results } = await db
      .prepare(
        `SELECT series AS name, COUNT(*) AS count, MAX(updated_at) AS updated_at
         FROM posts
         WHERE is_private = 0 AND hidden = 0 AND TRIM(series) != ''
         GROUP BY series ORDER BY updated_at DESC`
      )
      .all();
    return json({ ok: true, series: results });
  }

/* ---- 单篇文章 ---- */
  if (path.startsWith('/posts/') && method === 'GET') {
    const slug = decodeURIComponent(path.slice('/posts/'.length));
    const p = await db
      .prepare(`SELECT p.*, ${AUTHOR_COLS} FROM posts p ${AUTHOR_JOIN} WHERE p.slug = ?`)
      .bind(slug)
      .first();

    if (!p) return err('文章不存在', 404);
    if (p.is_private && (!user || (user.id !== p.author_id && !user.is_admin))) {
      return err('文章不存在', 404);
    }

    await attachTags(db, [p]);

    // 文章内的 #标签 转为可点击，再走一遍白名单消毒
    const rendered = sanitizeHtml(renderBody(p.content));

    return json({ ok: true, post: { ...shapePost(p, true), html: rendered } });
  }

  /* ---- 新建 ---- */
  if (path === '/posts' && method === 'POST') {
    const { user: u, res } = await requireUser(env, request);
    if (res) return res;

    const body = await request.json();
    const title = String(body.title || '无标题').slice(0, 200);
    const content = cleanMarkdown(String(body.content || ''), title);
    const wanted = slugify(body.slug || '');
    const asciiBase = /^[a-z0-9-]+$/i.test(slugify(title)) ? slugify(title) : '';
    let slug = wanted || asciiBase || uniqueSlug('post');

    const clash = await db.prepare('SELECT id FROM posts WHERE slug = ?').bind(slug).first();
    if (clash) {
      if (wanted) return err('别名已被占用，换一个');
      slug = uniqueSlug(slug);
    }

    const cover = body.cover ? String(body.cover) : extractCover(content) || '';
    const rawCat = String(body.category || '').trim();
    const category = normalizeCat(rawCat);
    if (rawCat && !category) return err('未知栏目：只能是 log / teardown / tools / site');
    const stamp = nowISO();
    const published = publishedOf('', !!body.is_private, stamp);

    const info = await db
      .prepare(
        `INSERT INTO posts (slug, title, content, cover, category, series, series_order, is_private, hidden, published_at, author_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        slug, title, content, cover, category,
        seriesOf(body), seriesOrderOf(body),
        body.is_private ? 1 : 0, body.hidden ? 1 : 0,
        published,
        u.id, stamp, stamp
      )
      .run();

    const id = info.meta.last_row_id;

    // 手动写了摘要就存手动版，否则发布即后台生成
    const manual = body.summary !== undefined ? String(body.summary).trim().slice(0, 400) : '';
    if (manual) {
      await db.prepare("UPDATE posts SET summary = ?, summary_src = 'manual' WHERE id = ?").bind(manual, id).run();
    } else if (ctx) {
      ctx.waitUntil(refreshSummary(env, db, id, { title, content }));
    }

    await syncTags(db, id, content);
    if (ctx) ctx.waitUntil(bust(url, [slug, ...(await seriesSiblingSlugs(db, seriesOf(body)))], [category]));
    return json({ ok: true, id, slug, summary: manual, ai: hasAI(env), published_at: published });
  }

  /* ---- 更新 ---- */
  if (/^\/posts\/\d+$/.test(path) && method === 'PUT') {
    const { user: u, res } = await requireUser(env, request);
    if (res) return res;
    const id = parseInt(path.split('/')[2], 10);

    const p = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();
    if (!p) return err('文章不存在', 404);
    if (p.author_id !== u.id && !u.is_admin) return err('无权编辑', 403);

    const body = await request.json();
    const title = body.title !== undefined ? String(body.title).slice(0, 200) : p.title;
    const content = body.content !== undefined ? cleanMarkdown(String(body.content), title) : p.content;

    let slug = p.slug;
    if (body.slug !== undefined) {
      const wanted = slugify(body.slug);
      if (wanted && wanted !== p.slug) {
        const clash = await db.prepare('SELECT id FROM posts WHERE slug = ? AND id != ?').bind(wanted, id).first();
        if (clash) return err('别名已被占用，换一个');
        slug = wanted;
      }
    }

    const cover = body.cover !== undefined ? String(body.cover || '') : p.cover || extractCover(content) || '';
    let category = p.category || '';
    if (body.category !== undefined) {
      const rawCat = String(body.category || '').trim();
      category = normalizeCat(rawCat);
      if (rawCat && !category) return err('未知栏目：只能是 log / teardown / tools / site');
    }

    // 摘要：显式传入就按手动存；传空串表示"清空，下次重新生成"
    let sumSql = '';
    const sumArgs = [];
    let needGen = false;
    if (body.summary !== undefined) {
      const manual = String(body.summary).trim().slice(0, 400);
      sumSql = ', summary = ?, summary_src = ?';
      sumArgs.push(manual, manual ? 'manual' : '');
      needGen = !manual;
    } else if (contentHash(content) !== (p.summary_hash || '')) {
      needGen = true;      // 正文变了，摘要跟着旧了
    }

    const isPrivate = body.is_private !== undefined ? (body.is_private ? 1 : 0) : p.is_private;
    const isHidden = body.hidden !== undefined ? (body.hidden ? 1 : 0) : p.hidden;
    const stampNow = nowISO();
    const published = publishedOf(p.published_at, isPrivate, stampNow);

    await db
      .prepare(
        `UPDATE posts SET slug=?, title=?, content=?, cover=?, category=?, series=?, series_order=?, is_private=?, hidden=?, published_at=?, updated_at=?${sumSql} WHERE id=?`
      )
      .bind(
        slug,
        title,
        content,
        cover,
        category,
        body.series !== undefined ? seriesOf(body) : p.series || '',
        body.series_order !== undefined ? seriesOrderOf(body) : p.series_order || 0,
        isPrivate,
        isHidden,
        published,
        stampNow,
        ...sumArgs,
        id
      )
      .run();

    if (needGen && ctx) ctx.waitUntil(refreshSummary(env, db, id, { title, content }));

    await syncTags(db, id, content);
    if (ctx) {
      const touched = [
        ...new Set([
          ...(await seriesSiblingSlugs(db, seriesOf({ series: body.series !== undefined ? body.series : p.series }))),
          ...(await seriesSiblingSlugs(db, p.series)),
        ]),
      ];
      ctx.waitUntil(bust(url, [slug, p.slug, ...touched], [category, p.category]));
    }
    return json({ ok: true, id, slug, updated_at: nowISO(), published_at: published, ai: hasAI(env) });
  }

  /* ---- 生成 / 重新生成 AI 摘要 ---- */
  if (/^\/posts\/\d+\/summary$/.test(path) && method === 'POST') {
    const { user: u, res } = await requireUser(env, request);
    if (res) return res;
    const id = parseInt(path.split('/')[2], 10);

    const p = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();
    if (!p) return err('文章不存在', 404);
    if (p.author_id !== u.id && !u.is_admin) return err('无权编辑', 403);

    let body = {};
    try {
      body = await request.json();
    } catch {}

    const title = body.title !== undefined ? String(body.title).slice(0, 200) : p.title;
    const content = body.content !== undefined ? String(body.content) : p.content;
    if (!String(content).trim()) return err('正文是空的，没东西可总结');

    const hash = contentHash(content);
    const force = !!body.force;

    // 已经算过同一版正文，直接返回，不重复烧 token
    if (!force && p.summary && p.summary_hash === hash && p.summary_src !== 'manual') {
      return json({ ok: true, summary: p.summary, src: p.summary_src, cached: true });
    }

    const out = await generateSummary(env, { title, content });
    if (!out.summary) return err('摘要生成失败，检查 AI 绑定或密钥');

    await db
      .prepare('UPDATE posts SET summary = ?, summary_src = ?, summary_hash = ? WHERE id = ?')
      .bind(out.summary, out.src, hash, id)
      .run();

    return json({ ok: true, summary: out.summary, src: out.src });
  }

  /* ---- 删除 ---- */
  if (/^\/posts\/\d+$/.test(path) && method === 'DELETE') {
    const { user: u, res } = await requireUser(env, request);
    if (res) return res;
    const id = parseInt(path.split('/')[2], 10);

    const p = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();
    if (!p) return err('文章不存在', 404);
    if (p.author_id !== u.id && !u.is_admin) return err('无权删除', 403);

    await db.batch([
      db.prepare('DELETE FROM post_tags WHERE post_id = ?').bind(id),
      db.prepare('DELETE FROM comments WHERE post_id = ?').bind(id),
      db.prepare('DELETE FROM posts WHERE id = ?').bind(id),
    ]);
    if (ctx) ctx.waitUntil(bust(url, [p.slug, ...(await seriesSiblingSlugs(db, p.series))], [p.category]));
    return json({ ok: true });
  }

  /* ---- 评论列表 ---- */
  if (path === '/comments' && method === 'GET') {
    const slug = url.searchParams.get('slug');
    if (!slug) return err('缺少 slug');
    const p = await db.prepare('SELECT id, is_private, author_id FROM posts WHERE slug = ?').bind(slug).first();
    if (!p) return err('文章不存在', 404);
    if (p.is_private && (!user || (user.id !== p.author_id && !user.is_admin))) return err('文章不存在', 404);

    const { results } = await db
      .prepare(
        'SELECT id, parent_id, name, email, website, content, is_admin, created_at FROM comments WHERE post_id = ? ORDER BY created_at ASC'
      )
      .bind(p.id)
      .all();

    // 邮箱只给管理员看，游客/普通用户拿不到
    const rows = user && user.is_admin ? results : results.map(({ email, ...rest }) => rest);

    const roots = rows.filter((c) => !c.parent_id);
    const children = rows.filter((c) => c.parent_id);
    const tree = roots.map((r) => ({ ...r, replies: children.filter((c) => c.parent_id === r.id) }));

    return json({ ok: true, total: rows.length, comments: tree });
  }

  /* ---- 发评论 ---- */
  if (path === '/comments' && method === 'POST') {
    const body = await request.json();
    const slug = String(body.slug || '');
    const content = String(body.content || '').trim();

    if (!content) return err('评论不能为空');
    if (content.length > 2000) return err('评论太长');

    const p = await db
      .prepare(`SELECT p.id, p.title, p.slug, p.is_private, p.author_id FROM posts p WHERE p.slug = ?`)
      .bind(slug)
      .first();
    if (!p) return err('文章不存在', 404);
    if (p.is_private && (!user || (user.id !== p.author_id && !user.is_admin))) return err('文章不存在', 404);

    const name = user ? user.name || user.login : String(body.name || '').trim();
    if (!name) return err('请填写昵称');

    // 联系邮箱必填；登录用户没填就用账号邮箱兜底
    const email = String(body.email || '').trim() || (user && user.email) || '';
    if (!email) return err('请填写联系邮箱');
    if (email.length > 120) return err('邮箱太长');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err('邮箱格式不正确');

    let parentId = null;
    if (body.parent_id) {
      const parent = await db
        .prepare('SELECT id, parent_id FROM comments WHERE id = ? AND post_id = ?')
        .bind(parseInt(body.parent_id, 10), p.id)
        .first();
      if (!parent) return err('父评论不存在');
      // 强制两级：回复子评论时归到顶级
      parentId = parent.parent_id || parent.id;
    }

    const isAdmin = user && user.is_admin ? 1 : 0;
    const info = await db
      .prepare(
        `INSERT INTO comments (post_id, parent_id, name, email, website, content, is_admin, ip, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        p.id,
        parentId,
        name.slice(0, 40),
        email.slice(0, 120),
        String(body.website || '').slice(0, 200),
        content,
        isAdmin,
        request.headers.get('cf-connecting-ip') || '',
        nowISO()
      )
      .run();

    const origin = url.origin;
    await notifyComment(env, {
      postTitle: p.title,
      postUrl: `${origin}/p/${p.slug}`,
      name,
      content,
    });

    return json({ ok: true, id: info.meta.last_row_id });
  }

  /* ---- 删评论 ---- */
  if (/^\/comments\/\d+$/.test(path) && method === 'DELETE') {
    const { user: u, res } = await requireAdmin(env, request);
    if (res) return res;
    const id = parseInt(path.split('/')[2], 10);
    await db.batch([
      db.prepare('DELETE FROM comments WHERE parent_id = ?').bind(id),
      db.prepare('DELETE FROM comments WHERE id = ?').bind(id),
    ]);
    return json({ ok: true });
  }

  /* ---- 友链 ---- */
  if (path === '/friends' && method === 'GET') {
    return json({ ok: true, friends: await friendsData(db) });
  }

  if (path === '/friends' && method === 'POST') {
    const { user: u, res } = await requireAdmin(env, request);
    if (res) return res;
    const body = await request.json();
    const name = String(body.name || '').trim();
    const furl = String(body.url || '').trim();
    if (!name || !furl) return err('名称和链接必填');

    const info = await db
      .prepare('INSERT INTO friends (name, url, avatar, desc, status, checked_at) VALUES (?,?,?,?,0,?)')
      .bind(name.slice(0, 60), furl.slice(0, 300), String(body.avatar || ''), String(body.desc || ''), nowISO())
      .run();

    checkFriends(env).catch(() => {});
    return json({ ok: true, id: info.meta.last_row_id });
  }

  if (/^\/friends\/\d+$/.test(path) && method === 'DELETE') {
    const { res } = await requireAdmin(env, request);
    if (res) return res;
    const id = parseInt(path.split('/')[2], 10);
    await db.prepare('DELETE FROM friends WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }

  if (path === '/friends/check' && method === 'POST') {
    const { res } = await requireAdmin(env, request);
    if (res) return res;
    const r = await checkFriends(env);
    return json({ ok: true, ...r });
  }

  /* ---- 存量内容清理：零宽字符、行尾空格、重复空行、与标题重复的一级标题 ---- */
  if (path === '/maintenance/clean' && method === 'POST') {
    const { res } = await requireAdmin(env, request);
    if (res) return res;

    const { results } = await db.prepare('SELECT id, slug, title, content FROM posts ORDER BY id ASC').all();
    const changed = [];
    for (const p of results) {
      const cleaned = cleanMarkdown(p.content || '', p.title);
      if (cleaned !== p.content) {
        await db.prepare('UPDATE posts SET content = ? WHERE id = ?').bind(cleaned, p.id).run();
        changed.push({ slug: p.slug, before: String(p.content || '').length, after: cleaned.length });
      }
    }
    if (changed.length && ctx) ctx.waitUntil(bust(url, results.map((p) => p.slug)));
    return json({ ok: true, scanned: results.length, changed: changed.length, detail: changed.slice(0, 50) });
  }

  /* ---- 栏目 / 标签归一：老数据里的中文栏目、别名标签、空标签一次收拾干净 ---- */
  if (path === '/maintenance/taxonomy' && method === 'POST') {
    const { res } = await requireAdmin(env, request);
    if (res) return res;

    // 1) 栏目收敛到四个 slug
    const { results: posts } = await db
      .prepare("SELECT id, slug, category FROM posts WHERE TRIM(COALESCE(category,'')) != ''")
      .all();
    const catChanges = [];
    for (const p of posts) {
      const slug = normalizeCat(p.category);
      if (slug !== p.category) {
        await db.prepare('UPDATE posts SET category = ? WHERE id = ?').bind(slug, p.id).run();
        catChanges.push({ post: p.slug, from: p.category, to: slug });
      }
    }

    // 2) 标签按别名表合并（cf → cloudflare 之类）
    const { results: tags } = await db.prepare('SELECT id, name FROM tags ORDER BY id ASC').all();
    const idByName = new Map(tags.map((t) => [t.name, t.id]));
    const merged = [];
    for (const t of tags) {
      const to = normalizeTag(t.name);
      if (!to || to === t.name) continue;

      let targetId = idByName.get(to);
      if (!targetId) {
        await db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').bind(to).run();
        targetId = (await db.prepare('SELECT id FROM tags WHERE name = ?').bind(to).first())?.id;
        if (targetId) idByName.set(to, targetId);
      }
      if (!targetId) continue;

      await db.batch([
        db
          .prepare('INSERT OR IGNORE INTO post_tags (post_id, tag_id) SELECT post_id, ? FROM post_tags WHERE tag_id = ?')
          .bind(targetId, t.id),
        db.prepare('DELETE FROM post_tags WHERE tag_id = ?').bind(t.id),
        db.prepare('DELETE FROM tags WHERE id = ?').bind(t.id),
      ]);
      idByName.delete(t.name);
      merged.push({ from: t.name, to });
    }

    // 3) 没有文章的标签直接删：空标签页对爬虫是薄内容
    const emptied = await db
      .prepare('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM post_tags)')
      .run();

    const { results: left } = await db.prepare('SELECT name FROM tags ORDER BY name').all();
    if (ctx) ctx.waitUntil(bust(url, posts.map((p) => p.slug), posts.map((p) => p.category)));
    return json({
      ok: true,
      categories: catChanges,
      merged,
      removed_empty: emptied.meta.changes || 0,
      offlist: left.map((r) => r.name).filter((n) => !isSeedTag(n)),
    });
  }


  /* ---- 图片上传 ---- */
  if (path === '/upload-url' && method === 'POST') {
    const { res } = await requireUser(env, request);
    if (res) return res;

    const body = await request.json();
    const type = String(body.type || 'image/png');
    if (!IMAGE_TYPES[type]) return err('只支持 jpg/png/gif/webp/svg/avif');

    const key = makeKey(body.name);
    const base = env.R2_PUBLIC_BASE ? env.R2_PUBLIC_BASE.replace(/\/$/, '') : '';
    const publicUrl = base ? `${base}/${key}` : `/img/${key}`;

    try {
      const uploadUrl = await presignPut(env, key);
      return json({ ok: true, mode: 'direct', key, uploadUrl, publicUrl });
    } catch {
      // 没配 S3 凭据 -> 走 Worker 中转
      return json({ ok: true, mode: 'proxy', key, publicUrl });
    }
  }

  if (path === '/upload' && method === 'POST') {
    const { res } = await requireUser(env, request);
    if (res) return res;

    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') return err('没有文件');

    const type = file.type || 'image/png';
    if (!IMAGE_TYPES[type]) return err('只支持图片');

    const key = makeKey(file.name);
    await env.BUCKET.put(key, await file.arrayBuffer(), {
      httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' },
    });

    const base = env.R2_PUBLIC_BASE ? env.R2_PUBLIC_BASE.replace(/\/$/, '') : '';
    return json({ ok: true, key, publicUrl: base ? `${base}/${key}` : `/img/${key}` });
  }

  return err('未知接口', 404);
}
