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

/**
 * 内部 token 前缀：`--_xxx` 是主题自己的私有变量，**不进契约、不跨文件**。
 *
 * 为什么要有这个口子：代码块想给 8 类语法角色配色（注释 / 关键字 / 字符串 / 函数 /
 * 类型 / 标签 / 数字 / 变量），契约只有 4 个 `--tok-*` 槽位。剩下的塞进契约，等于
 * 逼八套主题各给 8 个值 —— 那就不叫可选槽位了。放行的代价必须用两条护栏换：
 *   ① 定义与引用只在同一个主题文件里。主表 `style.css` 里出现 `var(--_x)` 就是
 *      全站依赖某套主题的私有变量，换主题整块塌 —— 这跟禁用 --my-shadow 是同一件事。
 *   ② 主表不许定义 `--_x`：结构层持有私有 token，等于留了个把手。
 * 两条都由 TC-24 守着。
 */
export const INTERNAL_PREFIX = '--_';

/**
 * 语法高亮里**没有独立槽位**、借用其他契约变量兜底的那几类。
 *
 * `highlight()` 产出 5 类（k 关键字 / s 字符串 / n 数字 / f 函数 / c 注释），契约只有
 * 4 个 `--tok-*`。第 5 类注释色借用 `--muted`（`style.css:636`）。这个借用本身合理 ——
 * 给注释单开一个槽位，等于逼八套主题各多写一个值，而注释色和「辅助文字」本来就该同色。
 *
 * 但「合理」不等于「不用记」。没有这张表时，规则是「结构层就近找一个变量填上」：
 * 这次找到 `--muted` 恰好对，下次新增第 6 类同样就近找，而没人会去审 ——
 * 它还能同时穿过 TC-37（类别在表里）、P-043（`--muted` 是契约变量）、P-046（不碰主色）三道闸。
 *
 * 因此这张表要求三件事，由 TC-41 守：
 *   ① 键必须是渲染器真的产出的类别（不许开空头）
 *   ② 值必须是契约变量（不许指向不存在的东西）
 *   ③ `style.css` 里该类的 `color` 必须**正是**这个变量（表与代码不许各说一套）
 * 新增第 6 类时要么加 `--tok-x` 槽位，要么在这里登记一行 —— 登记这个动作就是一次 review。
 *
 * `sites` 是第四件事，由 TC-44 守：借用的变量在 `style.css` 里有多少个消费点。
 * 为什么只记数字不记选择器清单 —— `--muted` 今天有 153 处（158 个选择器，color 143 /
 * border-color 5 / background 4 / scrollbar 1）。登记 158 个名字等于每写一行业务 CSS
 * 都要动这份契约，清单没人读、也没人 review；而数字一变就必须来改这里，成本一行，
 * 且报错里会带上按属性的分布，能一眼看出「又在拿辅助文字色当背景」。
 */
export const TOK_EXCEPTION = Object.freeze({
  c: {
    var: '--muted',
    /* style.css 里**含** `var(--muted)` 的声明条数。同一条声明写两次算一点 ——
       影响面的单位是「多少个地方依赖这个值」，一条声明是一个视觉决策。
       加一处就改成 149 —— 那一下就是签字：「我确认把注释色的影响面又扩大了一格」。
       2026-11-26 从 153 降到 151：概览的入口墙拆了（`.dash-tile-d` / `.dash-tile-arrow`
       两条用 --muted 的规则随之删除），影响面是缩小，不是扩大。
       同日从 151 再降到 148：安知鱼整块下架（45 条规则里的 3 处 color: var(--muted)
       随之消失），卡片 hover 的 border-color 也改用 --fg 派生 —— 拿辅助文字色当边框
       本来就是语义错位。
       2026-11-28 回到 154：整站换成安知鱼风，新增 6 处全是文字色（卡片标签、
       侧栏日期、精选说明），没有一处拿它当底色或边框。 */
    sites: 154,
  },
});

/** 没有独立 CSS 文件的主题：变量与骨架都编在主样式表里。
    只剩纸韵一套 —— 它是裸 `:root`，同时是脚本没跑起来时的兜底色。
    安知鱼（anzhiyu）已下架：它的 45 条规则原本独占主表 400 行，
    默认主题一换成纸韵，这些规则就成了每个读者都要下载、却没人命中的字节。 */
export const INLINE_THEMES = ['paper'];

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
  /* 内联主题排前面：纸韵是基准（裸 :root），在主表里，没有独立文件，所以不能靠扫描得到。 */
  return [...INLINE_THEMES, ...fromFiles];
}
