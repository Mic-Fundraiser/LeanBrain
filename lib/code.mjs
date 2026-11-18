// Code navigation that spends few tokens: repo maps, symbol lookup, grouped grep, outline-first reads
// and diffs instead of re-reads.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {state, hash, atomic, readJSON, clip, tilde, exists} from './core.mjs';
import {tokens, record} from './tokens.mjs';
import {LANG, symbols, lineCount, diffText, outline} from './text.mjs';
export {LANG, symbols, lineCount, diffText, outline};

const run = promisify(execFile);
const DEP_DIRS = new Set(['node_modules', '.venv', 'venv', '__pycache__', 'site-packages', 'Pods', 'bower_components', '.yarn', '.pnpm-store',
  '.git', '.next', '.nuxt', '.svelte-kit', '.turbo', 'DerivedData', '.gradle', '.tox', '.mypy_cache', '.pytest_cache', 'coverage', '.cache']);
const WALK_SKIP = new Set([...DEP_DIRS, 'dist', 'build', 'target', 'vendor', 'out']);
const NOISE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock|.*\.min\.(js|css)|.*\.map|.*\.lock)$/;
const BINARY = /\.(png|jpe?g|gif|webp|ico|icns|bmp|tiff?|psd|ai|sketch|fig|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|o|a|so|dylib|dll|exe|bin|wasm|mp3|mp4|mov|avi|mkv|webm|wav|flac|ogg|m4a|ttf|otf|woff2?|eot|sqlite3?|db|pyc|DS_Store|parquet|feather|npy|pkl|h5|onnx|pt|ckpt|safetensors|xlsx?|docx?|pptx?|key|numbers|pages)$/i;
const glob = pattern => {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') { re += '.*'; i++; if (pattern[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') { const end = pattern.indexOf('}', i); re += '(' + pattern.slice(i + 1, end).split(',').map(s => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')'; i = end; }
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
};
export function globTest(patterns) {
  if (!patterns) return () => true;
  const list = String(patterns).split(',').map(s => s.trim()).filter(Boolean).map(p => [p.includes('/'), glob(p)]);
  return rel => list.some(([full, re]) => re.test(full ? rel : path.posix.basename(rel)));
}

/** Files of a folder: git ls-files when available (respects .gitignore), otherwise a walk. Relative POSIX paths. */
export async function listFiles(root, {limit = 30000} = {}) {
  const keep = rel => !rel.split('/').some(seg => DEP_DIRS.has(seg)) && !BINARY.test(rel);
  if (await exists(path.join(root, '.git'))) {
    try {
      const {stdout} = await run('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'], {maxBuffer: 256 << 20});
      return stdout.split('\0').filter(Boolean).filter(keep).slice(0, limit);
    } catch {}
  }
  const out = [];
  const stack = [''];
  while (stack.length && out.length < limit) {
    const rel = stack.pop();
    let entries;
    try { entries = await fs.readdir(path.join(root, rel), {withFileTypes: true}); } catch { continue; }
    for (const e of entries) {
      if (e.isSymbolicLink() || (e.name.startsWith('.') && e.name !== '.github')) continue;
      const child = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!WALK_SKIP.has(e.name)) stack.push(child); }
      else if (e.isFile() && keep(child)) out.push(child);
    }
  }
  return out.sort();
}

async function readText(file, max = 1_000_000) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > max) return null;
    const buffer = await fs.readFile(file);
    if (buffer.subarray(0, 8000).includes(0)) return null;
    return {text: buffer.toString('utf8'), stat};
  } catch { return null; }
}

/** Symbols for every source file of a project, cached by mtime and size. */
export async function projectSymbols(root) {
  const cacheFile = state('symbols/' + hash(root).slice(0, 24) + '.json');
  const cache = await readJSON(cacheFile, {files: {}});
  const files = (await listFiles(root)).filter(f => LANG[path.posix.extname(f).slice(1).toLowerCase()]);
  const next = {root, date: new Date().toISOString(), files: {}};
  let changed = false;
  for (const rel of files.slice(0, 8000)) {
    const full = path.join(root, rel);
    let stat;
    try { stat = await fs.stat(full); } catch { continue; }
    if (!stat.isFile() || stat.size > 1_000_000) continue;
    const old = cache.files[rel];
    if (old && old.m === Math.floor(stat.mtimeMs) && old.z === stat.size) { next.files[rel] = old; continue; }
    const r = await readText(full);
    if (!r) continue;
    next.files[rel] = {m: Math.floor(stat.mtimeMs), z: stat.size, n: lineCount(r.text), s: symbols(r.text, path.posix.extname(rel).slice(1).toLowerCase())};
    changed = true;
  }
  if (changed || Object.keys(cache.files).length !== Object.keys(next.files).length) await atomic(cacheFile, JSON.stringify(next));
  return next;
}

const KIND_RANK = {class: 0, type: 0, h1: 0, route: 1, fn: 1, impl: 1, table: 1, h2: 1, method: 2, h3: 2, const: 3, macro: 3};
const ENTRY = /(^|\/)(index|main|app|server|cli|__main__|manage|wsgi|asgi|routes?|api|mod|lib)\.[a-z]+$|^(src|app|lib)\/[^/]+\.[a-z]+$/i;
const COMMON = new Set(['main', 'init', 'test', 'setup', 'run', 'get', 'set', 'data', 'value', 'index', 'render', 'update', 'handle', 'start', 'stop', 'load', 'save', 'name', 'type', 'list', 'item', 'items', 'result', 'error', 'config', 'options', 'default', 'constructor', 'toString', 'length']);

export async function mapText(p, {sub = '', budget = 1200, record: log = true} = {}) {
  const root = sub ? path.resolve(p.id, sub) : p.id;
  if (!root.startsWith(p.id)) throw Error('Path outside the project.');
  const all = await listFiles(p.id);
  const prefix = sub ? path.relative(p.id, root).split(path.sep).join('/') + '/' : '';
  const files = all.filter(f => !prefix || f.startsWith(prefix));
  const syms = await projectSymbols(p.id);
  const code = files.filter(f => syms.files[f]);
  // Reference counting: how often each file's symbols are used by other files.
  const defs = new Map();
  for (const f of code) for (const s of syms.files[f].s) if (s.name.length >= 4 && !COMMON.has(s.name) && !s.kind.startsWith('h')) {
    if (!defs.has(s.name)) defs.set(s.name, new Set());
    defs.get(s.name).add(f);
  }
  const refs = new Map(), symRefs = new Map();
  let baseline = 0;
  const contents = [];
  for (const f of code.slice(0, 3000)) {
    const r = await readText(path.join(p.id, f), 600_000);
    if (!r) continue;
    contents.push(r.text);
    const seen = new Set(r.text.match(/[A-Za-z_$][\w$]{3,}/g) || []);
    for (const word of seen) {
      const owners = defs.get(word);
      if (!owners) continue;
      for (const owner of owners) if (owner !== f) { refs.set(owner, (refs.get(owner) || 0) + 1); symRefs.set(word, (symRefs.get(word) || 0) + 1); }
    }
  }
  baseline = tokens(contents.join('\n'));
  const now = Date.now();
  const score = f => {
    const info = syms.files[f];
    const depth = f.split('/').length - 1;
    const recent = Math.max(0, 1 - (now - info.m) / (30 * 86400e3));
    const doc = f.endsWith('.md') ? -2 : 0;
    return (refs.get(f) || 0) * 2 + (ENTRY.test(f) ? 6 : 0) + Math.min(info.s.length, 12) * 0.3 + recent * 2 - depth * 0.4 + doc;
  };
  const ranked = code.slice().sort((a, b) => score(b) - score(a));
  const header = `Map · ${p.name}${sub ? '/' + prefix.slice(0, -1) : ''} · ${files.length} files, ${code.length} with symbols · ranked by use`;
  const out = [header];
  let used = tokens(header);
  const shown = new Set();
  for (const f of ranked) {
    const info = syms.files[f];
    const list = info.s.filter(s => s.kind !== 'method' || (symRefs.get(s.name) || 0) > 0)
      .sort((a, b) => (symRefs.get(b.name) || 0) - (symRefs.get(a.name) || 0) || (KIND_RANK[a.kind] ?? 2) - (KIND_RANK[b.kind] ?? 2) || a.line - b.line);
    const labels = list.slice(0, 10).map(s => (s.kind === 'fn' || s.kind === 'method' ? s.name + '()' : s.kind.startsWith('h') ? '§' + s.name : s.name) + ':' + s.line);
    const more = list.length > 10 ? ` +${list.length - 10}` : '';
    const block = `${f} (${info.n})` + (labels.length ? '\n  ' + labels.join(' ') + more : '');
    const cost = tokens(block) + 1;
    if (used + cost > budget) { if (used > budget * 0.85) break; continue; }
    out.push(block); used += cost; shown.add(f);
  }
  const rest = files.filter(f => !shown.has(f));
  if (rest.length) {
    const dirs = new Map();
    for (const f of rest) { const d = f.includes('/') ? f.split('/').slice(0, f.split('/').length > 2 ? 2 : 1).join('/') + '/' : './'; dirs.set(d, (dirs.get(d) || 0) + 1); }
    const summary = [...dirs].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([d, n]) => `${d} ${n}`).join(' · ');
    const line = `Not shown (${rest.length}): ${summary}`;
    if (used + tokens(line) <= budget + 60) out.push(line);
  }
  out.push('Next: sym <name> · read <file> --range a:b · grep <regex>');
  const text = out.join('\n');
  if (log) await record('map', baseline, tokens(text), p.id);
  return text;
}

export async function symText(name, projects, {limit = 25} = {}) {
  const exact = [], loose = [];
  const lower = name.toLowerCase();
  for (const p of projects) {
    if (p.external) continue;
    const syms = await projectSymbols(p.id);
    for (const [rel, info] of Object.entries(syms.files)) for (const s of info.s) {
      if (s.kind.startsWith('h')) continue;
      const row = `${s.name} · ${s.kind} · ${projects.length > 1 ? p.name + ':' : ''}${rel}:${s.line}${s.sig ? ' · ' + s.sig : ''}`;
      if (s.name === name) exact.push(row);
      else if (s.name.toLowerCase().includes(lower)) loose.push(row);
    }
  }
  const rows = [...exact, ...loose];
  if (!rows.length) return `No symbol "${name}". Try grep "${name}".`;
  return [`${rows.length} symbol${rows.length > 1 ? 's' : ''} for "${name}"${exact.length ? ` (${exact.length} exact)` : ''}`, ...rows.slice(0, limit), rows.length > limit ? `… ${rows.length - limit} more: be more specific.` : ''].filter(Boolean).join('\n');
}

function compileRegex(pattern, {fixed, ignoreCase}) {
  const source = fixed ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
  const smart = ignoreCase ?? pattern === pattern.toLowerCase();
  try { return new RegExp(source, smart ? 'i' : ''); }
  catch (e) { throw Error('Invalid regex: ' + e.message + ' (use --fixed for plain text)'); }
}
const trimAround = (line, re, width = 160) => {
  const text = line.replace(/\t/g, '  ');
  if (text.length <= width) return text.trim();
  const m = text.match(re);
  const at = m ? m.index : 0;
  const start = Math.max(0, at - Math.floor(width / 3));
  return (start > 0 ? '…' : '') + text.slice(start, start + width).trim() + (start + width < text.length ? '…' : '');
};

export async function grepText(pattern, p, {glob: globs, fixed, ignoreCase, budget = 900, perFile = 6, context = 0} = {}) {
  const re = compileRegex(pattern, {fixed, ignoreCase});
  const match = globTest(globs);
  const files = (await listFiles(p.id)).filter(f => match(f) && (globs || !NOISE.test(f)));
  const groups = [];
  let raw = 0, total = 0, matchedFiles = 0;
  for (const rel of files) {
    const r = await readText(path.join(p.id, rel), 2_000_000);
    if (!r) continue;
    const lines = r.text.split('\n');
    const hits = [];
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) hits.push(i);
    if (!hits.length) continue;
    matchedFiles++; total += hits.length;
    raw += tokens(hits.map(i => `${rel}:${i + 1}:${lines[i]}`).join('\n'));
    const shownLines = [];
    const picked = new Set();
    for (const i of hits.slice(0, perFile)) for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) picked.add(j);
    for (const j of [...picked].sort((a, b) => a - b)) shownLines.push(`  ${j + 1}${hits.includes(j) ? ':' : '-'} ${trimAround(lines[j], re)}`);
    groups.push({rel, count: hits.length, block: `${rel} (${hits.length})\n` + shownLines.join('\n') + (hits.length > perFile ? `\n  … +${hits.length - perFile} more in this file` : '')});
  }
  if (!groups.length) return `No match for /${pattern}/ in ${p.name} (${files.length} files searched).`;
  groups.sort((a, b) => b.count - a.count);
  const out = [`${total} matches in ${matchedFiles} files · ${p.name}`];
  let used = tokens(out[0]);
  let omitted = 0;
  for (const g of groups) {
    const cost = tokens(g.block) + 1;
    if (used + cost > budget) { omitted++; continue; }
    out.push(g.block); used += cost;
  }
  if (omitted) out.push(`… ${omitted} more files not shown: narrow with --glob, a stricter regex, or --budget.`);
  const text = out.join('\n');
  await record('grep', raw, tokens(text), p.id);
  return text;
}

// ---- Reads ----------------------------------------------------------------------------------------
export async function readFileText(p, file, {range, full, chat, numbers} = {}) {
  const base = p?.external ? process.cwd() : p?.id || process.cwd();
  const target = path.resolve(base, file);
  const r = await readText(target, 8_000_000);
  if (!r) throw Error('Not a readable text file (or larger than 8 MB): ' + tilde(target));
  const rel = p && !p.external && target.startsWith(p.id + path.sep) ? path.relative(p.id, target) : tilde(target);
  const lines = r.text.split('\n');
  if (r.text.endsWith('\n')) lines.pop();
  const all = tokens(r.text);
  const ext = path.extname(target).slice(1).toLowerCase();
  let out, kind = 'read';
  if (range) {
    const [from, to] = String(range).split(/[:-]/).map(Number);
    const a = Math.max(1, from || 1), b = Math.min(lines.length, to || a + 80);
    out = `${rel} lines ${a}-${b} of ${lines.length}\n` + lines.slice(a - 1, b).map((l, i) => `${a + i}| ${l}`).join('\n');
  } else if (chat) {
    const snap = state('read-cache/' + hash(chat + '\0' + target).slice(0, 32));
    const previous = await fs.readFile(snap, 'utf8').catch(() => null);
    if (previous === r.text) { out = `${rel}: unchanged since your last read in this chat (${lines.length} lines).`; kind = 'reuse'; }
    else if (previous != null) {
      const d = diffText(previous, r.text);
      out = `${rel}: changed since your last read in this chat. Diff (old → new):\n${d}`;
    }
    if (r.text.length <= 2_000_000) await atomic(snap, r.text);
    pruneCache().catch(() => {});
  }
  if (!out) {
    if (full || all <= 2500) out = numbers ? lines.map((l, i) => `${i + 1}| ${l}`).join('\n') : r.text;
    else {
      const o = outline(r.text, ext);
      out = `${rel} · ${o.lines} lines · ${all} tokens in full · outline (${o.count} symbols):\n${o.list || '  (no symbols recognised)'}\nFirst lines:\n${o.head}\nNext: read ${file} --range a:b, or --full.`;
    }
  }
  await record(kind, all, tokens(out), p?.id);
  return out;
}

async function pruneCache() {
  const dir = state('read-cache');
  const now = Date.now();
  for (const name of await fs.readdir(dir).catch(() => [])) {
    const file = path.join(dir, name);
    const stat = await fs.stat(file).catch(() => null);
    if (stat && now - stat.mtimeMs > 3 * 86400e3) await fs.rm(file, {force: true});
  }
}

/** Matching lines with one line of context, at most 12 hits (kept from Atlante for compatibility). */
export async function excerptText(p, rel, term, chat) {
  if (p.external || !rel || !term) throw Error('Usage: excerpt <project> <file> <word> [chat-id]');
  const file = await fs.realpath(path.resolve(p.id, rel));
  if (!file.startsWith(p.id + path.sep)) throw Error('File outside the project.');
  const r = await readText(file, 2_000_000);
  if (!r) throw Error('A text file up to 2 MB is required.');
  const lines = r.text.split(/\r?\n/), wanted = term.toLowerCase();
  const picked = new Set();
  let hits = 0;
  for (let i = 0; i < lines.length; i++) if (lines[i].toLowerCase().includes(wanted)) {
    hits++;
    if (hits <= 12) for (let j = Math.max(0, i - 1); j <= Math.min(i + 1, lines.length - 1); j++) picked.add(j);
  }
  const relPath = path.relative(p.id, file);
  let text = `${hits} matches · ${relPath}\n` + [...picked].map(i => `${i + 1} | ${clip(lines[i], 400)}`).join('\n') + (hits > 12 ? '\nShowing the first 12. Narrow the search.' : '');
  let kind = 'excerpt';
  if (chat && hits) {
    const marker = state('read-cache/' + hash(JSON.stringify([chat, file, term])).slice(0, 32));
    const digest = hash(r.text);
    if (await fs.readFile(marker, 'utf8').catch(() => null) === digest) { text = `Excerpt unchanged in this chat: ${relPath} · ${term}`; kind = 'reuse'; }
    await atomic(marker, digest);
  }
  const full = tokens(r.text), short = tokens(text);
  await record(kind, full, short, p.id);
  return short < full ? text : r.text;
}
