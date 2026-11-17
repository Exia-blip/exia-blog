#!/usr/bin/env node
/**
 * alt 兜底规则。
 *
 * 这条规则的默认行为是「什么都不做」—— 空 alt 在无障碍语义里是「装饰图，跳过」，
 * 是合法且常常正确的答案。兜底只在文件名真的带信息时生效。
 *
 * 所以要拦的失败模式是「兜出了一个乱码」：R2 的 key 是 mvv7xrrwzzr5x3 这种随机串，
 * 一旦被当成 alt，读屏会逐字符念完，比没有 alt 更糟。
 */
import { renderBody } from '../public/md.js';

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

const alt = (md) => {
  const m = /alt="([^"]*)"/.exec(renderBody(md));
  return m ? m[1] : null;
};

/* ---- 该兜的 ---- */
t(alt('![](/img/u/r2-image-pipeline-cover.png)') === 'r2 pipeline cover', '连字符文件名 → 空格分词');
t(alt('![](/img/u/architecture_diagram.png)') === 'architecture diagram', '下划线同理');
t(alt('![](/img/u/%E6%9E%B6%E6%9E%84%E5%9B%BE.png)') === '架构图', 'URL 编码的中文文件名解回中文');
t(alt('![](/img/u/base-64-encode.png)') === 'base 64 encode', '数字段落保留（不是时间戳/随机串）');

/* ---- 不该兜的 ---- */
t(alt('![](/img/u/mvv7xrrwzzr5x3.jpg)') === '', 'R2 随机 key → 保持空 alt');
t(alt('![](/img/u/IMG_20241116_142233.jpg)') === '', '相机文件名去掉时间戳后没剩东西 → 空');
t(alt('![](/img/u/screenshot.png)') === '', '纯 screenshot → 空（这个词没有描述性）');
t(alt('![](/img/u/a.png)') === '', '单字符文件名 → 空');
t(alt('![](/img/u/12345.png)') === '', '纯数字 → 空');

/* ---- 作者写了就用作者的 ---- */
t(alt('![手写的描述](/img/u/mvv7xrrwzzr5x3.jpg)') === '手写的描述', '有 alt 时不覆盖');
t(alt('![a"b](/img/u/x.png)') === 'a&quot;b', '作者写的 alt 仍然转义（防属性逃逸）');

/* ---- 兜出来的内容也要转义 ---- */
t(alt('![](/img/u/a%3Cb%3E.png)') === 'a&lt;b&gt;', '文件名带尖括号：转义后才进属性，破不了标签');

/* ---- 尺寸参数不参与推导 ---- */
t(alt('![](/img/u/architecture-diagram.png?w=1200&h=800)') === 'architecture diagram', '查询串不混进 alt');
t(alt('![](/img/u/architecture-diagram-1200x800.png)') === 'architecture diagram', '文件名里的 1200x800 被剥掉');

console.log(`\n${fails.length ? 'FAIL' : 'PASS'}  ${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
