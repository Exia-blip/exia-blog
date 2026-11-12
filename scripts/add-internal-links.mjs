// 给每篇末尾补一段相关阅读（内链规则：只指发布时间更早的文章，避免发布当天出现死链）
import { readFileSync, writeFileSync } from 'node:fs';

const dir = 'content/';

const adds = {
  '14-three-layer-cache.md': `
相关：一次渲染到底要花几次往返，是另一条线，[《Worker 渲染从 549ms 到 96ms》](/p/worker-render-549-to-96)把它拆成了预热、并发、缓存三块；图片这条链路的缓存口径单独写在[《R2 图片链路》](/p/r2-image-pipeline)。
`,
  '15-jwt-exp-verify.md': `
相关：这篇讲「拿到 token 之后怎么被信任」。[《token 到手之后：过期、刷新、撤销分别归谁管》](/p/oauth-token-lifecycle)讲的是上游那一半——token 怎么来、什么时候该换；[《Authorization Code：为什么要绕一个 302》](/p/oauth-auth-code)是整条链路的起点。
`,
  '16-samesite-behavior.md': `
相关：系列上一篇是[《JWT 的 exp 到底在哪一层被校验》](/p/jwt-exp-verify)，讲凭证本身；这一篇讲凭证怎么被浏览器带出去。再往后是[《CORS 预检不是每个请求都发》](/p/cors-preflight-cost)——SameSite 决定「带不带」，CORS 决定「带了之后让不让读」，两套闸各管一头。
`,
  '17-cors-preflight-cost.md': `
相关：SameSite 管「cookie 带不带」，是[上一篇](/p/samesite-behavior)；这里管「跨域读了之后让不让用」。预检省下来的那次往返值多少钱，按[《Worker 渲染从 549ms 到 96ms》](/p/worker-render-549-to-96)量出来的 41ms 单次成本算就清楚了。
`,
  '18-turnstile-what-it-blocks.md': `
相关：三层防线的完整实现（蜜罐、Turnstile、D1 限额）在[《评论区防滥用》](/p/comment-anti-spam)；系列上一篇是[《CORS 预检不是每个请求都发》](/p/cors-preflight-cost)。
`,
  '19-workers-free-tier-limits.md': `
相关：cpuTime 与 wallTime 怎么读、为什么两者的差值决定你该优化什么，在[《Worker 渲染从 549ms 到 96ms》](/p/worker-render-549-to-96)；subrequest 撞上限的实测过程在[《Workers 里 fetch 超时不是网络慢》](/p/workers-subrequest-limit)。
`,
  '20-d1-kv-r2-latency.md': `
相关：把多次查询压成一次的具体改法，在[《Worker 渲染从 549ms 到 96ms》](/p/worker-render-549-to-96)；缓存三层各自的口径在[《三层缓存怎么排》](/p/three-layer-cache)。
`,
};

for (const [f, extra] of Object.entries(adds)) {
  const p = dir + f;
  let s = readFileSync(p, 'utf8').replace(/\s+$/, '');
  s += '\n' + extra;
  writeFileSync(p, s);
  console.log(f, 'ok', s.length);
}
