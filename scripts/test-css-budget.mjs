// CSS 体积预算入口（npm test 用）。实现统一在 scripts/check-size.mjs，
// 避免预算数字 / 基线逻辑出现两份定义。CI 另有 check:size 直接调后者。
import { checkSize } from './check-size.mjs';

const { fail } = checkSize();
if (fail) process.exit(1);
