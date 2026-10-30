import { json, err, pageParams, slugify, uniqueSlug, nowISO } from './utils.js';
import { currentUser, requireUser, requireAdmin } from './auth.js';
import { renderMarkdown, extractTags, extractCover, extractExcerpt, readingTime } from '../public/md.js';
import { presignPut, makeKey, IMAGE_TYPES } from './s3.js';
import { notifyComment } from './webhook.js';
import { checkFriends } from './cron.js';

/* ---------- 小工具 ---------- */

async function attachTags(db, posts) {
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

function shapePost(p, full = false) {
  const base = {
    id: p.id,
    slug: p.slug,
    title: p.title,
    cover: p.cover || extractCover(p.content) || '',
    excerpt: extractExcerpt(p.content, 140),
    tags: p.tags || [],
    is_private: !!p.is_private,
    hidden: !!p.hidden,
    author: p.author_name || p.login || '',
    author_id: p.author_id,
    avatar: p.avatar || '',
    reading: readingTime(p.content),
    created_at: p.created_at,
    updated_at: p.updated_at,
    comments: p.comment_count ?? undefined,
  };
  if (full) base.content = p.content;
  return base;
}

async function syncTags(db, postId, content) {
  const names = extractTags(content);
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

/* ---------- 主路由 ---------- */

export async function handleApi(env, request, url) {
  const db = env.DB;
  const path = url.pathname.replace(/^\/api/, '') || '/';
  const method = request.method;
  const user = await currentUser(env, request);

  /* ---- 站点信息 ---- */
  if (path === '/site' && method === 'GET') {
    return json({
      ok: true,
      name: env.SITE_NAME || 'Exia Blog',
      desc: env.SITE_DESC || '',
    });
  }

  /* ---- 当前用户 ---- */
  if (path === '/me' && method === 'GET') {
    return json({ ok: true, user: user ? { ...user, is_admin: !!user.is_admin } : null });
  }

  /* ---- 文章列表（首页 / 搜索 / 标签） ---- */
  if (path === '/posts' && method === 'GET') {
    const { page, size, offset } = pageParams(url, 10);
    const tag = url.searchParams.get('tag');
    const q = (url.searchParams.get('q') || '').trim();

    const where = ['p.is_private = 0', 'p.hidden = 0'];
    const args = [];

    if (tag) {
      where.push('p.id IN (SELECT pt.post_id FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE t.name = ?)');
      args.push(tag);
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
         ORDER BY p.created_at DESC LIMIT ? OFFSET ?`
      )
      .bind(...args, size, offset)
      .all();

    await attachTags(db, results);
    return json({
      ok: true,
      page,
      size,
      total: totalRow?.c || 0,
      pages: Math.max(1, Math.ceil((totalRow?.c || 0) / size)),
      posts: results.map((p) => shapePost(p)),
    });
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
    const { results } = await db
      .prepare(
        `SELECT t.name, COUNT(pt.post_id) AS count
         FROM tags t JOIN post_tags pt ON pt.tag_id = t.id
         JOIN posts p ON p.id = pt.post_id AND p.is_private = 0 AND p.hidden = 0
         GROUP BY t.name ORDER BY count DESC, t.name ASC`
      )
      .all();
    return json({ ok: true, tags: results });
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

    // 文章内的 #标签 转为可点击
    const rendered = renderMarkdown(p.content).replace(
      /(^|>|\s)#([\p{L}\p{N}_-]{1,24})/gu,
      (m, pre, name) => `${pre}<a class="tag-inline" href="/tag/${encodeURIComponent(name)}">#${name}</a>`
    );

    return json({ ok: true, post: { ...shapePost(p, true), html: rendered } });
  }

  /* ---- 新建 ---- */
  if (path === '/posts' && method === 'POST') {
    const { user: u, res } = await requireUser(env, request);
    if (res) return res;

    const body = await request.json();
    const title = String(body.title || '无标题').slice(0, 200);
    const content = String(body.content || '');
    const wanted = slugify(body.slug || '');
    const asciiBase = /^[a-z0-9-]+$/i.test(slugify(title)) ? slugify(title) : '';
    let slug = wanted || asciiBase || uniqueSlug('post');

    const clash = await db.prepare('SELECT id FROM posts WHERE slug = ?').bind(slug).first();
    if (clash) {
      if (wanted) return err('别名已被占用，换一个');
      slug = uniqueSlug(slug);
    }

    const cover = body.cover ? String(body.cover) : extractCover(content) || '';
    const stamp = nowISO();

    const info = await db
      .prepare(
        `INSERT INTO posts (slug, title, content, cover, is_private, hidden, author_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .bind(slug, title, content, cover, body.is_private ? 1 : 0, body.hidden ? 1 : 0, u.id, stamp, stamp)
      .run();

    const id = info.meta.last_row_id;
    await syncTags(db, id, content);
    return json({ ok: true, id, slug });
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
    const content = body.content !== undefined ? String(body.content) : p.content;

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

    await db
      .prepare(
        `UPDATE posts SET slug=?, title=?, content=?, cover=?, is_private=?, hidden=?, updated_at=? WHERE id=?`
      )
      .bind(
        slug,
        title,
        content,
        cover,
        body.is_private !== undefined ? (body.is_private ? 1 : 0) : p.is_private,
        body.hidden !== undefined ? (body.hidden ? 1 : 0) : p.hidden,
        nowISO(),
        id
      )
      .run();

    await syncTags(db, id, content);
    return json({ ok: true, id, slug, updated_at: nowISO() });
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
      .prepare('SELECT id, parent_id, name, website, content, is_admin, created_at FROM comments WHERE post_id = ? ORDER BY created_at ASC')
      .bind(p.id)
      .all();

    const roots = results.filter((c) => !c.parent_id);
    const children = results.filter((c) => c.parent_id);
    const tree = roots.map((r) => ({ ...r, replies: children.filter((c) => c.parent_id === r.id) }));

    return json({ ok: true, total: results.length, comments: tree });
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
        String(body.email || '').slice(0, 120),
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
    const { results } = await db
      .prepare('SELECT id, name, url, avatar, desc, status, checked_at FROM friends ORDER BY status DESC, id ASC')
      .all();
    return json({ ok: true, friends: results });
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
