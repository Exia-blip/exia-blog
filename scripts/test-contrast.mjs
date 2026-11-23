// 对比度断言入口（npm test 用）。实现统一在 scripts/check-contrast.mjs，
// 避免 PAIRS / WCAG 算法出现两份定义后悄悄漂移。CI 另有 check:a11y 直接调后者。
import { checkContrast } from './check-contrast.mjs';

const { fail } = checkContrast();
if (fail) process.exit(1);
