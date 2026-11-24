// 主题防闪引导：全站唯一的一份实现。
//
// 这段脚本以前有 10 份手抄副本 —— 8 个静态 HTML、后台统计/健康/队列三页、
// 404 页、系列页各一份。只有 SSR 首页与文章页那份带 window.__ASSET_H__，
// 其余 9 份在运行时切主题时发出的 /theme/x.css 既没有内容哈希 ?v=、
// 也没有 integrity：同一个文件，直出时有校验，切过去时没有；缓存头也从
// 「一年不可变」退到「5 分钟」。加一条规则要改 10 处，改漏一处就是这种症状。
//
// 现在只剩这一份。静态页用 <!--THEMEBOOT--> 占位，由 injectTheme 在出口替换；
// 服务端页直接 themeBootTag()。加任何 boot 级特性（?theme= 预览就是）只改这里。
import { ASSET_HASH } from './assets.gen.js';

/* 运行时切主题是脚本自己 createElement / 改 href，拿不到服务端戳的版本号，
   所以清单得跟着脚本一起下发。只带主题 CSS 与按需注入的 mermaid ——
   表约 6 条 × 100 字节，比多一次请求划算。 */
const assets = {};
for (const [f, h] of Object.entries(ASSET_HASH)) {
  if (f.startsWith('theme/') || f === 'vendor/mermaid.min.js') assets['/' + f] = { v: h.v, i: h.i };
}

/** 序列化后的资源清单，供 themeBootTag() 内联。`<` 转义防提前闭合 script。 */
export const THEME_ASSETS = JSON.stringify(assets).replace(/</g, '\\u003c');

/* 主题要不要额外发一个请求，**由清单回答**，不由主题名判断：
   清单里有 /theme/<id>.css 就有独立文件，没有就说明变量编在主样式表里
   （纸韵与安知鱼）。以前这里是 `t==='paper'||t==='anzhiyu'` 的一串硬编码，
   加第 8 套主题时必漏，漏了就是一次 404 请求 + 一套没生效的配色。

   ?theme=<id> 是临时预览：只影响当前这一页，不写 localStorage、不写 cookie、
   不进站点设置。白名单限定纯字母数字 2–16 位 —— 这个值会被拼进 href，
   放行 `/` 与 `.` 等于开了 ../ 的口子。未知 id 在清单里查不到，自然退回主表配色。 */
export const THEME_BOOT =
  '(function(){var d=document.documentElement;' +
  "var pv='';try{pv=(new URLSearchParams(location.search)).get('theme')||''}catch(e){}" +
  "if(!/^[a-z0-9]{2,16}$/.test(pv))pv='';" +
  'var t=null,m=null;try{t=localStorage.getItem(\'x_theme\');m=localStorage.getItem(\'x_mode\')}catch(e){}' +
  'var g=window.__THEME_DEFAULT__||{};t=pv||t||g.theme||\'paper\';m=m||g.mode||\'auto\';' +
  'var s=window.matchMedia&&matchMedia(\'(prefers-color-scheme: dark)\').matches;' +
  'var dark=(m===\'dark\')||(m!==\'light\'&&s);' +
  "d.setAttribute('data-theme',t);d.setAttribute('data-mode',dark?'dark':'light');d.setAttribute('data-mpref',m);" +
  "(function(){var L=document.getElementById('tcss-default'),H=window.__ASSET_H__||{};" +
  "var a=H['/theme/'+t+'.css'];" +
  /* 没文件：变量在主表里，把 head 里那条 default 链接摘掉即可（切回纸韵同理） */
  'if(!a){if(L)document.head.removeChild(L);return}' +
  "var h='/theme/'+t+'.css'+(a.v?'?v='+a.v:'');" +
  'if(L){if(L.getAttribute(\'href\')===h)return;document.head.removeChild(L)}' +
  "if(document.getElementById('tcss-'+t))return;" +
  "var S=document.createElement('link');S.id='tcss-'+t;S.rel='stylesheet';" +
  'if(a.i)S.integrity=a.i;S.href=h;document.head.appendChild(S)})()})();';

/**
 * 一段可直接塞进 <head> 的引导脚本。
 * defaults 给了就注入 window.__THEME_DEFAULT__（站点默认主题/外观）；
 * 静态页不给 —— 那边的默认值由 <!--THEME--> 占位先注入，这里只补资源清单。
 */
export function themeBootTag(defaults) {
  const pre = defaults
    ? `window.__THEME_DEFAULT__=${JSON.stringify(defaults).replace(/</g, '\\u003c')};`
    : '';
  return `<script>${pre}window.__ASSET_H__=${THEME_ASSETS};${THEME_BOOT}</script>`;
}
