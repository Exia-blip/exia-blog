/* [P-110] 桌面框架体检：用真计算样式验「导航 / 主区 / 页脚」是不是同一条基线。
 *
 * 为什么不用 CSS 文本断言：三处宽度此前分别是 1180 / 704 / 760，文本里每一个数
 * 都写得清清楚楚，页面看起来仍是「手机版居中」。判据必须落在浏览器算出来的盒子上。
 *
 * 用法（先起本地服务）：
 *   npx wrangler dev --port 8787
 *   node scripts/check-desktop.mjs
 *   AUDIT_ORIGIN=https://miu.sryze.cc node scripts/check-desktop.mjs
 *
 * 判据：
 *   · 1920 / 1440 / 1080：导航内框、主区、页脚内框左右边界一致（±1px）
 *   · 1920 首页：文章卡片两列、单卡 > 480px、右侧栏 300px、横幅两栏并排
 *     （[P-111] 白卡版式：加 300 右栏后单卡从 675 落到 516，门槛随版式重定，
 *      继续守的是「不是 660 窄带」而不是某个具体像素）
 *   · 390 首页：仍单列、页脚竖排、汉堡出现；移动端没被桌面框架带跑
 *   · 手机形态（[P-115]）：390 卡片横排、图占卡宽 25%–42%、卡高 ≤130、首页总高 ≤3600；
 *     720/1024 两列紧凑卡；1440 仍 16:9 大封面、data-device=mouse
 *   · 1920 文章页：正文仍 660px；三列（目录/正文/右栏），右栏 300px 且不压正文卡
 *   · 1440 文章页：同样三列。文章页有自己的容器（.wrap-post），不必跟着全站 frame=1280 走；
 *     放宽到 1360 后 232+56+660+56+300 = 1304 ≤ 1316，右栏从 1400 起就位。
 *     （[P-112] 原判据是「右栏只在 ≥1600」，那是跟着 frame 走的代价，不是物理限制）
 *   · 1399 文章页仍两列：断点写低一档，1366 上正文卡会被右栏压住
 *   · 1920 归档页：右栏 300px、有内容、贴框架右边界；行内元信息贴右边界
 *     （[P-113] 「右栏在」不等于「右侧不空」：时间线仍两行堆叠时元信息全挤在左边）
 *   · 所有页面：无横向溢出，CSS 真的加载了（--frame 非空）
 */
import puppeteer from 'puppeteer-core';
import { resolveChrome } from './chrome.mjs';

const ORIGIN = process.env.AUDIT_ORIGIN || 'http://127.0.0.1:8787';
let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails++;
};

const browser = await puppeteer.launch({
  executablePath: resolveChrome(),
  headless: 'new',
  args: ['--no-first-run', '--disable-gpu'],
});

async function measure(path, width, touch = false) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 900, deviceScaleFactor: 1, isMobile: touch, hasTouch: touch });
  const u = new URL(path, ORIGIN);
  u.searchParams.set('cb', String(Date.now()));
  await page.goto(u.href, { waitUntil: 'networkidle2', timeout: 30000 });
  const data = await page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const cards = [...document.querySelectorAll('.post-card')].slice(0, 4).map((el) => Math.round(el.getBoundingClientRect().width));
    const firstCard = document.querySelector('main.home .post-card');
    const firstCover = document.querySelector('main.home .card-cover');
    const r = (el) => (el ? el.getBoundingClientRect() : null);
    const list = document.querySelector('.post-list');
    return {
      frame: getComputedStyle(document.documentElement).getPropertyValue('--frame').trim(),
      bgToken: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
      header: box('header.site .inner'),
      main: box('main'),
      footer: box('.sf-inner'),
      listDisplay: list ? getComputedStyle(list).display : '',
      cols: list ? getComputedStyle(list).gridTemplateColumns.split(/\s+/).filter(Boolean).length : 0,
      cards,
      body: box('.post-body'),
      articleCols: document.querySelector('.post-article')
        ? getComputedStyle(document.querySelector('.post-article')).gridTemplateColumns.split(/\s+/).filter(Boolean).length
        : 0,
      footerDir: document.querySelector('.sf-inner') ? getComputedStyle(document.querySelector('.sf-inner')).flexDirection : '',
      burger: document.querySelector('.nav-toggle') ? getComputedStyle(document.querySelector('.nav-toggle')).display : '',
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      side: box('.home-side'),
      postSide: box('.post-side'),
      archShell: box('.arch-shell'),
      archRail: box('.arch-rail'),
      archRailKids: document.querySelectorAll('.arch-rail > *').length,
      /* 行内元信息离行右边界多远。两行堆叠的排法下这个值约等于「整行宽 - 标题 - 元信息」，
         实测 700 上下；改成一行排布后应该只剩 .tl-item 的 padding-right（10）。 */
      tlMetaGap: (() => {
        const it = document.querySelector('.tl-item');
        const m = it && it.querySelector('.tl-meta');
        if (!m) return null;
        return Math.round(it.getBoundingClientRect().right - m.getBoundingClientRect().right);
      })(),
      heroMain: box('.hero-main'),
      heroFeature: box('.hero-feature'),
      /* 手机形态的判据：卡片是横排（图占卡宽 30% 上下）、不是大封面在上 */
      device: document.documentElement.getAttribute('data-device'),
      cardH: firstCard ? Math.round(r(firstCard).height) : null,
      cardW: firstCard ? Math.round(r(firstCard).width) : null,
      coverW: firstCover ? Math.round(r(firstCover).width) : null,
      coverH: firstCover ? Math.round(r(firstCover).height) : null,
      docH: document.body.scrollHeight,
      /* 侧栏折叠：开合状态读 [open] 属性（CSS 改不了它），
         内容在不在读 .side-fold-body 里还剩几张卡 —— 收起不等于删掉。 */
      sideFoldOpen: document.querySelector('.side-fold')?.open ?? null,
      foldBar: box('.side-fold-bar'),
      foldBarDisplay: document.querySelector('.side-fold-bar')
        ? getComputedStyle(document.querySelector('.side-fold-bar')).display
        : '',
      sideKids: document.querySelectorAll('.side-fold-body > .widget').length,
    };
  });
  await page.close();
  return data;
}

const aligned = (d, label) => {
  check(`${label} 三处边界对齐`, !!d.header && !!d.main && !!d.footer
    && Math.abs(d.header.l - d.main.l) <= 1 && Math.abs(d.main.l - d.footer.l) <= 1
    && Math.abs(d.header.r - d.main.r) <= 1 && Math.abs(d.main.r - d.footer.r) <= 1,
  `nav ${d.header?.l}-${d.header?.r} / main ${d.main?.l}-${d.main?.r} / foot ${d.footer?.l}-${d.footer?.r}`);
};

// 文章页路径从首页真实卡片取，不写死编号
const home = await fetch(`${ORIGIN}/`, { headers: { 'user-agent': 'desktop-audit/1.0' } });
/* 存下来一次：后面表格样本还要从同一份 HTML 里取前几篇文章的链接。
   Response.body 只能读一次，第二次 .text() 会抛 "Body has already been read"。 */
const homeHtml = await home.text();
const postPath = homeHtml.match(/href="(\/p\/[^"]+)"/)?.[1] || '/p/1';

for (const width of [1920, 1440, 1080]) {
  const d = await measure('/', width);
  console.log(`\n首页 @${width}px（frame=${d.frame || '未加载'}）`);
  check('CSS 已加载', !!d.bgToken && !!d.frame);
  check('无横向溢出', d.overflow <= 1, `${d.overflow}px`);
  aligned(d, '首页');
  if (width === 1920) {
    check('列表两列', d.listDisplay === 'grid' && d.cols === 2, `${d.listDisplay} / ${d.cols} 列`);
    /* 右栏固定 300 后单卡约 516：判据要求「明显宽于旧的 660 单列」而不是继续
       把 600 当门槛 —— 加侧栏是版式决策，卡片变窄是它的直接结果。 */
    check('单卡宽 > 480px', d.cards[0] > 480, `首卡 ${d.cards[0]}px`);
    check('右侧栏 300px', d.side?.w === 300, `${d.side?.w}px`);
    check('横幅两栏（右卡窄于主卡）', !!d.heroMain && !!d.heroFeature && d.heroMain.w > d.heroFeature.w, `${d.heroMain?.w} / ${d.heroFeature?.w}`);
    check('页脚横向排布', d.footerDir === 'row', d.footerDir);
    /* 桌面不折叠：summary 隐藏 + details 恒开。只验其中一个不够 ——
       summary 藏起来而 details 是收的，右栏会变成一条 300×0 的空槽。 */
    check('桌面侧栏不折叠', d.sideFoldOpen === true && d.foldBarDisplay === 'none',
      `open=${d.sideFoldOpen} / 折叠条 ${d.foldBarDisplay}`);
  }
  if (width === 1080) check('桌面断点已启用', d.frame === '1180px', d.frame);
  if (width === 1440) check('1440 档 frame=1280', d.frame === '1280px', d.frame);
}

const wide = await measure('/', 1920);
check('1920 档 frame=1408', wide.frame === '1408px', wide.frame);

const mobile = await measure('/', 390, true);
console.log('\n首页 @390px（触屏）');
check('CSS 已加载', !!mobile.bgToken);
check('无横向溢出', mobile.overflow <= 1, `${mobile.overflow}px`);
check('列表仍单列', mobile.listDisplay !== 'grid' && mobile.cards[0] < 390, `${mobile.listDisplay} / 首卡 ${mobile.cards[0]}px`);
check('页脚竖排', mobile.footerDir === 'column', mobile.footerDir);
check('汉堡可见', mobile.burger !== 'none', mobile.burger);
/* 手机形态：卡片从「大封面在上」换成「左图右文」。判据挂在几何上而不是
   「有没有某条 CSS」—— 图宽占卡宽 25%–42% 且卡高 ≤130 只可能在横排下成立；
   大封面走 16:9 时卡高是 315（改版前实测），这两个数不会同时命中。 */
check('设备判定为触屏', mobile.device === 'touch', mobile.device);
/* 横排的本质判据是「图撑满卡高」（flex row + align-items:stretch），
   比例区间只保证图不喧宾夺主。只验比例会漏：图有 max-width 246，
   卡片回到 block 时 246/676 仍落在 25%–42% 里，看着像通过了。 */
check('卡片横排（图高 ≈ 卡高）',
  !!mobile.coverH && !!mobile.cardH && Math.abs(mobile.coverH - mobile.cardH) <= 2,
  `图高 ${mobile.coverH} / 卡高 ${mobile.cardH}`);
check('图宽占卡宽 25%–42%',
  !!mobile.coverW && !!mobile.cardW && mobile.coverW / mobile.cardW >= 0.25 && mobile.coverW / mobile.cardW <= 0.42,
  `图 ${mobile.coverW} / 卡 ${mobile.cardW}`);
check('卡片高度 ≤ 130px', mobile.cardH !== null && mobile.cardH <= 130, `${mobile.cardH}px`);
/* 5937 是「大封面一屏一张」时的页高，2889 是横排后的页高。这条守的是密度，
   不是某个具体像素：只要还在一屏一张，这个数就回 5000 以上。 */
check('首页总高 ≤ 3600px（密度没退回一屏一张）', mobile.docH <= 3600, `${mobile.docH}px`);
/* 侧栏折叠：390 上三块（作者卡/标签/最近）默认收起，只留一条 50px 的折叠条。
   三件事分开验 —— 收起（open=false）、折叠条够高能点（≥44）、
   内容还在（三张卡仍在 DOM 里，只是没渲染）。只看页高会漏掉「三块被整个删了」。 */
check('侧栏默认收起', mobile.sideFoldOpen === false, `open=${mobile.sideFoldOpen}`);
check('折叠条可见且 ≥44px', mobile.foldBarDisplay !== 'none' && (mobile.foldBar?.w || 0) > 100 && (mobile.foldBar?.h || 0) >= 44,
  `${mobile.foldBarDisplay} / ${mobile.foldBar?.w}×${mobile.foldBar?.h}`);
check('三块卡仍在（收起≠删掉）', mobile.sideKids === 3, `${mobile.sideKids} 张`);

/* 平板/窄桌面：两列紧凑卡。这一档以前是「单列大卡居中在 704 的窄带里」 */
const narrow = await measure('/', 720);
console.log('\n首页 @720px');
check('两列紧凑卡', narrow.listDisplay === 'grid' && narrow.cols === 2, `${narrow.listDisplay} / ${narrow.cols} 列`);
check('卡片仍是横排', !!narrow.coverH && !!narrow.cardH && Math.abs(narrow.coverH - narrow.cardH) <= 2,
  `图高 ${narrow.coverH} / 卡高 ${narrow.cardH}`);

const tablet = await measure('/', 1024, true);
console.log('\n首页 @1024px（触屏平板）');
/* 同一宽度、两种输入方式：版式都按宽度走，但 data-device 要如实标注，
   JS 侧才能据此决定手势与图片策略 */
check('设备判定为触屏', tablet.device === 'touch', tablet.device);
check('两列紧凑卡', tablet.listDisplay === 'grid' && tablet.cols === 2, `${tablet.listDisplay} / ${tablet.cols} 列`);

const deskTouch = await measure('/', 1440);
console.log('\n首页 @1440px（鼠标）');
check('设备判定为鼠标', deskTouch.device === 'mouse', deskTouch.device);
/* 桌面没被手机形态污染：封面仍是 16:9 大图（高/宽 ≈ 0.5625） */
check('桌面封面仍 16:9', !!deskTouch.coverW && !!deskTouch.cardH
  && Math.abs(deskTouch.coverH / deskTouch.coverW - 0.5625) <= 0.04,
  `${deskTouch.coverW}×${deskTouch.coverH}`);

for (const [name, path] of [['归档', '/archive'], ['栏目', '/categories']]) {
  const d = await measure(path, 1920);
  console.log(`\n${name} @1920px`);
  check('CSS 已加载', !!d.bgToken);
  check('无横向溢出', d.overflow <= 1, `${d.overflow}px`);
  aligned(d, name);
  if (name === '归档') {
    /* 三件事一起验：右栏在（不是被挤没了）、真的有内容（空 aside 也有 300 宽）、
       右边贴住框架右边界（否则整个 shell 缩在左边，右侧照样空）。 */
    check('右栏 300px', d.archRail?.w === 300, `${d.archRail?.w}px`);
    check('右栏有内容', d.archRailKids >= 2, `${d.archRailKids} 张卡`);
    /* 比的是 .arch-shell 而不是 main：main 的盒子含 .wrap 左右各 22 的内边距，
       拿它当右边界会把 22px 的留白判成「没贴边」。 */
    check('右栏贴 shell 右边界', !!d.archRail && !!d.archShell && Math.abs(d.archRail.r - d.archShell.r) <= 1,
      `栏右 ${d.archRail?.r} / shell 右 ${d.archShell?.r}`);
    /* 只验「右栏存在」会漏掉「时间线还是原来的两行堆叠」——那时右栏也对，右侧仍是空的。
       这条盯的是行内：元信息离行右边界只剩 padding，说明标题那列撑满了整行。 */
    check('行内元信息贴右边界', d.tlMetaGap !== null && d.tlMetaGap <= 12, `差 ${d.tlMetaGap}px`);
  }
}

/* 文章页三档分开验：1920 / 1440 都要三列，1399 必须还是两列。
   三列 = 目录 / 正文 / 右栏；只看列数不够 —— 第三列缩成 120 也照样是三列，
   所以同时验右栏 300 与「不压正文卡」。
   正文卡向右外扩 40px，右边沿用 body.r + 40，与 .post-main::before 的 inset 同源。 */
const postWide = await measure(postPath, 1920);
console.log('\n文章 @1920px');
check('CSS 已加载', !!postWide.bgToken);
check('无横向溢出', postWide.overflow <= 1, `${postWide.overflow}px`);
check('正文仍 660px', postWide.body?.w === 660, `${postWide.body?.w}px`);
check('三列：目录 / 正文 / 右栏', postWide.articleCols === 3, `${postWide.articleCols} 列`);
check('右栏 300px', postWide.postSide?.w === 300, `${postWide.postSide?.w}px`);
check('右栏不压正文卡', !!postWide.postSide && !!postWide.body && postWide.postSide.l - (postWide.body.r + 40) >= 0,
  `栏左 ${postWide.postSide?.l} / 卡右 ${postWide.body ? postWide.body.r + 40 : '?'}`);

/* 1440 是主流桌面宽度。右栏落在正文下面的排法下，一篇长文的相关文章在第 15000px，
   等于不存在 —— 这条验的就是「1440 也已经在第三列」。
   间距门槛 12 而不是 0：两缝各 56，扣掉 40 的外扩还剩 16，白卡之间必须留得下呼吸。 */
const post1440 = await measure(postPath, 1440);
console.log('\n文章 @1440px');
check('三列：目录 / 正文 / 右栏', post1440.articleCols === 3, `${post1440.articleCols} 列`);
check('右栏 300px', post1440.postSide?.w === 300, `${post1440.postSide?.w}px`);
check('右栏不压正文卡', !!post1440.postSide && !!post1440.body && post1440.postSide.l - (post1440.body.r + 40) >= 12,
  `栏左 ${post1440.postSide?.l} / 卡右 ${post1440.body ? post1440.body.r + 40 : '?'}`);
check('正文仍 660px', post1440.body?.w === 660, `${post1440.body?.w}px`);
check('无横向溢出', post1440.overflow <= 1, `${post1440.overflow}px`);

/* 断点下一档必须仍然两列：1400 的规则若写低到 1330，1366 的容器只有 1180（可用 1136），
   1304 的硬需求放不下，正文卡会直接压到右栏上。 */
const postNarrow = await measure(postPath, 1399);
console.log('\n文章 @1399px（断点边界）');
check('仍两列（右栏落底）', postNarrow.articleCols === 2, `${postNarrow.articleCols} 列`);
check('无横向溢出', postNarrow.overflow <= 1, `${postNarrow.overflow}px`);

/* ---------- 2026-11-28 审计 P0 的真实渲染验证 ----------
   这三条的对方物都是「浏览器算出来的东西」，源码断言只能证明写了，证明不了生效：
   横幅图被 object-fit 裁掉一半时 CSS 全对；表格的 mask 写着但被别的规则压住时也全对；
   深色 filter 只在 data-mode 是 dark 时才命中，而 dark 是 JS 在首帧后设的。 */
console.log('\n视觉修复 · 真浏览器');

/* ① 栏目页横幅：本页首篇的缩略图，不是 1200×630 的 OG 图 */
const catPage = await browser.newPage();
await catPage.setViewport({ width: 1440, height: 900 });
await catPage.goto(`${ORIGIN}/cat/log?cb=${Date.now()}`, { waitUntil: 'networkidle2' });
const hero = await catPage.evaluate(() => {
  const f = document.querySelector('.hero-feature');
  const img = f && f.querySelector('.hf-img');
  return { href: f?.getAttribute('href') || '', src: img?.getAttribute('src') || '' };
});
check('栏目页横幅指向本页首篇', /^\/p\//.test(hero.href), hero.href);
check('栏目页横幅不用 OG 图', !!hero.src && !/og-default/.test(hero.src), hero.src.slice(0, 48));
await catPage.close();

/* ② 深色封面压暗：filter 必须落在卡片封面与横幅图上 */
const darkPage = await browser.newPage();
await darkPage.setViewport({ width: 1440, height: 900 });
await darkPage.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
await darkPage.goto(`${ORIGIN}/?cb=${Date.now()}`, { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 400));
const dark = await darkPage.evaluate(() => {
  const card = document.querySelector('.post-card .thumb');
  const hf = document.querySelector('.hero-feature .hf-img');
  return {
    mode: document.documentElement.dataset.mode,
    card: card ? getComputedStyle(card).filter : '',
    hero: hf ? getComputedStyle(hf).filter : '',
  };
});
check('深色模式已生效', dark.mode === 'dark', dark.mode);
check('深色封面压暗到 0.7x', /brightness\(0?\.7/.test(dark.card), dark.card);
check('深色横幅压暗但不过度', /brightness\(0?\.8/.test(dark.hero), dark.hero);
await darkPage.close();

/* ③ 手机表格：真溢出才挂类、右缘渐隐、滑到末尾撤掉。
   首页第一篇不一定带表格（ci-fixture 就没有），所以从首页前 6 篇里找第一篇
   真的有溢出表格的 —— 找不到就明确报失败，不用 ok(true) 糊过去（那是 skip-as-pass）。 */
const postLinks = [...new Set([...homeHtml.matchAll(/href="(\/p\/[^"]+)"/g)].map((m) => m[1]))].slice(0, 6);
let tblPage = null;
let tb = null;
for (const p of postLinks) {
  const pg = await browser.newPage();
  await pg.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await pg.goto(`${ORIGIN}${p}?cb=${Date.now()}`, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 400));
  const got = await pg.evaluate(() => {
    const w = document.querySelector('.md .table-wrap');
    if (!w) return null;
    const cs = getComputedStyle(w);
    return { over: w.scrollWidth - w.clientWidth, cls: w.className, mask: cs.maskImage || cs.webkitMaskImage || '' };
  });
  if (got && got.over > 4) { tblPage = pg; tb = { ...got, path: p }; break; }
  await pg.close();
}
check('找到溢出表格样本', !!tb, tb ? `${tb.path} 溢出 ${tb.over}px` : '首页前 6 篇都没有溢出表格');
if (tb) {
  check('溢出表格标了 overflow', /overflowing/.test(tb.cls), tb.cls);
  check('溢出表格有右缘渐隐', /linear-gradient/.test(tb.mask), tb.mask.slice(0, 44));
  await tblPage.evaluate(() => {
    const w = document.querySelector('.md .table-wrap');
    if (w) w.scrollLeft = w.scrollWidth;
  });
  await new Promise((r) => setTimeout(r, 250));
  const tbEnd = await tblPage.evaluate(() => {
    const w = document.querySelector('.md .table-wrap');
    const cs = getComputedStyle(w);
    return { cls: w.className, mask: cs.maskImage || cs.webkitMaskImage || '' };
  });
  check('滑到末尾撤掉渐隐', /at-end/.test(tbEnd.cls) && /none/.test(tbEnd.mask),
    `${tbEnd.cls} / ${tbEnd.mask}`);
  await tblPage.close();
}

/* ---------- 2026-11-28 审计 P1 的真实渲染验证 ----------
   这一批的对方物同样是浏览器算出来的东西：mask 写着但被别条规则压住看不出来，
   卡片「留两行」留没留只有量高度才知道，行内代码断没断只有数 client rects 才知道。 */
console.log('\nP1 修复 · 真浏览器');

/* ④ 卡片同高：摘要恒出 + 两行留白之后，一行里的卡不能再有三种高度 */
for (const w of [1440, 1920]) {
  const pg = await browser.newPage();
  await pg.setViewport({ width: w, height: 900 });
  await pg.goto(`${ORIGIN}/?cb=${Date.now()}`, { waitUntil: 'networkidle2' });
  const hs = await pg.evaluate(() => {
    const cards = [...document.querySelectorAll('main.home .post-card')];
    const covers = [...document.querySelectorAll('main.home .card-cover')];
    return {
      h: [...new Set(cards.map((c) => Math.round(c.getBoundingClientRect().height)))],
      cover: [...new Set(covers.map((c) => Math.round(c.getBoundingClientRect().height)))],
    };
  });
  check(`首页 @${w} 卡片单一高度`, hs.h.length === 1, `${hs.h.length} 种：${hs.h.slice(0, 4).join('/')}`);
  check(`首页 @${w} 封面同高（没被 grid 拉伸补齐）`, hs.cover.length === 1, `${hs.cover.slice(0, 4).join('/')}`);
  await pg.close();
}

/* ⑤ 代码块右缘渐隐 + 滑到末尾撤掉。390 下找第一篇真有溢出代码的文章 */
let codePg = null;
let codeGot = null;
for (const p of postLinks) {
  const pg = await browser.newPage();
  await pg.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await pg.goto(`${ORIGIN}${p}?cb=${Date.now()}`, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 400));
  const got = await pg.evaluate(() => {
    for (const wrap of document.querySelectorAll('.code-wrap')) {
      const pre = wrap.querySelector('pre.code-block');
      if (!pre || pre.scrollWidth - pre.clientWidth <= 4) continue;
      const cs = getComputedStyle(pre);
      return {
        cls: wrap.className,
        mask: cs.maskImage || cs.webkitMaskImage || '',
        after: getComputedStyle(wrap, '::after').backgroundImage || '',
      };
    }
    return null;
  });
  if (got) { codePg = pg; codeGot = { ...got, path: p }; break; }
  await pg.close();
}
check('找到溢出代码块样本', !!codeGot, codeGot ? `${codeGot.path}` : '首页前 6 篇都没有溢出代码块');
if (codeGot) {
  check('溢出代码块有右缘渐隐（mask 在 pre 上）', /linear-gradient\(to right/.test(codeGot.mask), codeGot.mask.slice(0, 40));
  /* 旧的覆盖层是按 .code-head 高度定位的，撤掉之后 ::after 不该再画东西 */
  check('不再用 ::after 覆盖层', !codeGot.after || codeGot.after === 'none', codeGot.after.slice(0, 32));
  await codePg.evaluate(() => {
    const pre = document.querySelector('.code-wrap.overflowing pre.code-block');
    if (pre) pre.scrollLeft = pre.scrollWidth;
  });
  await new Promise((r) => setTimeout(r, 300));
  const endMask = await codePg.evaluate(() => {
    const wrap = document.querySelector('.code-wrap');
    const pre = wrap && wrap.querySelector('pre.code-block');
    return { cls: wrap ? wrap.className : '', mask: pre ? getComputedStyle(pre).maskImage : '' };
  });
  check('代码块滑到末尾撤掉渐隐', /at-end/.test(endMask.cls) && endMask.mask === 'none', `${endMask.cls} / ${endMask.mask}`);
  /* ⑥ 行内代码：放得下的一律不断，断了的只能是真放不下的长串 */
  const inl = await codePg.evaluate(() => {
    const codes = [...document.querySelectorAll('.md code')].filter((c) => !c.closest('pre'));
    const split = codes.filter((c) => c.getClientRects().length > 1);
    return {
      total: codes.length,
      keep: codes.filter((c) => c.classList.contains('code-keep')).length,
      splitShort: split.filter((c) => c.textContent.trim().length <= 12).map((c) => c.textContent.trim()).slice(0, 4),
      over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  check('行内代码无横向溢出', inl.over <= 1, `${inl.over}px`);
  check('短行内代码不再被拆行', inl.splitShort.length === 0, inl.splitShort.join(' / ') || '无');
  await codePg.close();
}

/* ⑦ 窄屏浮层：只剩一条 40px 的胶囊，独立的回顶按钮收起 */
const fabPg = await browser.newPage();
await fabPg.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
await fabPg.goto(`${ORIGIN}${postPath}?cb=${Date.now()}`, { waitUntil: 'networkidle2' });
await fabPg.evaluate(() => scrollTo({ top: 2000 }));
await new Promise((r) => setTimeout(r, 400));
const fab = await fabPg.evaluate(() => {
  const pill = document.querySelector('.mtoc-btn');
  const top = document.querySelector('.back-top');
  const box = (e) => (e ? { h: Math.round(e.getBoundingClientRect().height), bottom: Math.round(innerHeight - e.getBoundingClientRect().bottom) } : null);
  return {
    pill: box(pill),
    pillOn: pill ? pill.classList.contains('on') : false,
    segs: pill ? pill.querySelectorAll('button').length : 0,
    topDisp: top ? getComputedStyle(top).display : 'none',
  };
});
check('有目录胶囊', !!fab.pill && fab.pillOn, JSON.stringify(fab.pill));
check('胶囊只有一行高', !!fab.pill && fab.pill.h <= 44, `${fab.pill?.h}px`);
check('胶囊贴底（不再给回顶留位置）', !!fab.pill && fab.pill.bottom <= 24, `距底 ${fab.pill?.bottom}px`);
check('胶囊拆成两段', fab.segs === 2, `${fab.segs} 段`);
check('独立回顶按钮已收起', fab.topDisp === 'none', fab.topDisp);
await fabPg.close();

/* ⑧ 评论邮箱 placeholder 在 390 下不被截：文字宽度必须小于输入框内容宽 */
const phPg = await browser.newPage();
await phPg.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
await phPg.goto(`${ORIGIN}${postPath}?cb=${Date.now()}`, { waitUntil: 'networkidle2' });
const ph = await phPg.evaluate(() => {
  const i = document.querySelector('#cmt-email');
  if (!i) return null;
  const cs = getComputedStyle(i);
  const c = document.createElement('canvas').getContext('2d');
  c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  return {
    box: i.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
    text: c.measureText(i.placeholder).width,
    ph: i.placeholder,
  };
});
check('评论邮箱 placeholder 放得下', !!ph && ph.text <= ph.box, ph ? `${Math.round(ph.text)} / ${Math.round(ph.box)}px 「${ph.ph}」` : '找不到 #cmt-email');
await phPg.close();

await browser.close();
console.log(fails ? `\n✗ ${fails} 项桌面框架断言失败` : '\n✓ 桌面框架断言全部通过');
process.exit(fails ? 1 : 0);
