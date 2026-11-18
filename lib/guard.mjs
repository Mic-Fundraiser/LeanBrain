// LeanBrain guard: Claude Code hooks that cut tokens without relying on the agent remembering rules.
//
// PreToolUse (Read, Bash file readers: cat, sed -n, head, tail, nl):
//   · a range already shown in this session and unchanged  → a one-line stub instead of the text
//   · a whole file read again after it changed               → only the diff
//   · a first whole read of a large file                     → an outline with line numbers
//   Repeating the same request within a few minutes always goes through, so the agent is never stuck.
// SessionStart: brief + card of the current project; after /compact or /clear the read memory is reset.
// UserPromptSubmit: the card of another project named in the prompt, once per session.
// Every decision fails open: any error means "allow".
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {state, atomic, readJSON, appendJSONL, day, clip} from './core.mjs';
import {symbols, lineCount, diffText} from './text.mjs';
import {loadImmunity, immunityCheck, immunityBrief, loadActivity, saveActivity, editorsOf, neighbours, dejaVu, minutesAgo} from './insights.mjs';

const BIG = Number(process.env.LEANBRAIN_GUARD_BIG) || 8000;
const ESCAPE_MS = 4 * 60e3;
const SNAP_MAX = 400_000;
const est = s => Math.ceil(Buffer.byteLength(String(s)) / 3.7);
const sha = s => createHash('sha1').update(s).digest('hex');
const SKIP = /\.(png|jpe?g|gif|webp|bmp|ico|svg|pdf|ipynb|heic|tiff?|mp4|mov|webm|zip|gz|tgz|sqlite3?|db)$/i;
const sessionFile = id => state('guard/' + String(id || 'none').replace(/[^\w-]/g, '').slice(0, 80) + '.json');
const loadSession = id => readJSON(sessionFile(id), {files: {}, injected: []}).catch(() => ({files: {}, injected: []}));
const saveSession = (id, st) => atomic(sessionFile(id), JSON.stringify({...st, updated: Date.now()}));
const log = (kind, full, returned) => appendJSONL(state('token-use.jsonl'), {kind, full, compact: Math.min(full, returned), day: day(), at: Date.now(), est: true}).catch(() => {});

function merge(ranges) {
  const out = [];
  for (const r of ranges.slice().sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]); else out.push([r[0], r[1]]);
  }
  return out;
}
export function missing(ranges, [a, b]) {
  const out = [];
  let cur = a;
  for (const [x, y] of merge(ranges)) {
    if (y < cur) continue;
    if (x > b) break;
    if (x > cur) out.push([cur, Math.min(b, x - 1)]);
    cur = Math.max(cur, y + 1);
    if (cur > b) break;
  }
  if (cur <= b) out.push([cur, b]);
  return out;
}

async function readTarget(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 4_000_000) return null;
  const buffer = await fs.readFile(file);
  if (buffer.subarray(0, 8000).includes(0)) return null;
  const text = buffer.toString('utf8');
  return {text, lines: text.split('\n'), total: lineCount(text), hash: sha(text), size: stat.size};
}
const slice = (f, [a, b]) => f.lines.slice(a - 1, b).join('\n');
const display = file => { const home = os.homedir(); return file.startsWith(home + path.sep) ? '~' + file.slice(home.length) : file; };

function outlineText(f, file) {
  const syms = symbols(f.text, path.extname(file).slice(1).toLowerCase());
  const list = syms.slice(0, 90).map(s => `  ${s.line}: ${s.sig || s.name}`);
  const head = f.lines.slice(0, 12).map((l, i) => `${i + 1}| ${clip(l, 140)}`);
  return [list.length ? `Outline (${syms.length} symbols):` : 'No symbols recognised. First lines:', ...(list.length ? list : head)].join('\n');
}

/**
 * Core decision for a request of `range` lines of `file`. Returns null (allow) or {reason, kind, full}.
 * `st` is the session memory; it is updated in place.
 */
function decide(st, file, f, range, {tool, requestKey}) {
  const e = st.files[file];
  const now = Date.now();
  const whole = range[0] === 1 && range[1] >= f.total;
  if (e?.denied?.key === requestKey && now - e.denied.at < ESCAPE_MS) {
    delete e.denied;
    remember(st, file, f, range, whole);
    return null;
  }
  const requested = slice(f, range);
  const name = display(file);
  if (e && e.hash === f.hash && !missing(e.ranges, range).length) {
    const what = whole ? `${name} (${f.total} lines)` : `${name} lines ${range[0]}-${range[1]}`;
    e.denied = {key: requestKey, at: now};
    return {kind: 'guard-reread', full: est(requested),
      reason: `LeanBrain: ${what} ${whole ? 'is' : 'are'} unchanged since you read ${whole ? 'it' : 'them'} earlier in this session. Reuse that text. If it is no longer in your context, repeat this exact ${tool} call and it will go through.`};
  }
  if (e && e.hash !== f.hash && whole && e.whole && e.snap) {
    const previous = st.snaps?.[e.snap];
    if (previous != null) {
      const diff = diffText(previous, f.text, {context: 2, maxLines: 160});
      if (diff && est(diff) < est(f.text) * 0.5) {
        e.denied = {key: requestKey, at: now};
        remember(st, file, f, range, whole);
        return {kind: 'guard-diff', full: est(requested),
          reason: `LeanBrain: ${name} changed since you read it in this session. Your earlier copy plus this diff is the current file (old → new):\n${diff}\nRepeat this exact ${tool} call for the full text.`};
      }
    }
  }
  if (whole && (!e || e.hash !== f.hash) && est(requested) > BIG && f.total > 120) {
    e && (e.denied = undefined);
    st.files[file] = {...(st.files[file] || {}), hash: f.hash, ranges: [], total: f.total, denied: {key: requestKey, at: now}};
    return {kind: 'guard-outline', full: est(requested),
      reason: `LeanBrain token guard: ${name} is large (${f.total} lines, ~${Math.round(est(requested) / 100) / 10}k tokens), so here is its outline instead. Read just the ranges your task needs with ${tool === 'Read' ? 'offset/limit' : "sed -n 'A,Bp'"} (line numbers below). Only if you truly need every line, repeat this exact ${tool} call and it will go through.\n${outlineText(f, file)}`};
  }
  remember(st, file, f, range, whole);
  return null;
}

function remember(st, file, f, range, whole) {
  const e = st.files[file];
  const same = e && e.hash === f.hash;
  const next = {hash: f.hash, total: f.total, ranges: merge([...(same ? e.ranges : []), range]), whole: (same && e.whole) || whole};
  if (next.whole && f.size <= SNAP_MAX) {
    st.snaps ||= {};
    st.snaps[f.hash] = f.text;
    next.snap = f.hash;
    const keep = new Set(Object.values(st.files).map(x => x.snap).concat(f.hash));
    for (const k of Object.keys(st.snaps)) if (!keep.has(k)) delete st.snaps[k];
    const keys = Object.keys(st.snaps);
    for (const k of keys.slice(0, Math.max(0, keys.length - 24))) if (k !== f.hash) delete st.snaps[k];
  }
  st.files[file] = next;
}

const unquote = s => s.replace(/^'(.*)'$/s, '$1').replace(/^"(.*)"$/s, '$1');
const ARG = String.raw`('[^']*'|"[^"]*"|[^\s'"]+)`;
/** Recognise a single, side-effect-free file printer, optionally after `cd dir &&`. */
export function parseReader(command, cwd) {
  let c = String(command || '').trim().replace(/\s+2>\s*\/dev\/null\s*$/, '');
  let dir = cwd || process.cwd();
  for (;;) {
    const m = c.match(new RegExp(String.raw`^cd\s+${ARG}\s*&&\s*`));
    if (!m) break;
    dir = path.resolve(dir, unquote(m[1]).replace(/^~(?=\/|$)/, os.homedir()));
    c = c.slice(m[0].length);
  }
  if (/[|;&<>`$(){}*?\\]/.test(c.replace(/'[^']*'|"[^"]*"/g, ''))) return null;
  const at = arg => path.resolve(dir, unquote(arg).replace(/^~(?=\/|$)/, os.homedir()));
  let m;
  if ((m = c.match(new RegExp(String.raw`^cat\s+(?:-n\s+)?${ARG}$`)))) return {kind: 'cat', file: at(m[1])};
  if ((m = c.match(new RegExp(String.raw`^nl\s+-ba\s+${ARG}$`)))) return {kind: 'cat', file: at(m[1])};
  if ((m = c.match(new RegExp(String.raw`^sed\s+-n\s+(['"]?)(\d+)(?:,(\d+|\$))?p\1\s+${ARG}$`)))) return {kind: 'sed', a: Number(m[2]), b: m[3] === '$' ? Infinity : Number(m[3] || m[2]), file: at(m[4])};
  if ((m = c.match(new RegExp(String.raw`^head\s+(?:-n\s*(\d+)\s+|-(\d+)\s+)?${ARG}$`)))) return {kind: 'head', n: Number(m[1] || m[2] || 10), file: at(m[3])};
  if ((m = c.match(new RegExp(String.raw`^tail\s+(?:-n\s*(\d+)|-(\d+))\s+${ARG}$`)))) return {kind: 'tail', n: Number(m[1] || m[2]), file: at(m[3])};
  return null;
}

async function preTool(input) {
  const tool = input.tool_name;
  const args = input.tool_input || {};
  let file, range, requestKey;
  if (tool === 'Read') {
    file = args.file_path;
    if (!file || SKIP.test(file)) return null;
    const f = await readTarget(file).catch(() => null);
    if (!f || !f.total) return null;
    const start = Math.max(1, Number(args.offset) || 1);
    const end = Math.min(f.total, start + (Number(args.limit) || 2000) - 1);
    if (start > end) return null;
    range = [start, end];
    requestKey = `Read:${start}:${args.limit || ''}`;
    return apply(input, tool, file, f, range, requestKey);
  }
  if (tool === 'Bash') {
    const why = immunityCheck(args.command, await loadImmunity());
    if (why) {
      const st = await loadSession(input.session_id);
      const key = 'immune:' + String(args.command).trim();
      st.escapes ||= {};
      if (Date.now() - (st.escapes[key] || 0) > ESCAPE_MS) {
        st.escapes[key] = Date.now();
        await saveSession(input.session_id, st);
        await log('immunity', 400, est(why));
        return deny(`LeanBrain immunity: ${why} If you are sure it will work now, repeat the same command.`);
      }
    }
    const r = parseReader(args.command, input.cwd);
    if (!r || SKIP.test(r.file)) return null;
    const f = await readTarget(r.file).catch(() => null);
    if (!f || !f.total) return null;
    range = r.kind === 'cat' ? [1, f.total] : r.kind === 'sed' ? [r.a, Math.min(r.b, f.total)] : r.kind === 'head' ? [1, Math.min(r.n, f.total)] : [Math.max(1, f.total - r.n + 1), f.total];
    if (range[0] > range[1]) return null;
    requestKey = 'Bash:' + String(args.command).trim();
    return apply(input, tool, r.file, f, range, requestKey);
  }
  if (EDITS.has(tool)) return radarEdit(input, args.file_path || args.notebook_path);
  return null;
}

const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const deny = reason => ({hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason}});

/** Collision radar: warn once before editing a file another session changed in the last 30 minutes. */
async function radarEdit(input, file) {
  if (!file) return null;
  const sid = input.session_id;
  const a = await loadActivity();
  const db = await readJSON(state('sessions.json'), {sessions: {}}).catch(() => ({sessions: {}}));
  const others = editorsOf(file, a, Object.values(db.sessions || {}), {sid, minutes: 30});
  (a.files[file] ||= []).push({sid, at: Date.now()});
  a.sessions[sid] = {...(a.sessions[sid] || {}), at: Date.now(), cwd: input.cwd || a.sessions[sid]?.cwd};
  await saveActivity(a);
  if (!others.length) return null;
  const st = await loadSession(sid);
  st.escapes ||= {};
  const key = 'radar:' + file;
  if (Date.now() - (st.escapes[key] || 0) < ESCAPE_MS) return null;
  st.escapes[key] = Date.now();
  await saveSession(sid, st);
  const o = others[0];
  return deny(`LeanBrain radar: another ${o.agent} session edited ${display(file)} ${minutesAgo(o.at)} min ago${o.title ? ` (it started with "${clip(o.title, 80)}")` : ''}. Read the file again before changing it so you do not overwrite that work; then repeat this edit.`);
}

async function apply(input, tool, file, f, range, requestKey) {
  const st = await loadSession(input.session_id);
  const verdict = decide(st, file, f, range, {tool, requestKey});
  await saveSession(input.session_id, st);
  if (!verdict) return null;
  await log(verdict.kind, verdict.full, est(verdict.reason));
  return {hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.reason}};
}

async function sessionStart(input) {
  if (input.source === 'compact' || input.source === 'clear') await fs.rm(sessionFile(input.session_id), {force: true});
  if (input.cwd) try { process.chdir(input.cwd); } catch {}
  const {brief} = await import('./commands.mjs');
  const {context, packText} = await import('./card.mjs');
  const {projectAt} = await import('./core.mjs');
  let text = await brief({hook: true});
  const facts = immunityBrief(await loadImmunity());
  if (facts) text += '\n' + facts;
  const ctx = await context();
  const here = projectAt(ctx.index, input.cwd || process.cwd());
  if (here) text += '\n\n' + packText(here, ctx, 350);
  return {hookSpecificOutput: {hookEventName: 'SessionStart', additionalContext: text}};
}

const STOP = new Set(['projects', 'progetti', 'downloads', 'desktop', 'documents', 'dashboard', 'website', 'server', 'studio', 'backend', 'frontend',
  'client', 'scripts', 'template', 'templates', 'landing', 'agents', 'scraper', 'tools', 'utils', 'notes', 'tests', 'design', 'mobile', 'admin',
  'portal', 'theme', 'plugin', 'plugins', 'skills', 'social', 'export', 'import', 'report', 'reports', 'images', 'assets', 'public', 'static']);
async function prompt(input) {
  const text = String(input.prompt || '');
  const sid = input.session_id;
  const st = await loadSession(sid);
  st.injected ||= []; st.seen ||= [];
  const a = await loadActivity();
  a.sessions[sid] = {at: Date.now(), cwd: input.cwd || a.sessions[sid]?.cwd, title: a.sessions[sid]?.title || clip(text, 90)};
  await saveActivity(a);
  const {syncSessions} = await import('./sessions.mjs');
  const {context, packText} = await import('./card.mjs');
  const {projectAt, inside} = await import('./core.mjs');
  const ctxIndex = await import('./core.mjs').then(m => m.loadIndex());
  const synced = await readJSON(state('sessions.json'), {}).catch(() => ({}));
  if (synced.v === 3) await syncSessions({index: ctxIndex}).catch(() => null);
  const ctx = await context();
  const here = projectAt(ctx.index, input.cwd || process.cwd());
  const parts = [];
  // Radar: other sessions working in this project right now.
  if (here) for (const n of neighbours(here.id, a, ctx.sessions, {sid, inside})) {
    const key = 'radar:' + n.agent + ':' + n.title;
    if (st.seen.includes(key)) continue;
    st.seen.push(key);
    parts.push(`LeanBrain radar: another ${n.agent} session is active in ${here.name} (${minutesAgo(n.at)} min ago${n.title ? `: "${clip(n.title, 80)}"` : ''}${n.files?.length ? `; edited ${n.files.join(', ')}` : ''}). Avoid editing the same files at the same time.`);
  }
  // Déjà vu: similar work already done, in any project, by any agent.
  const deja = dejaVu(text, ctx, {sessionId: sid, hereId: here?.id}).filter(d => !st.seen.includes('deja:' + d.sid));
  if (deja.length) {
    for (const d of deja) st.seen.push('deja:' + d.sid);
    parts.push('LeanBrain déjà vu — similar work was done before; reuse it instead of starting over:\n' + deja.map(d => '- ' + d.line).join('\n'));
  }
  // The card of another project named in the prompt.
  const lower = text.toLowerCase();
  let best = null;
  if (lower.length >= 5) for (const p of ctx.index.projects) {
    if (p === here || st.injected.includes(p.id)) continue;
    for (const key of new Set([path.basename(p.id), p.name, p.brainId].filter(Boolean).map(k => k.toLowerCase()))) {
      if (key.length < 5 || STOP.has(key)) continue;
      const re = new RegExp(`(^|[^\\p{L}\\p{N}_-])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}_-])`, 'u');
      if (re.test(lower) && (!best || key.length > best.key.length)) best = {p, key};
    }
  }
  if (best) {
    st.injected.push(best.p.id);
    parts.push(`LeanBrain card for "${best.p.name}" (named in the prompt):\n` + packText(best.p, ctx, 300));
  }
  // Pause tax: tell the user (not the model) when an expired cache makes this turn expensive.
  let systemMessage;
  const pause = await pauseCheck(input.transcript_path).catch(() => null);
  if (pause && !st.pauseWarned) {
    st.pauseWarned = true;
    systemMessage = `LeanBrain pause tax: idle ${pause.minutes} min, so the prompt cache has expired and this turn rewrites ~${Math.round(pause.tokens / 1000)}k tokens (≈$${pause.usd.toFixed(2)} at list price). For long breaks, a fresh session with the LeanBrain brief is cheaper.`;
  }
  await saveSession(sid, st);
  if (!parts.length && !systemMessage) return null;
  const out = {};
  if (parts.length) out.hookSpecificOutput = {hookEventName: 'UserPromptSubmit', additionalContext: parts.join('\n\n')};
  if (systemMessage) out.systemMessage = systemMessage;
  return out;
}

/** Idle time and context size of the session, from the tail of its transcript. */
async function pauseCheck(transcript) {
  if (!transcript) return null;
  const handle = await fs.open(transcript, 'r');
  let text;
  try {
    const {size} = await handle.stat();
    const length = Math.min(size, 400_000);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    text = buffer.toString('utf8');
  } finally { await handle.close(); }
  const lines = text.split('\n').reverse();
  for (const line of lines) {
    if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const u = r.message?.usage;
    if (!u) continue;
    const minutes = (Date.now() - Date.parse(r.timestamp)) / 60e3;
    const ttl = /^(5m)$/.test(process.env.CLAUDE_CODE_PROMPT_CACHE_TTL || '') || process.env.FORCE_PROMPT_CACHING_5M ? 5 : 60;
    const tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (minutes < ttl || tokens < 60000) return null;
    const {rates} = await import('./sessions.mjs');
    const r2 = await rates(String(r.message.model || ''));
    const usd = r2 ? tokens * (r2.cw - r2.cr) / 1e6 : 0;
    return usd >= 0.25 ? {minutes: Math.round(minutes), tokens, usd} : null;
  }
  return null;
}

export async function runHook(event, raw) {
  const input = raw ? JSON.parse(raw) : {};
  if (event === 'pre-tool') return preTool(input);
  if (event === 'session-start') return sessionStart(input);
  if (event === 'prompt') return prompt(input);
  if (event === 'pre-compact') { await fs.rm(sessionFile(input.session_id), {force: true}); return null; }
  return null;
}

/** Remove guard memories of sessions idle for more than a week. */
export async function pruneGuard() {
  const dir = state('guard');
  for (const name of await fs.readdir(dir).catch(() => [])) {
    const file = path.join(dir, name);
    const stat = await fs.stat(file).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > 7 * 86400e3) await fs.rm(file, {force: true});
  }
}
