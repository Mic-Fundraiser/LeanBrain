// Pure text helpers (no tokenizer, no IO): symbol extraction, line counts, diffs and outlines.
// Kept light because the Claude Code guard hook imports them on every Read/Bash call.
import {clip} from './core.mjs';

export const LANG = {js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js', vue: 'js', svelte: 'js', astro: 'js',
  py: 'py', go: 'go', rs: 'rs', swift: 'swift', kt: 'kt', kts: 'kt', java: 'java', scala: 'java', cs: 'java', php: 'php', rb: 'rb',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', hpp: 'c', m: 'c', mm: 'c', sh: 'sh', bash: 'sh', zsh: 'sh', sql: 'sql', lua: 'lua', dart: 'dart',
  ex: 'ex', exs: 'ex', md: 'md', mdx: 'md'};
const ID = '[A-Za-z_$][\\w$]*';
const RX = {
  js: [
    [new RegExp(`^\\s*export\\s+default\\s+(?:async\\s+)?function\\s*\\*?\\s*(${ID})`), 'fn'],
    [new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${ID})\\s*[(<]`), 'fn'],
    [new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+(${ID})`), 'class'],
    [new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:interface|type|enum)\\s+(${ID})`), 'type'],
    [new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+(${ID})\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:\\([^)]*\\)|${ID})\\s*(?::[^=]+)?=>`), 'fn'],
    [new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+(${ID})\\s*=\\s*(?:async\\s+)?function`), 'fn'],
    [new RegExp(`^export\\s+(?:const|let|var)\\s+(${ID})`), 'const'],
    [new RegExp(`^\\s{2,4}(?:(?:static|async|get|set|public|private|protected|readonly|override)\\s+)*(${ID})\\s*\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\{\\s*$`), 'method'],
    [new RegExp(`^(?:module\\.)?exports\\.(${ID})\\s*=`), 'fn'],
  ],
  py: [[/^(?:async\s+)?def\s+([A-Za-z_]\w*)/, 'fn'], [/^class\s+([A-Za-z_]\w*)/, 'class'], [/^ {4}(?:async\s+)?def\s+([A-Za-z_]\w*)/, 'method'], [/^([A-Z][A-Z0-9_]{2,})\s*[:=]/, 'const'],
    [/^@(?:app|router|bp|blueprint)\.(?:route|get|post|put|delete|patch)\(\s*["']([^"']+)/, 'route']],
  go: [[/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, 'fn'], [/^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, 'type']],
  rs: [[/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/, 'fn'], [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type)\s+([A-Za-z_]\w*)/, 'type'], [/^impl(?:<[^>]*>)?\s+(?:[\w:]+(?:<[^>]*>)?\s+for\s+)?([A-Za-z_]\w*)/, 'impl']],
  swift: [[/^\s*(?:@\w+\s+)*(?:(?:public|private|internal|fileprivate|open|static|final|override|mutating|class|nonisolated)\s+)*func\s+([A-Za-z_]\w*)/, 'fn'], [/^\s*(?:@\w+\s+)*(?:(?:public|private|internal|fileprivate|open|final)\s+)*(?:class|struct|enum|protocol|extension|actor)\s+([A-Za-z_]\w*)/, 'type']],
  kt: [[/^\s*(?:(?:public|private|internal|protected|override|suspend|inline|open|abstract)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)/, 'fn'], [/^\s*(?:(?:public|private|internal|data|sealed|abstract|open|enum)\s+)*(?:class|interface|object)\s+([A-Za-z_]\w*)/, 'type']],
  java: [[/^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|partial)\s+)*(?:class|interface|enum|record|struct)\s+([A-Za-z_]\w*)/, 'type'], [/^\s+(?:(?:public|private|protected|internal|static|final|synchronized|abstract|override|virtual|async)\s+)+[\w<>\[\],.?\s]+\s+([A-Za-z_]\w*)\s*\(/, 'method']],
  php: [[/^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?([A-Za-z_]\w*)/, 'fn'], [/^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/, 'type']],
  rb: [[/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/, 'fn'], [/^\s*(?:class|module)\s+([A-Z]\w*)/, 'type']],
  c: [[/^(?:static\s+|inline\s+|extern\s+)*(?:const\s+)?[A-Za-z_][\w\s*]*?\b([A-Za-z_]\w*)\s*\([^;{]*\)\s*\{?\s*$/, 'fn'], [/^(?:typedef\s+)?(?:struct|class|enum)\s+([A-Za-z_]\w*)/, 'type'], [/^#define\s+([A-Za-z_]\w*)/, 'macro'], [/^[-+]\s*\([^)]*\)\s*([A-Za-z_]\w*)/, 'method']],
  sh: [[/^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{?/, 'fn'], [/^\s*function\s+([A-Za-z_][\w-]*)/, 'fn']],
  sql: [[/^\s*create\s+(?:or\s+replace\s+)?(?:table|view|function|procedure|index|trigger)\s+(?:if\s+not\s+exists\s+)?([\w."]+)/i, 'table']],
  lua: [[/^\s*(?:local\s+)?function\s+([\w.:]+)/, 'fn']],
  dart: [[/^\s*(?:abstract\s+)?class\s+([A-Za-z_]\w*)/, 'type'], [/^\s*(?:Future<[^>]*>|void|[\w<>?]+)\s+([a-z]\w*)\s*\([^)]*\)\s*(?:async\s*)?\{/, 'fn']],
  ex: [[/^\s*def(?:p|macro)?\s+([a-z_]\w*[?!]?)/, 'fn'], [/^\s*defmodule\s+([\w.]+)/, 'type']],
};
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'else', 'do', 'try', 'with', 'super', 'typeof', 'new', 'await', 'elif', 'def', 'sizeof']);

export function symbols(text, ext) {
  const lang = LANG[ext];
  if (!lang) return [];
  const out = [];
  const lines = text.split('\n');
  let fence = false;
  for (let i = 0; i < lines.length && out.length < 400; i++) {
    const line = lines[i];
    if (lang === 'md') {
      if (/^```/.test(line)) fence = !fence;
      const h = !fence && line.match(/^(#{1,3})\s+(.+)/);
      if (h) out.push({name: clip(h[2].replace(/[*_`#]/g, ''), 70), kind: 'h' + h[1].length, line: i + 1});
      continue;
    }
    if (line.length > 400) continue;
    for (const [re, kind] of RX[lang]) {
      const m = line.match(re);
      if (m && m[1] && !KEYWORDS.has(m[1])) {
        out.push({name: m[1], kind, line: i + 1, sig: clip(line.trim().replace(/\s*\{\s*$/, ''), 110)});
        break;
      }
    }
  }
  return out;
}

export const lineCount = t => t ? t.split('\n').length - (t.endsWith('\n') ? 1 : 0) : 0;

function lcsDiff(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const A = a.slice(start, endA), B = b.slice(start, endB);
  const ops = [];
  for (let k = Math.max(0, start - 3); k < start; k++) ops.push(['=', k, b[k]]);
  const tailOps = [];
  for (let k = 0; k < Math.min(3, b.length - endB); k++) tailOps.push(['=', endB + k, b[endB + k]]);
  if (A.length * B.length > 4_000_000) {
    for (let i = 0; i < A.length; i++) ops.push(['-', start + i, A[i]]);
    for (let j = 0; j < B.length; j++) ops.push(['+', start + j, B[j]]);
    return {start, ops: ops.concat(tailOps), coarse: true};
  }
  const n = A.length, m = B.length;
  const table = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    table[i * (m + 1) + j] = A[i] === B[j] ? table[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(table[(i + 1) * (m + 1) + j], table[i * (m + 1) + j + 1]);
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { ops.push(['=', start + j, B[j]]); i++; j++; }
    else if (i < n && (j === m || table[(i + 1) * (m + 1) + j] >= table[i * (m + 1) + j + 1])) { ops.push(['-', start + i, A[i]]); i++; }
    else { ops.push(['+', start + j, B[j]]); j++; }
  }
  return {start, ops: ops.concat(tailOps)};
}
export function diffText(oldText, newText, {context = 2, maxLines = 220} = {}) {
  const a = oldText.split('\n'), b = newText.split('\n');
  const {ops} = lcsDiff(a, b);
  const changed = ops.map((o, k) => o[0] !== '=' ? k : -1).filter(k => k >= 0);
  if (!changed.length) return '';
  const keep = new Set();
  for (const k of changed) for (let x = Math.max(0, k - context); x <= Math.min(ops.length - 1, k + context); x++) keep.add(x);
  const out = [];
  let last = -2;
  for (const k of [...keep].sort((x, y) => x - y)) {
    if (k !== last + 1) out.push('@@ line ' + (ops[k][1] + 1));
    const [op, , line] = ops[k];
    out.push((op === '=' ? '  ' : op + ' ') + (line.length > 300 ? line.slice(0, 299) + '…' : line));
    last = k;
    if (out.length > maxLines) { out.push(`… diff truncated (${changed.length} changed lines). Use --range to read a region.`); break; }
  }
  return out.join('\n');
}

export function outline(text, ext) {
  const syms = symbols(text, ext);
  const lines = text.split('\n');
  const head = lines.slice(0, 25).map((l, i) => `${i + 1}| ${clip(l, 160)}`).join('\n');
  const list = syms.slice(0, 120).map(s => `  ${s.line}: ${s.sig || s.name}`).join('\n');
  return {head, list, lines: lineCount(text), count: syms.length};
}

