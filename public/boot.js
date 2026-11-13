/* 全站启动脚本。
   不挂在任何模块依赖上，用 defer 直接引在 <head>：模块图一断，进度条和统计就没了，
   这两件事恰恰是最不该跟着某个页面逻辑一起坏的。

   两件事：
   1. 导航进度条 —— 站内点击后立刻有反馈。跨文档导航时旧页爬到 88% 停住，
      新页落地后补到 100% 再淡出，中间不会出现「点了没反应」的空白期。
      为什么不用骨架屏：这个站 HTML 是 SSR 的，等待时间本来就短，
      骨架屏反而制造一次「白块闪一下」。
   2. 一次访问上报 —— sendBeacon 走 /api/pv，在 load 之后才发，不进关键路径。 */
(function () {
  'use strict';

  var KEY = 'x_nav_pending';
  var reduce = false;
  try {
    reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) {}

  /* ---------------- 导航进度条 ---------------- */

  var el = null;
  var slowTimer = 0;
  var fallbackTimer = 0;

  function ensure() {
    if (el && el.isConnected) return el;
    el = document.createElement('div');
    el.className = 'nav-prog';
    el.setAttribute('aria-hidden', 'true');
    (document.body || document.documentElement).appendChild(el);
    return el;
  }

  function begin() {
    var b = ensure();
    clearTimeout(slowTimer);
    b.style.transition = 'none';
    b.style.transform = 'scaleX(0)';
    b.style.opacity = '1';
    if (reduce) {
      // 减少动效的人不需要一条爬行的线，但「正在加载」这件事仍要告诉他们：
      // 直接显示到 90%，落地再收掉，全程没有过渡。
      b.style.transform = 'scaleX(.9)';
      return;
    }
    // 强制一次样式计算，否则下面两段 transition 会被合并成一次跳变
    void b.offsetWidth;
    b.style.transition = 'transform .22s ease-out';
    b.style.transform = 'scaleX(.54)';
    // 后半段故意放慢：真慢的时候也能让人看出「还在走」，而不是卡死在半路
    slowTimer = setTimeout(function () {
      b.style.transition = 'transform 2.2s cubic-bezier(.08, .62, .18, 1)';
      b.style.transform = 'scaleX(.9)';
    }, 230);
  }

  function done() {
    if (!document.querySelector('.nav-prog')) return;
    var b = ensure();
    clearTimeout(slowTimer);
    b.style.transition = 'transform .16s ease-out, opacity .18s ease-out .1s';
    b.style.transform = 'scaleX(1)';
    b.style.opacity = '0';
    setTimeout(function () {
      if (b && b.parentNode) b.parentNode.removeChild(b);
    }, 380);
  }

  function abort() {
    try {
      sessionStorage.removeItem(KEY);
    } catch (e) {}
    clearTimeout(fallbackTimer);
    done();
  }

  // 落地：上一个页面点了链接，这一页就是它的结果
  try {
    if (sessionStorage.getItem(KEY)) {
      sessionStorage.removeItem(KEY);
      // 先让出一帧，否则进度条刚插进 DOM 就被移除，看不到收尾
      requestAnimationFrame(function () {
        requestAnimationFrame(done);
      });
    }
  } catch (e) {}

  document.addEventListener(
    'click',
    function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      if (a.target === '_blank' || a.hasAttribute('download')) return;
      var raw = a.getAttribute('href');
      if (!raw || raw.charAt(0) === '#' || /^(mailto|tel|javascript):/i.test(raw)) return;
      var u;
      try {
        u = new URL(a.href, location.href);
      } catch (err) {
        return;
      }
      if (u.origin !== location.origin) return;
      // 同页跳转（只改了 hash 或 query 相同）不该起进度条
      if (u.pathname === location.pathname && u.search === location.search) return;
      try {
        sessionStorage.setItem(KEY, '1');
      } catch (err) {}
      begin();
      // 目标页面被拦下（登录确认、客户端路由接管）时，4 秒后自己收掉，不留半条线挂在顶上
      clearTimeout(fallbackTimer);
      fallbackTimer = setTimeout(abort, 4000);
    },
    true
  );

  // 后退/前进：同样是「点了就等」，但 bfcache 恢复时新文档不会重新执行脚本，
  // 所以只处理非 persisted 的跳转
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) {
      try {
        sessionStorage.removeItem(KEY);
      } catch (err) {}
      if (document.querySelector('.nav-prog')) done();
    }
  });

  /* ---------------- 访问统计 ---------------- */

  function track() {
    // 页面已经挂了外部统计（umami），就别再记一份，否则两边数字打架
    if (window.__PV_OFF__) return;
    // 尊重 DNT / GPC：这类请求一个字节都不发
    if (navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl) return;
    var payload = JSON.stringify({
      p: location.pathname + location.search,
      r: document.referrer || '',
    });
    try {
      if (navigator.sendBeacon) {
        // Blob 带上 type，服务端才能 request.json()
        navigator.sendBeacon('/api/pv', new Blob([payload], { type: 'application/json' }));
      } else {
        fetch('/api/pv', {
          method: 'POST',
          body: payload,
          headers: { 'content-type': 'application/json' },
          keepalive: true,
          credentials: 'omit',
        }).catch(function () {});
      }
    } catch (e) {}
  }

  function scheduleTrack() {
    // 只统计真实看到页面的人：标签页在后台的，等它真的被切到前台再说
    if (document.visibilityState === 'hidden') {
      document.addEventListener('visibilitychange', function once() {
        if (document.visibilityState === 'visible') {
          document.removeEventListener('visibilitychange', once);
          setTimeout(track, 1200);
        }
      });
      return;
    }
    var idle = window.requestIdleCallback || function (cb) {
      return setTimeout(cb, 1400);
    };
    idle(function () {
      setTimeout(track, 600);
    });
  }

  if (document.readyState === 'complete') scheduleTrack();
  else window.addEventListener('load', scheduleTrack, { once: true });
})();
