// 主题契约：**这套东西的定义只在这里**。
//
// 一份主题 = 一个 public/theme/<id>.css，里面只许写契约里的变量名。这条线划在哪，
// 决定「换皮」和「改站」的分界：
//
//   契约管（进、出两个方向）
//     · 进：Worker 往 HTML 里注入什么 —— <!--THEME--> 落 __THEME_DEFAULT__ 与默认
//           样式表，<!--THEMEBOOT--> 落引导脚本，data-theme / data-mode 在字节流里定值
//     · 出：CSS 暴露哪些变量名 —— 就是下面这 23 个，主题文件只许覆盖它们
//
//   契约不管（碰了就从换皮变成改站）
//     · 渲染器 public/md.js —— 抠码 / 转义 / 拼装的顺序
//     · 权限与审核 —— liveSql()、review_status、ownerOrAdmin()
//     · 响应头与 CSP —— 主题不许靠内联 <style> 绕过 nonce
//
// 为什么要有这个文件：清单原本抄了四份（settings.js 的 THEME_IDS、theme.js 的
// 面板数组、index.js 的 THEME_COLOR、build-sri 的目录扫描），加第 8 套时改了
// 三处、漏了一处，症状是「后台选了新主题，前台还是旧的」而测试全绿。现在
// THEME_IDS 与 THEME_COLOR 都由资源清单派生，手写的只剩面板那一份文案。

/** 语义色：每套主题必须给全。缺一个不会报错，会静默继承上一套的颜色 —— 最难查。 */
export const CONTRACT_CORE = [
  '--bg',
  '--bg-soft',
  '--card',
  '--fg',
  '--fg-soft',
  '--muted',
  '--line',
  '--accent',
  '--accent-soft',
];

/** 可选槽位：给了就用，不给就继承主表。字体与语法高亮属于「主题可以有自己的口味」。 */
export const CONTRACT_OPTIONAL = [
  '--green',
  '--red',
  '--radius',
  '--shadow',
  '--tok-k',
  '--tok-s',
  '--tok-n',
  '--tok-f',
  '--hero-weight',
  '--hero-space',
  '--mono',
  '--sans',
  '--serif',
  /* 只做填充、不做文字：锚橙在纯白上 2.58:1，当 --accent 会过不了 AA（P-054）。 */
  '--brand',
  /* 铺在 --brand 底上的文字色。白字在锚橙上 2.58:1，所以深色态也不能用 --fg 顶。
     单列一个槽位，是为了「换品牌色」时按钮里的字跟着换，而不是写死一个墨蓝。 */
  '--on-brand',
];

/** 契约全集。主题文件里出现清单外的 --x 就是开了后门（[TC-24]）。 */
export const CONTRACT_VARS = new Set([...CONTRACT_CORE, ...CONTRACT_OPTIONAL]);

/** 变量在主题文件里能写什么：算式允许（--serif: var(--sans)），字面色值也行。 */
export const CONTRACT_DECLS = new Set([...CONTRACT_VARS, 'color-scheme']);

/** 没有独立 CSS 文件的主题：变量与骨架都编在主样式表里。 */
export const INLINE_THEMES = ['paper', 'anzhiyu'];

/** 主题 id 的合法形态。这个值会拼进 /theme/<id>.css 的 href，也是 ?theme= 的白名单。 */
export const THEME_ID_RE = /^[a-z0-9]{2,16}$/;

/**
 * 从资源清单派生主题 id 列表 —— 加一套主题**不需要**改这里。
 * 顺序没有语义（只用于合法性校验与遍历），面板的展示顺序另算：
 * 中文名与一句描述没法从文件名推出来，那份文案必须手写。
 *
 * @param {Record<string, {v: string, i: string}>} hash src/assets.gen.js 的 ASSET_HASH
 */
export function deriveThemeIds(hash) {
  const fromFiles = Object.keys(hash)
    .filter((f) => f.startsWith('theme/') && f.endsWith('.css'))
    .map((f) => f.slice('theme/'.length, -'.css'.length))
    .filter((id) => THEME_ID_RE.test(id))
    .sort();
  /* 内联主题排前面：纸韵是基准（裸 :root），安知鱼在它后面 —— 两个都在主表里，
     没有独立文件，所以不能靠扫描得到。 */
  return [...INLINE_THEMES, ...fromFiles];
}
