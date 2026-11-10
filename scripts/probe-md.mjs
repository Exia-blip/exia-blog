// 绕过探针：对线上渲染器（public/md.js）逐条跑真实输入，打印原样输出。
// 用法：node scripts/probe-md.mjs
// 目的：文章里贴的输出必须是这里跑出来的，不是手写的"应该会"。
import { renderBody } from '../public/md.js';

const probes = [
  ['段落里的裸标签', '正文 **粗** 和 `code`，还有 <img src=x onerror=alert(1)>。'],
  ['标题里的裸标签', '# <img src=x onerror=alert(4)>标题'],
  ['行内码里的脚本', '行内 `` `<script>alert(5)</script>` `` 结束'],
  ['围栏里的脚本', '```html\n<script>alert(6)</script>\n```'],
  ['javascript: 链接', '[z](javascript:alert(1))'],
  ['大小写混写', '[v](JaVaScRiPt:alert(3))'],
  ['前导空格伪装', '[k]( javascript:alert(1))'],
  ['前导 Tab 伪装', '[k](\tjavascript:alert(1))'],
  ['data:text/html 链接', '[d](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'],
  ['data:image 当链接', '[s](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)\n'],
  ['alt 属性闭合尝试', '![" onmouseover="alert(1)](http://a.b/c.png)'],
  ['href 属性闭合尝试', '[t](https://a.b/c"onclick="alert(1))'],
  ['协议相对地址', '[b](//evil.example/x)'],
  ['mailto', '[m](mailto:a@b.c)'],
  ['表格单元格注入', '| a | b |\n|---|---|\n| <img src=x onerror=7> | ok |'],
  ['占位符伪造', '正文 \\u0000CB0\\u0000 结束'],
  ['嵌套列表', '- 一级\n  - 二级\n- 同级'],
  ['带括号 URL', '见 [维基](https://en.wikipedia.org/wiki/OAuth_(disambiguation)) 段落'],
  ['title 语法', '[x](/a.png "标题")'],
  ['正文里写 #tag', '结尾 #cloudflare 一个标签'],
  ['引用里的脚本', '> <script>alert(8)</script>'],
  ['同名标题的锚点', '# 标题A\n\n# 标题A'],
  ['表格左对齐语法', '| a | b |\n|:--|--:|\n| 1 | 2 |'],
  ['未闭合的围栏', '前面\n\n```js\nconst a = 1;\n\n后面还有正文'],
  ['裸链接带句号', '看 https://example.com/a. 结束'],
  ['三层嵌套列表', '- 一\n  - 二\n    - 三'],
  ['NUL 占位符伪造', '```js\nconst a=1;\n```\n\n\u0000CB0\u0000'],
];

for (const [name, md] of probes) {
  console.log(`── ${name}`);
  console.log(`入 ${JSON.stringify(md)}`);
  console.log(`出 ${renderBody(md)}`);
  console.log('');
}
