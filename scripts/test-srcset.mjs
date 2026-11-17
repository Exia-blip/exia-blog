#!/usr/bin/env node
/**
 * 多宽度变体的两条回归：产出侧（srcset 长什么样）与消费侧（回退链怎么走）。
 *
 * 这一组全是「不报错但结果错」的类型：
 *   1. srcset 里写了没产出的档位 → 浏览器选中 → 回退到全尺寸 → 白写一遍
 *   2. 小图也写 1200w 描述符 → 浏览器按 1200 排，实际发来 400px 的图 → 糊
 *   3. 回退链里把 avif 塞给要 webp 的请求 → 不认 avif 的浏览器收下才裂
 *   4. 链里包含请求自身 → 每次冷 miss 多一次必然落空的 R2 往返
 */
import { renderBody } from '../public/md.js';
import { imgVariantChain } from '../src/index.js';

let pass = 0;
const fails = [];
const t = (ok, name, extra = '') => {
  if (ok) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fails.push(name);
    console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`);
  }
};

const html = (md) => renderBody(md);

/* ---- 产出侧 ---- */
const big = html('![a](/img/u/a.png?w=1600&h=900)');
t(/\.w480\.avif 480w/.test(big), '1600px 的图有 480 档');
t(/\.w800\.avif 800w/.test(big), '有 800 档');
t(/\.w1200\.avif 1200w/.test(big), '有 1200 档');
t(/\/img\/u\/a\.png\.avif 1600w/.test(big), '最后一档是全尺寸，描述符是原图真实宽度');
t((big.match(/ sizes=/g) || []).length === 2, 'avif 与 webp 两个 source 都带 sizes');
t(/sizes="\(max-width: 780px\) calc\(100vw - 44px\), 716px"/.test(big), 'sizes 跟正文容器宽度对齐');
t(/<img src="\/img\/u\/a\.png" alt="a" width="1600" height="900"/.test(big), 'img 仍带真实宽高（CLS 靠它）');
t(!/w=[0-9]/.test(big), '宽高参数没有泄回地址（否则边缘缓存多一份分区）');

const small = html('![b](/img/u/b.png?w=400&h=300)');
t(!/\.w480/.test(small), '400px 的图不产 480 档');
t(!/sizes=/.test(small), '没有宽度档就不写 sizes');
t(/srcset="\/img\/u\/b\.png\.avif"/.test(small), '退化成只有格式变体');

const noSize = html('![c](/img/u/c.jpg)');
t(!/\.w480/.test(noSize), '不知道宽度时不猜档位');
t(/srcset="\/img\/u\/c\.jpg\.avif"/.test(noSize), '仍然给格式变体');

const webpSrc = html('![d](/img/u/d.webp?w=1600&h=900)');
t(!/\.webp 1600w/.test(webpSrc), '原图是 webp 就不再给 webp 候选（原图自己就是）');
t(/\.w800\.avif 800w/.test(webpSrc), 'webp 原图照样有多档 avif');
t((webpSrc.match(/<source/g) || []).length === 1, '只有一条 source');

const q = html('![e](/img/u/e.png?w=1600&h=900&v=3)');
t(/\/img\/u\/e\.png\.w480\.avif\?v=3 480w/.test(q), '带其它查询参数时后缀插在扩展名后，不拼到查询串尾巴');
t(/\/img\/u\/e\.png\.avif\?v=3 1600w/.test(q), '查询串保留在全尺寸档上');

/* ---- 消费侧：回退链 ---- */
const keys = (p) => (imgVariantChain(p) || { chain: [] }).chain.map(([k]) => k);

t(imgVariantChain('/img/x/a.png') === null, '原图地址不是变体，不处理');

const avifW = keys('u/a.png.w800.avif');
t(!avifW.includes('u/a.png.w800.avif'), '链里不含请求自身（否则多一次必然落空的 get）');
t(avifW[0] === 'u/a.png.w800.webp', 'avif 缺档时先降同档 webp');
t(avifW.includes('u/a.png.avif'), '再退全尺寸 avif');
t(avifW.includes('u/a.png.webp'), '最后退全尺寸 webp');

const webpW = keys('u/a.png.w800.webp');
t(!webpW.some((k) => /\.avif$/.test(k)), 'webp 的链里绝不出现 avif（升格式会发出解不开的文件）');
t(webpW.includes('u/a.png.webp'), 'webp 缺档时退全尺寸 webp');

const webpSrcChain = keys('u/a.webp.w480.avif');
t(!webpSrcChain.some((k) => k.endsWith('.webp.webp')), '原图是 webp 时不试 a.webp.webp');
t(webpSrcChain.includes('u/a.webp.avif'), '原图是 webp 时改为退全尺寸 avif');

t(keys('u/a.webp.w480.webp').length === 0, 'webp 原图请求 webp 档：链为空，直接回退原图');
t(imgVariantChain('u/a.png.avif').want === 'avif', 'want 能被调用方读到（用来打降级头）');
t(imgVariantChain('u/a.png.webp').want === 'webp', '同上');
t(imgVariantChain('a.png.w99.webp') === null, '两位数的宽度不算档位（避免把 a.w99 当变体）');
t(imgVariantChain('a.png.w99999.webp') === null, '五位数也不认');

/* 大小写：R2 的 key 是区分大小写的，正则要 i 但不能改写原 key */
const upper = imgVariantChain('u/A.PNG.W800.AVIF');
t(upper && upper.base === 'u/A.PNG', '大小写混写的地址能解析，且原样保留 key 大小写');

console.log(`\n${fails.length ? 'FAIL' : 'PASS'}  ${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
