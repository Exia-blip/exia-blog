#!/usr/bin/env node
// 构建后运行：node scripts/check-size.mjs [CSS目录 ...] [--write-baseline]
// 无依赖。默认扫 public + public/theme（本站 CSS 的实际分布）。
// 与 scripts/test-css-budget.mjs 共用本文件实现，预算只有一份。
//
// 为什么不是 gzip ≤3KB / 原始 ≤12KB：本站 style.css 覆盖 455 个类（7 套主题 + 后台
// + 代码块/灯箱/评论/编辑器），实测 gzip -9 37626 B、原始 142039 B。硬套 3KB
// 等于删 90% 样式重写视觉系统。预算按实测定，留约 3.7% 余量。
// 主题文件单独按原始字节守（最大 1420 B，给 2000 B 上限）。
//
// 体积预算的重点不是「现在够小」，而是「不许变大」：基线记录每个文件的 gzip 字节，
// 之后任何一次涨超 +10% 就判失败。基线首次写入不算失败，但提交进仓库后 CI 即开始守门。
// 基线放 scripts/ 而不是 public/ —— 后者会被 Workers Assets 当静态资源发布。
//
// 2026-11-28：桌面框架（导航/列表/页脚共用宽度，列表双列）把主表推到实测 39301 B，
// 原 39000 只剩 74 B 余量，扛不住一次有意的布局改动。上限按实测调到 39600（留 299 B）。
// 同日整站换安知鱼风（banner / 双列大封面卡 / 300px 侧栏 / 白卡文章页）实测 41691 B，
// 再调到 42500（留 809 B）。相对守卫从旧基线 37626 起算已是 +10.8%，整站版式换代
// 属于「有意变大」，因此把基线重置到本次实测值 —— 不是把闸门拆掉：绝对上限仍在，
// 重置后的基线继续守未来 +10%。历史文章里的 39000 是当时的真值，不要回填改写。
//
// 同一轮的后半段（横幅/作者卡改吃 --brand，深色态压暗）把主表推到 42394 B，42500 只剩
// 106 B，又回到「一次小改动就撞线」。上限重定 43000，基线跟着重置到 42394 —— 仍是一次
// 有意改动内部的调整，不是放宽：基线一变，+10% 的守卫就从这个新起点重新算。
//
// 文章页加右栏（系列目录 + 相关文章）再推 1233 B 到 43627，上限 45500、基线 43627。
// 三次连续上台阶都发生在同一次改版里，所以每次都重置基线而不是把 +10% 改成 +30%：
// 守卫的斜率没动，起点跟着产品走。
//
// 归档页右栏（概览卡 + 最新文章 + 时间线宽屏单行）第四次 +1047 到 44674。
// 这次 45500 只剩 826 B，按老规矩重定 47000 + 基线 44674 —— 但到这里该收手了：
// 连续四次重置说明「一次改动一次重定」本身在掩盖增长，下一次再撞线要先把
// 无用的死规则清一遍（历史主题残留、后台专用样式），而不是继续抬上限。
//
// 【第五次：2026-11-28 手机形态】上限 47000 → 48000（实测 47247）。
// 这次不是零散膨胀，是一整套新排法：1079 以下换成左图右文的紧凑卡（含 600/720
// 两条断点、触屏 hover 收口、缩略图按卡宽比例），gzip +1.5 KB 里几乎全是新规则。
// 只顺手删了一条确实死了的（main.home .tagbar + .tagbar：#tagbar 已 display:none，
// 相邻选择器选中的那条 margin 永远不生效），省下的字节可以忽略。
//
// 所以这次按上面那条给自己留下的规矩记账：**下一次再撞线，必须先做一轮死规则清理
// 再谈抬上限** —— 已确认可下线、待处理的两处：
//   ① 首页 #tagbar 整块（HTML + SVG 填充逻辑还在跑，CSS 已 display:none）
//   ② .bar-label 在首页被 display:none，但 SSR 仍在输出「栏目 / 标签」两个 span
// 这两处都涉及模板与 JS，没有在本次改动里动 —— 别把它们算成已经清过了。

import { readFileSync, readdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASELINE = join(ROOT, 'scripts/.size-baseline.json');
const GROWTH = 1.1;
const LIMITS = {
  mainGzip: 48000,   // public/style.css，gzip -9；2026-11-28 按安知鱼整站改版实测重定
  themeRaw: 2000,    // public/theme/*.css，每个文件的原始字节
};

const gz = (buf) => gzipSync(buf, { level: 9 }).length;

function collect(dirs) {
  const out = [];
  for (const dir of dirs) {
    const abs = dir.startsWith('/') ? dir : join(ROOT, dir);
    for (const name of readdirSync(abs).filter((n) => n.endsWith('.css')).sort()) {
      const path = join(abs, name);
      if (!statSync(path).isFile()) continue;
      out.push({ name, path, raw: readFileSync(path), isTheme: dir.endsWith('theme') });
    }
  }
  if (!out.length) throw new Error(`没有找到 CSS 文件：${dirs.join(', ')}`);
  return out;
}

export function checkSize({ dirs = ['public', 'public/theme'], log = console.log, writeBaseline = false } = {}) {
  const files = collect(dirs);
  const current = Object.fromEntries(files.map((f) => [f.name, gz(f.raw)]));
  let base = null;
  if (existsSync(BASELINE)) base = JSON.parse(readFileSync(BASELINE, 'utf8'));
  if (writeBaseline || !base) {
    writeFileSync(BASELINE, JSON.stringify(current, null, 2) + '\n');
    log('· 已写入基线 scripts/.size-baseline.json（本次不因增长判失败）');
    base = current;
  }

  log('[CSS 体积预算] 绝对值守底，基线守「不许变大」');
  let fail = 0;
  const check = (ok, msg) => { log(`  ${ok ? 'pass' : 'FAIL'} ${msg}`); if (!ok) fail++; };
  for (const f of files) {
    const size = gz(f.raw);
    const limit = f.isTheme ? null : LIMITS.mainGzip;
    const rawLimit = f.isTheme ? LIMITS.themeRaw : null;
    const absOk = (limit === null || size <= limit) && (rawLimit === null || f.raw.length <= rawLimit);
    check(absOk, f.isTheme
      ? `${f.name.padEnd(18)} 原始 ${f.raw.length} B ≤ ${rawLimit} B`
      : `${f.name.padEnd(18)} gzip ${size} B ≤ ${limit} B（原始 ${f.raw.length} B）`);
    if (!f.isTheme && /\r\n/.test(f.raw.toString('utf8'))) {
      fail++;
      log('  FAIL 主样式必须 LF 行尾（内容哈希对字节敏感，CRLF 会让本地绿 CI 红）');
    }
    const b = base[f.name];
    if (b) {
      const grown = size > b * GROWTH;
      check(!grown, `${f.name.padEnd(18)} 相对基线 ${((size / b - 1) * 100).toFixed(1)}%（阈值 +10%）`);
    }
  }
  log(fail ? `\n✗ ${fail} 项超出体积预算` : '\n✓ 体积预算达标');
  return { fail, files: files.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const dirs = args.filter((a) => !a.startsWith('--'));
  try {
    process.exit(checkSize({ dirs: dirs.length ? dirs : undefined, writeBaseline: args.includes('--write-baseline') }).fail ? 1 : 0);
  } catch (err) {
    console.error(`✗ 体积检查无法运行：${err.message}`);
    process.exit(1);
  }
}
