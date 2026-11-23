// 绕过探针：对线上渲染器（public/md.js）逐条跑真实输入，打印原样输出。
// 用法：node scripts/probe-md.mjs
// 目的：文章里贴的输出必须是这里跑出来的，不是手写的"应该会"。
// 探针定义已抽到 md-probes.mjs，和快照测试共用同一份，避免两边各自漂移。
import { renderBody } from '../public/md.js';
import { probes } from './md-probes.mjs';

for (const [name, md] of probes) {
  console.log(`── ${name}`);
  console.log(`入 ${JSON.stringify(md)}`);
  console.log(`出 ${renderBody(md)}`);
  console.log('');
}
