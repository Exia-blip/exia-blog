// 断言输出统一格式：pass/FAIL + 可选 P-NNN 编号，无依赖。
// 编号对应 PITFALLS.md 的条目；失败时按编号直接跳回文章，不用翻代码。
// 不带编号的断言传空串即可，输出保持原样。
export function report(id, name, cond, detail = '') {
  const tag = id ? `[${id}] ` : '';
  console.log(`${cond ? 'pass' : 'FAIL'}  ${tag}${String(name).padEnd(24)} ${detail}`);
  return !!cond;
}
