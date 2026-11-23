/**
 * src 源文件的递归枚举（[P-032]）。
 *
 * 为什么单独抽出来：AP-15 / AP-16 / RB-03 / schema 列扫描四处都是
 * `readdirSync(srcDir).filter(f => f.endsWith('.js'))` —— 只读一层。
 * src 一旦按 features/ 切成垂直切片（src/features/post/controller.js），
 * 这四处会**一起变成「扫不到 = 没有违规」**：断言全绿，裸权限判定躺在子目录里。
 * 2026-11-23 用 `src/_probe/evil.js` 实测过，旧写法 17/17 通过。
 *
 * 判据从「有没有违规」换成「扫描范围和目录结构是否一致」，
 * 才是这一类失明的正解：目录可以长，断言的眼界必须跟着长。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 默认排除：构建产物，不是手写源码，扫它会把生成的常量当成代码。 */
const DEFAULT_SKIP = new Set(['assets.gen.js']);

/**
 * 列出 src 下全部 .js，返回相对 src 的 posix 路径（子目录写成 `features/x/y.js`）。
 * 排序保证输出稳定，断言失败时 diff 才可读。
 */
export function srcFiles(root, { skip = DEFAULT_SKIP } = {}) {
  const srcDir = path.join(root, 'src');
  const out = [];
  const walk = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(path.join(dir, e.name), rel);
      } else if (e.name.endsWith('.js') && !skip.has(rel)) {
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
 */
export function nativeSrcFiles(root, { skip = DEFAULT_SKIP } = {}) {
  const srcDir = path.join(root, 'src');
  return fs
    .readdirSync(srcDir, { recursive: true })
    .map((x) => String(x).split(path.sep).join('/'))
    .filter((x) => x.endsWith('.js') && !skip.has(x))
    .sort();
}
