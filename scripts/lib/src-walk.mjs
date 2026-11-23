/**
 * src 源文件的递归枚举（[P-032] / [P-034]）。
 *
 * 为什么单独抽出来：AP-15 / AP-16 / RB-03 / schema 列扫描四处都是
 * `readdirSync(srcDir).filter(f => f.endsWith('.js'))` —— 只读一层。
 * src 一旦按 features/ 切成垂直切片（src/features/post/controller.js），
 * 这四处会**一起变成「扫不到 = 没有违规」**：断言全绿，裸权限判定躺在子目录里。
 * 2026-11-23 用 `src/_probe/evil.js` 实测过，旧写法 17/17 通过。
 *
 * 判据从「有没有违规」换成「扫描范围和目录结构是否一致」，
 * 才是这一类失明的正解：目录可以长，断言的眼界必须跟着长。
 *
 * ---- 第二阶段（P-034）：递归修好之后，出现的是反向故障 ----
 * 把测试目录放进 src/ 下（`src/__tests__/auth.spec.js`），
 * AP-15 会把测试文件里的 `user.id === post.author_id || user.is_admin`
 * 判成一处在线的越权 —— 假红。假红的终点是「给断言加个豁免」，
 * 豁免加多了等于关掉断言，比失明更隐蔽：失明时人还会怀疑，假红时人只会想关它。
 *
 * 所以扫描范围要显式分成「产品源码」与「非产品源码」，而不是靠后缀区分。
 * 分家的代价是可能有人把产品代码塞进 `__tests__/` 躲扫描，
 * 因此另配 `nonProductLeaks()`：产品文件一旦 import 非产品目录里的东西就报错 ——
 * 这条才是真正堵漏的判据，光排除是不够的。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 默认排除：构建产物，不是手写源码，扫它会把生成的常量当成代码。 */
const DEFAULT_SKIP = new Set(['assets.gen.js']);

/**
 * 非产品源码目录。测试、夹具、mock 里的字符串是**判据本身**，
 * 不是被执行的产品代码；把它们纳入「找违规」的范围，
 * 报出来的每一处都是假的。
 */
export const NON_PRODUCT_DIRS = new Set(['__tests__', '__mocks__', '__fixtures__', 'test', 'tests']);

/** rel 是否落在非产品目录下（只看目录段，不看文件名）。 */
export function isNonProduct(rel) {
  const segs = String(rel).split('/');
  segs.pop(); // 文件名本身不参与判断
  return segs.some((s) => NON_PRODUCT_DIRS.has(s));
}

/**
 * 列出 src 下的 .js，返回相对 src 的 posix 路径（子目录写成 `features/x/y.js`）。
 * 排序保证输出稳定，断言失败时 diff 才可读。
 *
 * skipNonProduct 默认为 true：调用方要的是「产品代码里有没有违规」。
 * 需要看全量（比如统计文件数）时显式传 false。
 */
export function srcFiles(root, { skip = DEFAULT_SKIP, skipNonProduct = true } = {}) {
  const srcDir = path.join(root, 'src');
  const out = [];
  const walk = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(path.join(dir, e.name), rel);
      } else if (e.name.endsWith('.js') && !skip.has(rel)) {
        if (skipNonProduct && isNonProduct(rel)) continue;
        out.push(rel);
      }
    }
  };
  walk(srcDir, '');
  return out.sort();
}

/** 同上，但连文本一起读出来，报错时能直接指到子目录里的行号。 */
export function srcEntries(root, opts) {
  const srcDir = path.join(root, 'src');
  return srcFiles(root, opts).map((rel) => ({
    rel,
    text: fs.readFileSync(path.join(srcDir, rel), 'utf8'),
  }));
}

/**
 * 独立于 srcFiles 的第二实现：用原生 recursive 读一遍。
 * 断言里拿它跟 srcFiles 比对，防止 walk 自己写错目录（自证不算证明）。
 *
 * 这里的排除逻辑**故意重写一遍**而不是调 isNonProduct：
 * 两套实现共用同一个判据函数时，判据写错了两边一起错，互校就失去意义。
 */
export function nativeSrcFiles(root, { skip = DEFAULT_SKIP, skipNonProduct = true } = {}) {
  const srcDir = path.join(root, 'src');
  return fs
    .readdirSync(srcDir, { recursive: true })
    .map((x) => String(x).split(path.sep).join('/'))
    .filter((x) => x.endsWith('.js') && !skip.has(x))
    .filter((x) => {
      if (!skipNonProduct) return true;
      const dirs = x.split('/');
      dirs.pop();
      for (const d of dirs) if (NON_PRODUCT_DIRS.has(d)) return false;
      return true;
    })
    .sort();
}

/** 抓 `from '...'` / `import('...')` / `require('...')` 三种取路径写法。 */
const IMPORT_RE = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

/**
 * 产品代码是否伸进了非产品目录。
 *
 * 这是「排除测试目录」的必要配套：排除让断言不再误报，
 * 但也让 `__tests__/` 变成一个扫描盲区。只要产品文件 import 了它，
 * 盲区里的代码就在线上跑 —— 这时报错才是对的，而且必须报在 import 那一行。
 *
 * 只解析相对路径与 `/src/` 绝对写法；裸模块名（`node:fs`）与 http 链接不算。
 */
export function nonProductLeaks(root) {
  const srcDir = path.join(root, 'src');
  const hits = [];
  for (const rel of srcFiles(root)) {
    const abs = path.join(srcDir, rel);
    const text = fs.readFileSync(abs, 'utf8');
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1];
      if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
      /* 相对路径以当前文件目录为基准；以 / 开头的按 src 根算，够覆盖本站写法。 */
      const target = spec.startsWith('/')
        ? path.relative(srcDir, path.join(srcDir, spec))
        : path.relative(srcDir, path.resolve(path.dirname(abs), spec));
      const posix = target.split(path.sep).join('/');
      if (isNonProduct(posix) || posix.split('/').some((s, i, a) => i < a.length - 1 && NON_PRODUCT_DIRS.has(s))) {
        const line = text.slice(0, m.index).split('\n').length;
        hits.push(`${rel}:${line}  import '${spec}'`);
      }
    }
  }
  return hits;
}
