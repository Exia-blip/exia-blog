// 跨平台找 Chrome：CI（ubuntu）与本地（Windows）共用。
// 优先级：CHROME_PATH 环境变量 > 各平台常见安装路径。
// 用法：import { resolveChrome } from './chrome.mjs'; const CHROME = resolveChrome();
import { existsSync } from 'node:fs';

const CANDIDATES = process.platform === 'win32'
  ? [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe` : '',
    ]
  : [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ];

// 无头 Chrome 的统一启动参数。
//
// --disable-dev-shm-usage 不是可有可无的优化：GitHub 的 ubuntu runner 里 /dev/shm 只有
// 64MB，Chrome 用它放共享内存，页面一大（首页 10 张卡 + 侧栏 + 横幅）就写满、渲染进程
// 直接死掉，而 launcher 那侧看到的只是「30 秒内没等到 DevTools 的 WS 地址」：
//   TimeoutError: Timed out after 30000 ms while waiting for the WS endpoint URL to appear
// 2026-11-28 就吃过一次，日志里那句 TimeoutError 跟断言失败混在同一个 job 里，
// 很容易被当成「浏览器断言挂了」去查页面。加这个参数后它改写到 /tmp，不再撞 64MB。
export const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run',
];

export function resolveChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const hit = CANDIDATES.filter(Boolean).find((p) => existsSync(p));
  if (!hit) {
    console.error(
      `找不到 Chrome。装一个，或设 CHROME_PATH 指到可执行文件。已试过：\n  ${CANDIDATES.filter(Boolean).join('\n  ')}`
    );
    process.exit(1);
  }
  return hit;
}
