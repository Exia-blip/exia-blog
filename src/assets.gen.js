/* 自动生成，不要手改。改完 public 里的 js/css 跑一次：
 *   npm run build:sri
 * 测试里有一条会校验这份表与磁盘文件是否同步，忘了跑会被发版闸门拦下。 */
export const ASSET_HASH = {
  'app.js': { v: '0b412ac5a9', i: 'sha384-zVVeqk8rrgBNO5kR9C3+gLH5dwP1BDMhQTjVdM74RsswxNsUtrwR9ZLDpTra2xnB' },
  'avatar.js': { v: '13fb3a7d52', i: 'sha384-rXytu9LqUdAgLzs0wUtX3S00WHDVx4x6bQcHWKiyJ9LH1RAi4y9Eg55+Kl/yfQxE' },
  'boot.js': { v: '01956cba31', i: 'sha384-HBkR6v0RAqcZuzTEUq/AclQFoVoal510gO9NSk+rapSaAWZ+ZlxtycWK44pU8B7v' },
  'copy-notice.js': { v: '37005dfb02', i: 'sha384-06Z7i5AdTVLQWI4ZBpM38rD7urKygjw0ubrO4MHxvqcxw6uAe/Xy6MVyApYMrs4j' },
  'cover.js': { v: 'df82152a9d', i: 'sha384-A3lOG3f+LLp59TfT44W10oVZGE+h+s9Yl5/xBZhE80fk8zuyMXhMOcpF+aMGpe8u' },
  'md.js': { v: '092666ed13', i: 'sha384-SmrOod4zV8EQrLRzEbhQKez9axG19fmHK0uVCP7NaDbssUvRYGpYtKgEkRYxyvkv' },
  'style.css': { v: '2e5c724e0f', i: 'sha384-W8KSxITXxpX2a0ozpnjVnptZzQ8Kzl9vbVhYTJxL4UhwQM/43bn7vosv77yIaOpB' },
  'theme.js': { v: '05d5468c5e', i: 'sha384-i7yKkhBDJCGmnI1H+tu6B/PnG3WlE3les9NOl8XF/lPK0VZoN5X5tyoAxmzYAu4E' },
  'theme/edge.css': { v: '0f04aad1e4', i: 'sha384-FeJ+OzTYSPGDZSGtWSlb+O2xkwdKgGwApw4/FRiICJ980b5XyOZyfnnvEzJipQ/b' },
  'theme/editorial.css': { v: 'c14c651c30', i: 'sha384-HKH+V55F+l+BTBPcWPDnjaXL5Qerae1S496ls3S4A5zAwkeZvWg6XEletesIxvVO' },
  'theme/forest.css': { v: '526a3a7cbd', i: 'sha384-3phRgsSP1Dyb0FiGTT7oYmJD7n2r7ByHjNXofZQ9PdkIbJuEx4kFskmEUnFg5dGw' },
  'theme/ink.css': { v: '0e13ebcb8e', i: 'sha384-ur9kSyMe9C3vS6P/mCPsctd3p1773w+ELlN8E+UTpjjBwHBp/tqfabCNrqoX2p3Z' },
  'theme/mono.css': { v: 'af10472b68', i: 'sha384-pE1LjhpZyI8hkDl6MvhPxY0Kh6fSS5S9QviyDcdYOKdC4+TJtbjAl44zRoXsv2+y' },
  'theme/ocean.css': { v: '042c451e74', i: 'sha384-dvzQ1WeQKGBwhNJRlAMsImW5lSaW992wMcLQqiZMyW3uzAseXKcAVjJDHD4XFfpU' },
  'theme/plum.css': { v: '881233518b', i: 'sha384-lVrpcj8+mLLOLN3RNwMl75Vzi3AayjWbE5k0yIugZA9rnrLS4vegditQ1vA+frs8' },
  'vendor/mermaid.min.js': { v: '07e37dfa97', i: 'sha384-o+g/BxPwhi0C3RK7oQBxQuNimeafQ3GE/ST4iT2BxVI4Wzt60SH4pq9iXVYujjaS' },
};

/* 各主题的 --bg，给 theme-color 与 PWA manifest 用（[P-055]）。
   构建期从 CSS 读出来，所以「改了主题底色但忘了改常量」这种漏法不存在了。 */
export const THEME_BG = {
  'edge': '#ffffff',
  'editorial': '#F6F3ED',
  'forest': '#f6f8f2',
  'ink': '#fdfcfa',
  'mono': '#f4f4f5',
  'ocean': '#f4f7fb',
  'plum': '#faf7fc',
  'paper': '#f7f9fe',
};

/* 各主题暗色模式的 --bg，给 SSR 首屏那条 media="(prefers-color-scheme: dark)" 用。
   同样从 CSS 派生：JS 未执行时就该有正确的顶栏色，不能等运行时再补。 */
export const THEME_BG_DARK = {
  'edge': '#0d1117',
  'editorial': '#111820',
  'forest': '#0e1411',
  'ink': '#0e0e10',
  'mono': '#0b0b0c',
  'ocean': '#0a1017',
  'plum': '#130f16',
  'paper': '#14161d',
};
