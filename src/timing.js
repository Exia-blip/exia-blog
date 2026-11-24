/* 分段计时：给每个 HTML / JSON 响应打一条 Server-Timing。

   为什么现在才加：以前排查「549ms 到 96ms」全靠 `wrangler tail` 里的 dms，
   那只有一个总数，分不出是 D1 慢还是模板慢。每次都要重新 tail、重新复现。
   Server-Timing 是标准头，浏览器 DevTools 的 Timing 面板直接显示，
   curl -D - 也能读，等于把 tail 里那条日志常开在响应上。

   三个指标：
     db    本请求所有 D1 调用的累计墙钟（含等待）
     app   总耗时减 db，即 Worker 自己的活（模板、JSON、压缩前组装）
     total 从进入 fetch 到响应对象造好

   这不是精确的 CPU 时间。Workers 的 CPU 计量在 `request.cf` 里拿不到，
   运行时也没给 API（observe.js 里 cpuMs 一直显式 null 就是这个原因）。
   三者都是墙钟，含 IO 等待，注释里写清楚，免得以后有人当成 CPU。

   只在 HTML 与 JSON 上打。图片、CSS、JS 打这个没有意义，还多几个字节。 */

/* D1 代理：一处包装，全部调用点自动计时。
   本站 D1 调用点散在 6 个文件、一百多处（api.js 78 个 prepare），
   逐点插桩既改不完也没人维护得住。包 env.DB 是唯一的单点。

   注意 batch()：它收的是一组 statement，元素如果是代理对象，D1 内部
   的类型检查会失败。所以代理上挂 __raw 指回原对象，batch 时解包。 */
export function timedDb(db, bag) {
  if (!db || db.__timed) return db;

  const wrapStmt = (stmt) =>
    new Proxy(stmt, {
      get(t, k) {
        if (k === '__raw') return t;
        const v = t[k];
        if (typeof v !== 'function') return v;
        /* bind 返回新 statement，要重新包一层，否则 .bind(...).all() 就不计了 */
        if (k === 'bind') return (...args) => wrapStmt(v.apply(t, args));
        if (k === 'all' || k === 'first' || k === 'run' || k === 'raw') {
          return async (...args) => {
            const t0 = performance.now();
            try {
              return await v.apply(t, args);
            } finally {
              bag.db += performance.now() - t0;
              bag.queries += 1;
            }
          };
        }
        return v.bind(t);
      },
    });

  return new Proxy(db, {
    get(t, k) {
      if (k === '__timed') return true;
      const v = t[k];
      if (typeof v !== 'function') return v;
      if (k === 'prepare') return (sql) => wrapStmt(v.call(t, sql));
      if (k === 'batch') {
        return async (stmts) => {
          const t0 = performance.now();
          const list = (stmts || []).map((s) => (s && s.__raw ? s.__raw : s));
          try {
            return await v.call(t, list);
          } finally {
            bag.db += performance.now() - t0;
            bag.queries += list.length;
          }
        };
      }
      return v.bind(t);
    },
  });
}

/** 给响应补 Server-Timing。已经带过的（边缘缓存副本）不再覆盖。 */
export function withServerTiming(res, elapsedMs, bag) {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!ct.startsWith('text/html') && !ct.startsWith('application/json')) return res;
  if (res.headers.has('server-timing')) return res;

  const total = Math.max(0, elapsedMs);
  const db = Math.max(0, bag?.db || 0);
  const q = Math.max(0, bag?.queries || 0);
  /* 注意 db 与 total 不是包含关系。Promise.all 并行查库时，四条各 40ms 的
     查询累加成 160ms，而总耗时只有 45ms —— 累加的是"查询各自花了多久"，
     不是"这条请求在库里待了多久"。实测 /cat/log 出现过 db=173 / total=137。
     所以这里不假装它们是嵌套的：db 标 desc 里的条数，app 钳到 0 就是
     "并行等待已经吃满了总时长，模板没剩下可归因的墙钟"。 */
  const app = Math.max(0, total - db);
  const r1 = (n) => Math.round(n * 10) / 10;

  const headers = new Headers(res.headers);
  headers.set('server-timing', `db;dur=${r1(db)};desc="${q}q", app;dur=${r1(app)}, total;dur=${r1(total)}`);
  /* 304 没有 body，别用空 Uint8Array 顶——那会造出一个长度 0 但存在的 body，
     和 304 的语义冲突。 */
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
