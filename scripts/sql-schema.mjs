/**
 * 极简 SQL DDL 解析：够用来回答「这份 DDL 建出哪些表、每张表哪些列、有哪些索引」。
 *
 * 不做完整语法分析 —— DDL 是我们自己写的，格式可控。解析不了的地方一律抛错，
 * 不要「猜一个大概」，否则 schema 检查会在错误的前提下给出 ok。
 *
 * schema.mjs（与线上库比对）和 test-schema.mjs（离线断言）共用这一份，
 * 免得两个检查器对同一份 SQL 得出两种解读。
 */

export function stripComments(src) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === "'") {
        if (src[i + 1] === "'") { out += "'"; i++; } else inStr = false;
      }
      continue;
    }
    if (c === "'") { inStr = true; out += c; continue; }
    if (c === '-' && src[i + 1] === '-') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    out += c;
  }
  return out;
}

/** 按顶层分号切语句（字符串内的分号不算） */
export function splitStatements(src) {
  const out = [];
  let buf = '';
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      buf += c;
      if (c === "'") {
        if (src[i + 1] === "'") { buf += "'"; i++; } else inStr = false;
      }
      continue;
    }
    if (c === "'") { inStr = true; buf += c; continue; }
    if (c === ';') { out.push(buf); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** 按顶层逗号切（DEFAULT (datetime('now')) 里的逗号和括号不能切开） */
export function splitTopLevel(body) {
  const out = [];
  let buf = '';
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      buf += c;
      if (c === "'") {
        if (body[i + 1] === "'") { buf += "'"; i++; } else inStr = false;
      }
      continue;
    }
    if (c === "'") { inStr = true; buf += c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

const TABLE_CONSTRAINT = /^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i;

/**
 * @returns {{ tables: Map<string, Set<string>>, indexes: Set<string> }}
 * 同一份文件里重复 CREATE 同名表时列取并集（正常不会出现，出现就是写重了）。
 */
export function parseSchema(text, label = '') {
  const tables = new Map();
  const indexes = new Set();

  for (const stmt of splitStatements(stripComments(text))) {
    let m = stmt.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?(\w+)[`"\]]?\s*\(/i);
    if (m) {
      const name = m[1];
      const open = stmt.indexOf('(');
      let depth = 0;
      let close = -1;
      let inStr = false;
      for (let i = open; i < stmt.length; i++) {
        const c = stmt[i];
        if (inStr) {
          if (c === "'") {
            if (stmt[i + 1] === "'") i++; else inStr = false;
          }
          continue;
        }
        if (c === "'") { inStr = true; continue; }
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) { close = i; break; } }
      }
      if (close < 0) throw new Error(`${label} 表 ${name} 的括号没配平`);
      const cols = tables.get(name) || new Set();
      for (const seg of splitTopLevel(stmt.slice(open + 1, close))) {
        if (TABLE_CONSTRAINT.test(seg)) continue;
        const cm = seg.match(/^[`"[]?(\w+)[`"\]]?/);
        if (cm) cols.add(cm[1]);
        else throw new Error(`${label} 表 ${name} 有一段解析不出列名：${seg.slice(0, 40)}`);
      }
      tables.set(name, cols);
      continue;
    }

    m = stmt.match(/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?(\w+)/i);
    if (m) { indexes.add(m[1]); continue; }

    m = stmt.match(/^ALTER\s+TABLE\s+[`"[]?(\w+)[`"\]]?\s+ADD\s+(?:COLUMN\s+)?[`"[]?(\w+)/i);
    if (m) {
      const cols = tables.get(m[1]) || new Set();
      cols.add(m[2]);
      tables.set(m[1], cols);
    }
  }

  return { tables, indexes };
}

/** 把多份 DDL 按顺序合并成一份期望结构（后出现的是增量） */
export function mergeSchema(parts) {
  const tables = new Map();
  const indexes = new Set();
  for (const one of parts) {
    for (const [t, cols] of one.tables) {
      const prev = tables.get(t) || new Set();
      for (const c of cols) prev.add(c);
      tables.set(t, prev);
    }
    for (const i of one.indexes) indexes.add(i);
  }
  return { tables, indexes };
}
