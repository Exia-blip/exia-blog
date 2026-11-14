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
