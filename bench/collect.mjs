// 采集：每个 target 打 3 轮，丢掉第一轮（isolate 预热），合并后两轮算分布。
import { writeFileSync } from 'node:fs';

const BASE = 'https://exia-bench.meitu.workers.dev';
const N_DEFAULT = 60;
const N_SMALL = 30; // 写操作慢，样本数减半控制总时长
const targets = ['d1noop', 'd1point', 'd1list', 'd1agg', 'd1write', 'r2head', 'r2get', 'r2put', 'kvget', 'kvgetcold', 'kvput'];
const ROUNDS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nOf = (t) => (['r2put', 'kvput', 'd1write'].includes(t) ? N_SMALL : N_DEFAULT);

async function hit(t, n) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120000);
  try {
    const r = await fetch(`${BASE}/bench/${t}?n=${n}`, { signal: ctl.signal });
    if (!r.ok) throw new Error(`${t} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

const out = { collected_at: new Date().toISOString(), base: BASE, results: {} };

for (const t of targets) {
  const n = nOf(t);
  const rounds = [];
  for (let i = 0; i < ROUNDS; i++) {
    const t0 = Date.now();
    try {
      rounds.push(await hit(t, n));
    } catch (e) {
      rounds.push({ error: String(e.message) });
    }
    console.log(`  ${t} round${i} ${Date.now() - t0}ms`);
    await sleep(300);
  }
  const kept = rounds.slice(1).filter((r) => !r.error);
  const samples = kept.flatMap((r) => r.samples).sort((a, b) => a - b);
  const pick = (k) => samples[Math.min(samples.length - 1, Math.floor(samples.length * k))];
  out.results[t] = {
    requested_n: n,
    kept_samples: samples.length,
    min: samples[0] ?? null,
    p50: pick(0.5) ?? null,
    p95: pick(0.95) ?? null,
    p99: pick(0.99) ?? null,
    max: samples[samples.length - 1] ?? null,
    avg: samples.length ? Math.round((samples.reduce((a, b) => a + b, 0) / samples.length) * 100) / 100 : null,
    samples,
    errors: rounds.filter((r) => r.error).map((r) => r.error),
  };
  const r = out.results[t];
  console.log(`${t.padEnd(9)} n=${String(r.kept_samples).padStart(3)} p50=${String(r.p50).padStart(7)} p95=${String(r.p95).padStart(7)} max=${String(r.max).padStart(7)}`);
}

writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('\n-> bench/results.json');
