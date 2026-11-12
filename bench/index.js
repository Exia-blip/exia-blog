// 临时压测 Worker：只用来采数，跑完 deployment 直接删。
// 所有测量都是「同一次请求内串行 N 次」，避免跨网络抖动混进样本。

const r2key = 'bench/1k.bin';
const kvkey = 'bench:1k';
const PAYLOAD = 'x'.repeat(1024);

function stats(samples) {
  const t = [...samples].sort((a, b) => a - b);
  const pick = (k) => t[Math.min(t.length - 1, Math.floor(t.length * k))];
  const round = (v) => Math.round(v * 100) / 100;
  return {
    n: t.length,
    min: round(t[0]),
    p50: round(pick(0.5)),
    p95: round(pick(0.95)),
    p99: round(pick(0.99)),
    max: round(t[t.length - 1]),
    avg: round(t.reduce((a, b) => a + b, 0) / t.length),
    samples: t.map(round),
  };
}

// Workers 里 performance.now() 被量化到整毫秒，单次调用普遍读到 0。
// 所以按 5 次一组测总时长再摊平，样本粒度回到 0.2ms。
async function timeIt(n, fn) {
  const GROUP = 5;
  const out = [];
  for (let i = 0; i < n; i += GROUP) {
    const t0 = performance.now();
    for (let j = 0; j < GROUP; j++) await fn(i + j);
    out.push((performance.now() - t0) / GROUP);
  }
  return stats(out);
}

function json(o, status = 200) {
  return new Response(JSON.stringify(o, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
  });
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, x-bench',
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    const n = Math.min(Math.max(+(url.searchParams.get('n') || 30), 1), 100);

    // 预检计数端点：浏览器每发一次 OPTIONS 就往 D1 记一行
    if (path.startsWith('/cors/')) {
      const withMaxAge = path.endsWith('/maxage');
      const h = { ...CORS_HEADERS };
      if (withMaxAge) h['access-control-max-age'] = '600';

      if (req.method === 'OPTIONS') {
        try {
          await env.DB.prepare('INSERT INTO _bench_cors (kind) VALUES (?)').bind(path).run();
        } catch {}
        return new Response(null, { status: 204, headers: h });
      }
      return new Response(JSON.stringify({ ok: true, path }), {
        headers: { ...h, 'content-type': 'application/json' },
      });
    }

    if (path === '/cors-result') {
      if (req.method === 'POST') {
        const body = (await req.text()).slice(0, 500);
        await env.DB.prepare('INSERT INTO _bench_cors (kind, ts) VALUES (?, ?)')
          .bind('RESULT:' + body, Date.now())
          .run();
        return json({ ok: true });
      }
      const row = await env.DB.prepare(
        "SELECT kind, ts FROM _bench_cors WHERE kind LIKE 'RESULT:%' ORDER BY ts DESC LIMIT 5"
      ).all();
      return json({ rows: row.results });
    }

    if (path === '/cors-count') {
      const row = await env.DB.prepare('SELECT kind, COUNT(*) n FROM _bench_cors GROUP BY kind').all();
      return json({ rows: row.results });
    }

    if (path === '/cors-reset') {
      await env.DB.prepare('DELETE FROM _bench_cors').run();
      return json({ ok: true });
    }

    if (path === '/setup') {
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS _bench_cors (kind TEXT, ts INTEGER)').run();
      await env.BUCKET.put(r2key, PAYLOAD);
      await env.BENCH.put(kvkey, PAYLOAD);
      return json({ ok: true });
    }

    if (path === '/teardown') {
      await env.DB.prepare('DROP TABLE IF EXISTS _bench_cors').run();
      await env.BUCKET.delete(r2key);
      await env.BENCH.delete(kvkey);
      return json({ ok: true });
    }

    const target = path.replace('/bench/', '');

    switch (target) {
      // 主键/索引单行查询：拼接与解析之外的开销
      case 'd1point':
        return json(await timeIt(n, () =>
          env.DB.prepare('SELECT id, title FROM posts WHERE slug = ?').bind('about').first()
        ));

      // 列表查询：10 行 + ORDER BY，模拟分类页
      case 'd1list':
        return json(await timeIt(n, () =>
          env.DB.prepare(
            `SELECT p.slug, p.title, p.created_at FROM posts p
             WHERE p.is_private = 0 AND p.hidden = 0
             ORDER BY COALESCE(NULLIF(p.published_at,''), p.created_at) DESC LIMIT 10`
          ).all()
        ));

      // 聚合：COUNT + GROUP BY，模拟标签云/归档统计
      case 'd1agg':
        return json(await timeIt(n, () =>
          env.DB.prepare('SELECT category, COUNT(*) n FROM posts GROUP BY category').all()
        ));

      // 写：单行 UPDATE，同一个 key 反复写
      case 'd1write':
        return json(await timeIt(n, (i) =>
          env.DB.prepare('UPDATE posts SET updated_at = updated_at WHERE slug = ?').bind('about').run()
        ));

      case 'r2get':
        return json(await timeIt(n, async () => {
          const o = await env.BUCKET.get(r2key);
          return o && (await o.arrayBuffer()).byteLength;
        }));

      case 'r2head':
        return json(await timeIt(n, () => env.BUCKET.head(r2key)));

      case 'r2put':
        return json(await timeIt(n, () => env.BUCKET.put(r2key, PAYLOAD)));

      case 'kvget':
        return json(await timeIt(n, () => env.BENCH.get(kvkey)));

      // KV 同一 key 每秒只能写 1 次，测写入必须每次换 key（真实场景也是新 key）
      case 'kvput':
        return json(await timeIt(n, (i) =>
          env.BENCH.put(`bench:put:${Date.now()}:${i}:${Math.random().toString(36).slice(2)}`, PAYLOAD)
        ));

      case 'd1noop':
        // 对照组：不碰任何表的 SELECT 1，仍要走一次 D1 网络往返
        return json(await timeIt(n, () => env.DB.prepare('SELECT 1 AS x').first()));

      case 'kvgetcold':
        // 随机 key：未命中也得走一次网络，用来分离「命中边缘」与「回源」
        return json(await timeIt(n, (i) =>
          env.BENCH.get('bench:miss:' + Date.now() + ':' + i + ':' + Math.random().toString(36).slice(2))
        ));

      case 'none':
        return json(await timeIt(n, async () => 1));

      default:
        return json({ error: 'unknown target', targets: ['d1point', 'd1list', 'd1agg', 'd1write', 'r2get', 'r2head', 'r2put', 'kvget', 'kvput', 'none'] }, 404);
    }
  },
};
