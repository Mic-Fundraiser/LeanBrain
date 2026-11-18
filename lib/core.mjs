// Shared plumbing: state directory, safe file IO, argument parsing, project resolution, formatting.
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const NAME = 'LeanBrain';
export const VERSION = '1.0.0';
export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const SCRIPT = path.join(ROOT, 'leanbrain.mjs');
export const HOME = process.env.LEANBRAIN_HOME || process.env.ATLANTE_HOME || path.join(os.homedir(), '.leanbrain');
export const state = name => path.join(HOME, name);

/** Create the state folder; the first run imports the data of Atlante, the previous name of the tool. */
export async function initState() {
  if (!process.env.LEANBRAIN_HOME && !process.env.ATLANTE_HOME && !fss.existsSync(HOME)) {
    const legacy = path.join(os.homedir(), '.atlante');
    if (fss.existsSync(legacy)) await fs.cp(legacy, HOME, {recursive: true}).catch(() => {});
  }
  await fs.mkdir(HOME, {recursive: true, mode: 0o700});
}

export const hash = value => createHash('sha256').update(value).digest('hex');
export async function atomic(target, value) {
  await fs.mkdir(path.dirname(target), {recursive: true, mode: 0o700});
  const tmp = target + '.' + randomUUID();
  await fs.writeFile(tmp, value, {mode: 0o600});
  await fs.rename(tmp, target);
}
export async function readJSON(target, fallback) {
  try { return JSON.parse(await fs.readFile(target, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export async function readJSONL(target) {
  let raw;
  try { raw = await fs.readFile(target, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const rows = [];
  for (const line of raw.split('\n')) if (line) { try { rows.push(JSON.parse(line)); } catch {} }
  return rows;
}
export const appendJSONL = (target, row) => fs.appendFile(target, JSON.stringify(row) + '\n', {mode: 0o600});
export const exists = target => fs.access(target).then(() => true, () => false);

/** Read at most `max` bytes from the start of a file, or null. */
export async function head(target, max = 65536) {
  let handle;
  try {
    handle = await fs.open(target, 'r');
    const buffer = Buffer.alloc(max);
    const {bytesRead} = await handle.read(buffer, 0, max, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch { return null; }
  finally { await handle?.close(); }
}
/** Read the last `max` bytes of a file, or ''. */
export async function tail(target, max = 8192) {
  let handle;
  try {
    handle = await fs.open(target, 'r');
    const {size} = await handle.stat();
    const length = Math.min(max, size);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch { return ''; }
  finally { await handle?.close(); }
}

export const emptyIndex = () => ({roots: [], projects: [], large: [], folders: [], skipped: 0});
export const loadIndex = () => readJSON(state('index.json'), emptyIndex());

/** Minimal argv parser: positionals in `_`, `--flag`, `--key value`, `--key=value`, and `--` for the rest. */
export function parseArgs(argv, spec = {}) {
  const out = {_: []};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { out.rest = argv.slice(i + 1); break; }
    if (!arg.startsWith('--') || arg === '--') { out._.push(arg); continue; }
    const eq = arg.indexOf('=');
    const key = arg.slice(2, eq < 0 ? undefined : eq);
    const type = spec[key];
    if (!type) throw Error(`Unknown option --${key}. See: leanbrain help`);
    if (type === 'bool') { out[key] = true; continue; }
    const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) throw Error(`--${key} needs a value`);
    if (type === 'number' && !Number.isFinite(Number(value))) throw Error(`--${key} needs a number`);
    out[key] = type === 'number' ? Number(value) : value;
  }
  return out;
}

export const inside = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
};
/** The innermost indexed project that contains `dir`. */
export function projectAt(index, dir) {
  let best = null;
  for (const p of index.projects) if (!p.external && inside(p.id, dir) && (!best || p.id.length > best.id.length)) best = p;
  return best;
}
const ambiguous = list => Error('Several projects match. Pass one of these:\n' + list.slice(0, 6).map(p => '  ' + p.name + ' — ' + tilde(p.id)).join('\n'));
/** Accepts ".", nothing (= current folder), a path, a name, a catalogue id or a unique fragment. */
export function resolveProject(index, arg, rank) {
  if (!arg || arg === '.') {
    const here = projectAt(index, process.cwd());
    if (here) return here;
    throw Error('This folder is not inside an indexed project. Pass a name (leanbrain find <words>) or run leanbrain scan.');
  }
  const abs = path.resolve(arg.startsWith('~/') ? path.join(os.homedir(), arg.slice(2)) : arg);
  const lower = arg.toLowerCase();
  const tests = [p => p.id === arg, p => p.id === abs, p => p.name.toLowerCase() === lower,
    p => p.brainId?.toLowerCase() === lower, p => path.basename(p.id).toLowerCase() === lower];
  for (const test of tests) {
    const hits = index.projects.filter(test);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw ambiguous(hits);
  }
  if (fss.existsSync(abs)) { const p = projectAt(index, abs); if (p) return p; }
  const partial = index.projects.filter(p => (p.id + ' ' + p.name).toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  if (rank) {
    const hits = rank(arg);
    if (hits.length === 1 || (hits.length > 1 && hits[0].score >= hits[1].score * 1.6)) return hits[0].p;
    if (hits.length) throw ambiguous(hits.map(h => h.p));
  }
  if (partial.length) throw ambiguous(partial);
  throw Error(`No project matches "${arg}". Try: leanbrain find ${arg}`);
}

export const tilde = p => {
  const home = os.homedir();
  return p && (p === home || p.startsWith(home + path.sep)) ? '~' + p.slice(home.length) : p;
};
export const clip = (text, n) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
};
export const fmt = n => new Intl.NumberFormat('en-US').format(Math.round(n || 0));
export const compact = n => {
  n = Math.round(n || 0);
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (Math.abs(n) >= 1e4) return Math.round(n / 1e3) + 'k';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
};
export function bytes(n = 0) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return (Math.round(n * 10) / 10) + ' ' + units[i];
}
export function ago(date, now = Date.now()) {
  const t = typeof date === 'number' ? date : Date.parse(date);
  if (!t) return '';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 90) return 'now';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400 * 1.5) return Math.round(s / 3600) + 'h';
  if (s < 86400 * 45) return Math.round(s / 86400) + 'd';
  if (s < 86400 * 400) return Math.round(s / 86400 / 30) + 'mo';
  return Math.round(s / 86400 / 365) + 'y';
}
export const day = (d = new Date()) => new Date(d).toISOString().slice(0, 10);

/** How agents should call the CLI: the bare name when it is linked in PATH, else node + absolute path. */
export function cliCommand() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    try { if (fss.realpathSync(path.join(dir, 'leanbrain')) === fss.realpathSync(SCRIPT)) return 'leanbrain'; } catch {}
  }
  return 'node ' + "'" + SCRIPT.replaceAll("'", "'\\''") + "'";
}

/** Run async jobs with bounded concurrency. */
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({length: Math.min(limit, items.length)}, async () => {
    while (next < items.length) { const i = next++; results[i] = await worker(items[i], i); }
  });
  await Promise.all(runners);
  return results;
}
