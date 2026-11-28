/* 自动生成，不要手改。改完 public 里的 js/css 跑一次：
 *   npm run build:sri
 * 测试里有一条会校验这份表与磁盘文件是否同步，忘了跑会被发版闸门拦下。 */
export const ASSET_HASH = {
  'app.js': { v: 'd9d0ed022d', i: 'sha384-F4qgRbnDE85pKFAhSRRhfitUpwou0mvBEnN1vVaURdiGGMRjQn95Et7e1phO4P9p' },
  'avatar.js': { v: '6945d59a78', i: 'sha384-30Q/I2a0FinO61Vm7okClafFryh+6EhWthjZ+F8ZJYK7AVwo6w1ypU59jsI2cM0k' },
  'boot.js': { v: '01956cba31', i: 'sha384-HBkR6v0RAqcZuzTEUq/AclQFoVoal510gO9NSk+rapSaAWZ+ZlxtycWK44pU8B7v' },
  'copy-notice.js': { v: '37005dfb02', i: 'sha384-06Z7i5AdTVLQWI4ZBpM38rD7urKygjw0ubrO4MHxvqcxw6uAe/Xy6MVyApYMrs4j' },
  'cover.js': { v: 'df82152a9d', i: 'sha384-A3lOG3f+LLp59TfT44W10oVZGE+h+s9Yl5/xBZhE80fk8zuyMXhMOcpF+aMGpe8u' },
  'md.js': { v: '092666ed13', i: 'sha384-SmrOod4zV8EQrLRzEbhQKez9axG19fmHK0uVCP7NaDbssUvRYGpYtKgEkRYxyvkv' },
  'style.css': { v: '15412b8839', i: 'sha384-TQKllpkpQ8ZmQd4B3u1ON49PY9zTohhXW4M8QtNa51baNAEbyiC+DV+h1zz4B66Y' },
  'theme.js': { v: 'b24b1a75ed', i: 'sha384-pgmU0hYbYxCZqlKp/bo1SamfMf/J7v5qSyFV2ZG3gVHfkH+4HmqaiDSm4HZMfaAd' },
  'theme/edge.css': { v: '18f0168a05', i: 'sha384-IJ9batbCjnWqKiATkQs5U0uh3cZovNgRLCapKmB8s7uxs3BVbkcKiFkSCHO2NVyn' },
  'theme/forest.css': { v: 'eab1d253af', i: 'sha384-YMY12usuy6CTrV+ZqS99Pymn97IKzALhSGQ4iV3jhffMG/VVRNiYr1j+wI02gaZp' },
  'theme/ink.css': { v: 'fa93572a62', i: 'sha384-deRpxbfDXLL/CaeEGMh45bJIVuIx4vhVUclU35B9RGQMPEJ+JH/SIM1x+MpCKr8L' },
  'theme/mono.css': { v: 'dddadb023e', i: 'sha384-GeZM2ueLgr4dgmhnC+QOWHwLk+SWsLkIZ5HlXJZRXBJK1Vy6KYvSHe+a/hFf28h/' },
  'theme/ocean.css': { v: '029f67509d', i: 'sha384-zgBMKITB6yi1UI4ZnPkm3azxTYwLmDhPZlWSOUfKlb/2dZ/d88q9Fs9o6r5Mh0x+' },
  'theme/plum.css': { v: '7993bfaaf8', i: 'sha384-Or+Ph3kepaw2/XwaqhrSQ7QRIOnp1fRtccmbTS1lPU9dvQxg0ZqQUuse/Dm5R12l' },
  'vendor/mermaid.min.js': { v: '07e37dfa97', i: 'sha384-o+g/BxPwhi0C3RK7oQBxQuNimeafQ3GE/ST4iT2BxVI4Wzt60SH4pq9iXVYujjaS' },
};

/* 各主题的 --bg，给 theme-color 与 PWA manifest 用（[P-055]）。
   构建期从 CSS 读出来，所以「改了主题底色但忘了改常量」这种漏法不存在了。 */
export const THEME_BG = {
  'edge': '#ffffff',
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
  'forest': '#0e1411',
  'ink': '#0e0e10',
  'mono': '#0b0b0c',
  'ocean': '#0a1017',
  'plum': '#130f16',
  'paper': '#14161d',
};
