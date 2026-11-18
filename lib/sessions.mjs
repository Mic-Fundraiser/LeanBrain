// Automatic memory: reads the local transcripts of Claude Code, Codex and Gemini CLI, incrementally
// (only the bytes added since the last sync), and keeps a small summary per session: when, where,
// what was asked, how it ended, which files were edited, and how many tokens it cost.
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {state, readJSON, atomic, projectAt, inside, hash, SCRIPT, clip, compact, fmt, day, head as headText} from './core.mjs';

const FILE = () => state('sessions.json');
const LOCK = () => state('sessions.lock');
const HOMEDIR = os.homedir();
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'write_file', 'replace', 'edit_file']);

export const loadSessions = () => readJSON(FILE(), {v: 1, files: {}, sessions: {}});

function cleanPrompt(text) {
  let t = String(text || '');
  t = t.replace(/<([a-z][\w-]*)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<pasted_content[\s\S]*$/i, ' ');
  t = t.replace(/\s+/g, ' ').trim().replace(/^((Task|Background) \(from the session that started this one\):\s*)+/i, '');
  if (!t || /^(<|Caveat:|\[Request interrupted|Base directory for this skill|# AGENTS\.md|This session is being continued)/.test(t)) return '';
  return clip(t, 180);
}
const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(b => b && (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text')).map(b => b.text || '').join(' ') : '';

async function* readLines(file, start) {
  const handle = await fs.open(file, 'r');
  try {
    const {size} = await handle.stat();
    const buffer = Buffer.alloc(4 << 20);
    let pos = start, rest = Buffer.alloc(0);
    while (pos < size) {
      const {bytesRead} = await handle.read(buffer, 0, Math.min(buffer.length, size - pos), pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const chunk = rest.length ? Buffer.concat([rest, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
      let from = 0, nl;
      while ((nl = chunk.indexOf(10, from)) !== -1) {
        yield {line: chunk.length - from > 0 ? chunk.toString('utf8', from, nl) : '', end: pos - (chunk.length - nl - 1)};
        from = nl + 1;
      }
      rest = Buffer.from(chunk.subarray(from));
    }
  } finally { await handle.close(); }
}

function blank(agent, sid, file) {
  return {agent, sid, file, cwd: '', start: '', end: '', title: '', last: '', outcome: '', turns: 0, files: {}, tools: {}, usage: {}, out: {}, img: 0, pending: {}};
}
const bump = (map, key, n = 1, cap = 60) => { if (key in map || Object.keys(map).length < cap) map[key] = (map[key] || 0) + n; };
const stamp = (s, ts) => { if (!ts) return; if (!s.start || ts < s.start) s.start = ts; if (!s.end || ts > s.end) s.end = ts; };
function addUsage(s, model, u, replace = false) {
  model = model || 'unknown';
  const row = replace ? (s.usage[model] = {in: 0, out: 0, cr: 0, cw: 0, n: 0}) : (s.usage[model] ||= {in: 0, out: 0, cr: 0, cw: 0, n: 0});
  row.in += u.in || 0; row.out += u.out || 0; row.cr += u.cr || 0; row.cw += u.cw || 0; row.n += u.n ?? 1;
}

// Failure signatures learned from tool output: missing commands, GNU-only flags on BSD tools, missing modules.
const FAILS = [
  [/command not found:\s*([\w.+-]+)/, m => 'missing:' + m[1]],
  [/(?:^|\n)(?:[\w./-]+: )?(?:line \d+: )?([\w.+-]+): command not found/, m => 'missing:' + m[1]],
  [/No module named ['"]?([\w.]+)/, m => 'module:' + m[1].split('.')[0]],
  [/sed: (?:-I or -i may not be used with stdin|1: ".*": (?:invalid command code|extra characters|undefined label))/, () => 'bsd:sed-i'],
  [/readlink: illegal option -- f/, () => 'bsd:readlink-f'],
  [/date: illegal option -- d|date: illegal time format/, () => 'bsd:date-d'],
  [/grep: invalid option -- P/, () => 'bsd:grep-P'],
  [/xargs: illegal option -- r/, () => 'bsd:xargs-r'],
  [/zsh: no matches found:/, () => 'zsh:glob'],
];
export function failureSignatures(text) {
  const out = new Set();
  const sample = String(text || '').slice(0, 6000);
  for (const [re, key] of FAILS) { const m = sample.match(re); if (m) out.add(key(m)); }
  return [...out];
}
function noteFailure(s, text, command) {
  for (const sig of failureSignatures(text)) {
    s.fails ||= {};
    if (Object.keys(s.fails).length >= 40 && !(sig in s.fails)) continue;
    const row = s.fails[sig] ||= {n: 0, at: ''};
    row.n++; row.at = s.end || row.at;
    if (command && !row.cmd) row.cmd = String(command).slice(0, 140);
  }
}

function claudeLine(s, line) {
  if (line.length > 4_000_000) return;
  const isAssistant = line.includes('"type":"assistant"');
  if (!isAssistant && line.includes('"tool_result"')) {
    const i = line.lastIndexOf('"timestamp":"');
    if (i >= 0) stamp(s, line.slice(i + 13, i + 37).split('"')[0]);
    toolResults(s, line);
    return;
  }
  let r;
  try { r = JSON.parse(line); } catch { return; }
  stamp(s, r.timestamp);
  if (!s.cwd && r.cwd) s.cwd = r.cwd;
  if (r.type === 'summary' && r.summary && !s.summary) s.summary = clip(r.summary, 160);
  const side = r.isSidechain;
  if (r.type === 'user' && !r.isMeta && !side) {
    const text = cleanPrompt(textOf(r.message?.content));
    if (text) { s.turns++; if (!s.title) s.title = text; s.last = text; }
  }
  if (r.type === 'assistant' && r.message) {
    const m = r.message;
    if (m.usage && m.id !== s.lastMsgId && !String(m.model || '').startsWith('<')) {
      s.lastMsgId = m.id;
      const at = Date.parse(r.timestamp) || 0;
      const cw = m.usage.cache_creation_input_tokens || 0;
      if (at && s.lastCallAt && s.lastModel === m.model && at - s.lastCallAt > 5 * 60e3 && cw >= 20000) {
        const row = (s.pauses ||= {})[m.model] ||= {short: 0, shortTokens: 0, long: 0, longTokens: 0};
        if (at - s.lastCallAt <= 60 * 60e3) { row.short++; row.shortTokens += cw; } else { row.long++; row.longTokens += cw; }
      }
      if (at) { s.lastCallAt = at; s.lastModel = m.model; }
      addUsage(s, m.model, {in: m.usage.input_tokens, out: m.usage.output_tokens, cr: m.usage.cache_read_input_tokens, cw: m.usage.cache_creation_input_tokens});
    }
    for (const block of Array.isArray(m.content) ? m.content : []) {
      if (block.type === 'text' && block.text?.trim() && !side) s.outcome = clip(block.text, 260);
      if (block.type === 'tool_use') {
        bump(s.tools, block.name || 'tool', 1, 40);
        s.pending ||= {};
        s.pending[block.id] = block.name === 'Bash' ? 'Bash\u0000' + String(block.input?.command || '').slice(0, 200) : block.name || 'tool';
        const ids = Object.keys(s.pending);
        if (ids.length > 120) for (const id of ids.slice(0, ids.length - 120)) delete s.pending[id];
        const target = block.input?.file_path || block.input?.notebook_path;
        if (EDIT_TOOLS.has(block.name) && typeof target === 'string') bump(s.files, target);
      }
    }
  }
}

/** Model-visible size of tool results (text characters and images), by tool name. */
function toolResults(s, line) {
  if (line.length > 6_000_000) return;
  let r;
  try { r = JSON.parse(line); } catch { return; }
  s.out ||= {}; s.pending ||= {};
  for (const b of Array.isArray(r.message?.content) ? r.message.content : []) {
    if (b?.type !== 'tool_result') continue;
    const pending = s.pending[b.tool_use_id] || 'other';
    delete s.pending[b.tool_use_id];
    const [name, command] = pending.split('\u0000');
    let size = 0;
    if (typeof b.content === 'string') size = b.content.length;
    else for (const c of Array.isArray(b.content) ? b.content : []) {
      if (c?.type === 'text') size += (c.text || '').length;
      else if (c?.type === 'image') { s.img = (s.img || 0) + 1; s.out['images:' + name] = (s.out['images:' + name] || 0) + 1; }
    }
    if (Object.keys(s.out).length < 80 || name in s.out) s.out[name] = (s.out[name] || 0) + size;
    if (b.is_error && name === 'Bash') noteFailure(s, typeof b.content === 'string' ? b.content : (Array.isArray(b.content) ? b.content : []).map(c => c?.text || '').join('\n'), command);
  }
}

function codexLine(s, line) {
  if (line.length > 2_000_000) return;
  let r;
  try { r = JSON.parse(line); } catch { return; }
  stamp(s, r.timestamp);
  const p = r.payload || {};
  if (r.type === 'session_meta') { s.cwd ||= p.cwd || ''; if (p.id) s.sid = p.id; stamp(s, p.timestamp); }
  else if (r.type === 'turn_context') { if (p.model) s.model = p.model; if (p.cwd && !s.cwd) s.cwd = p.cwd; }
  else if (r.type === 'response_item' && p.type === 'message') {
    const text = textOf(p.content);
    if (p.role === 'user') { const t = cleanPrompt(text); if (t) { s.turns++; if (!s.title) s.title = t; s.last = t; } }
    else if (p.role === 'assistant' && text.trim()) s.outcome = clip(text, 260);
  } else if (r.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
    bump(s.tools, p.name || 'tool', 1, 40);
    const input = typeof p.input === 'string' ? p.input : typeof p.arguments === 'string' ? p.arguments : '';
    for (const m of input.matchAll(/\*\*\* (?:Update|Add) File: (.+)/g)) bump(s.files, path.resolve(s.cwd || HOMEDIR, m[1].trim()));
  } else if (r.type === 'response_item' && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output')) {
    const text = typeof p.output === 'string' ? p.output : JSON.stringify(p.output || '');
    if (/exit code:?\s*[1-9]|command not found|No module named|illegal option|invalid option|no matches found/i.test(text.slice(0, 6000))) noteFailure(s, text);
  } else if (r.type === 'event_msg' && p.type === 'token_count' && p.info?.total_token_usage) {
    const u = p.info.total_token_usage;
    s.usage = {};
    addUsage(s, s.model || 'codex', {in: (u.input_tokens || 0) - (u.cached_input_tokens || 0), cr: u.cached_input_tokens, out: (u.output_tokens || 0), n: 1}, true);
  } else if (r.type === 'event_msg' && p.type === 'task_complete' && p.last_agent_message) s.outcome = clip(p.last_agent_message, 260);
}

async function geminiFile(file, projectsByHash) {
  let data;
  try { data = JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
  const s = blank('gemini', data.sessionId || path.basename(file, '.json'), file);
  const dirHash = path.basename(path.dirname(path.dirname(file)));
  s.cwd = projectsByHash.get(data.projectHash || dirHash) || '';
  for (const m of Array.isArray(data.messages) ? data.messages : []) {
    stamp(s, m.timestamp);
    const text = typeof m.content === 'string' ? m.content : textOf(m.content);
    if (m.type === 'user') { const t = cleanPrompt(text); if (t) { s.turns++; if (!s.title) s.title = t; s.last = t; } }
    else if (text?.trim()) s.outcome = clip(text, 260);
    if (m.tokens) addUsage(s, m.model || 'gemini', {in: (m.tokens.input || 0) - (m.tokens.cached || 0), cr: m.tokens.cached, out: (m.tokens.output || 0) + (m.tokens.thoughts || 0)});
  }
  stamp(s, data.startTime); stamp(s, data.lastUpdated);
  return s;
}

async function walk(dir, depth, test, out = []) {
  let entries;
  try { entries = await fs.readdir(dir, {withFileTypes: true}); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) await walk(full, depth - 1, test, out);
    else if (e.isFile() && test(e.name)) out.push(full);
  }
  return out;
}

export function sources() {
  const claude = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOMEDIR, '.claude'), 'projects');
  const codex = path.join(process.env.CODEX_HOME || path.join(HOMEDIR, '.codex'), 'sessions');
  const gemini = path.join(HOMEDIR, '.gemini', 'tmp');
  return {claude, codex, gemini};
}

/** Incremental sync. Returns {read: files parsed, sessions: total}. */
export async function syncSessions({index, onProgress} = {}) {
  try {
    const lock = await fs.stat(LOCK());
    if (Date.now() - lock.mtimeMs < 10 * 60e3) return {busy: true};
  } catch {}
  await fs.writeFile(LOCK(), String(process.pid)).catch(() => {});
  try {
    let db = await loadSessions();
    if (db.v !== 3) db = {v: 3, files: {}, sessions: {}};
    db.files ||= {}; db.sessions ||= {};
    const {claude, codex, gemini} = sources();
    const isSubFile = f => f.includes(path.sep + 'subagents' + path.sep) || path.basename(f).startsWith('agent-');
    const claudeFiles = await walk(claude, 3, n => n.endsWith('.jsonl'));
    const jobs = [
      ...claudeFiles.filter(f => !isSubFile(f)).map(f => ['claude', f]),
      ...claudeFiles.filter(isSubFile).map(f => ['claude', f]),
      ...(await walk(codex, 4, n => n.endsWith('.jsonl'))).map(f => ['codex', f]),
    ];
    let read = 0, bytes = 0;
    for (const [agent, file] of jobs) {
      let stat;
      try { stat = await fs.stat(file); } catch { continue; }
      const prev = db.files[file];
      if (prev && prev.size === stat.size && prev.mtime === Math.floor(stat.mtimeMs)) continue;
      const restart = !prev || stat.size < prev.offset;
      const sid0 = prev?.sid || (agent === 'claude' ? path.basename(file, '.jsonl') : path.basename(file, '.jsonl').slice(-36));
      let s = !restart && db.sessions[sid0] ? db.sessions[sid0] : blank(agent, sid0, file);
      let sub = false;
      if (agent === 'claude' && isSubFile(file)) {
        const parent = file.includes(path.sep + 'subagents' + path.sep) ? path.basename(path.dirname(path.dirname(file)))
          : (await headText(file))?.match(/"sessionId":"([^"]+)"/)?.[1];
        if (parent) { sub = true; s = db.sessions[parent] || (db.sessions[parent] = blank('claude', parent, file)); }
      }
      let offset = restart ? 0 : prev.offset;
      try {
        for await (const {line, end} of readLines(file, offset)) {
          if (line) agent === 'claude' ? claudeLine(s, line) : codexLine(s, line);
          offset = end;
        }
      } catch { continue; }
      bytes += offset - (restart ? 0 : prev.offset);
      if (!sub && s.sid !== sid0) delete db.sessions[sid0];
      if (s.title || s.turns || Object.keys(s.usage).length || sub) db.sessions[s.sid] = s;
      db.files[file] = {size: stat.size, mtime: Math.floor(stat.mtimeMs), offset, sid: s.sid};
      if (++read % 25 === 0) onProgress?.(read, jobs.length, bytes);
    }
    if (fss.existsSync(gemini) && index) {
      const byHash = new Map(index.projects.filter(p => !p.external).map(p => [hash(p.id), p.id]));
      for (const file of await walk(gemini, 3, n => /^session-.*\.json$/.test(n))) {
        const stat = await fs.stat(file).catch(() => null);
        if (!stat) continue;
        const prev = db.files[file];
        if (prev && prev.size === stat.size && prev.mtime === Math.floor(stat.mtimeMs)) continue;
        const s = await geminiFile(file, byHash);
        if (s && (s.title || s.turns)) db.sessions[s.sid] = s;
        db.files[file] = {size: stat.size, mtime: Math.floor(stat.mtimeMs), offset: stat.size, sid: s?.sid};
        read++;
      }
    }
    for (const [file, f] of Object.entries(db.files)) if (!fss.existsSync(file)) delete db.files[file];
    db.synced = new Date().toISOString();
    await atomic(FILE(), JSON.stringify(db));
    try {
      const {learnImmunity, saveImmunity} = await import('./insights.mjs');
      await saveImmunity(learnImmunity(Object.values(db.sessions)));
    } catch {}
    return {read, bytes, sessions: Object.keys(db.sessions).length};
  } finally { await fs.rm(LOCK(), {force: true}); }
}

/** Start a detached background sync when the last one is older than `minutes`. */
export async function syncInBackground(minutes = 15) {
  const db = await readJSON(FILE(), null);
  if (db?.synced && Date.now() - Date.parse(db.synced) < minutes * 60e3) return false;
  try {
    const child = spawn(process.execPath, [SCRIPT, 'sessions', '--sync', '--quiet'], {detached: true, stdio: 'ignore', env: process.env});
    child.unref();
    return true;
  } catch { return false; }
}

/** Sessions attributed to projects: the working folder first, then folders whose files were edited. */
export function attribute(db, index) {
  const list = [];
  for (const s of Object.values(db.sessions || {})) {
    if (!s.start) continue;
    // The project whose files were edited most comes first; the working folder wins ties and sessions without edits.
    const home = s.cwd && (s.cwd === HOMEDIR);
    const here = s.cwd && !home ? projectAt(index, s.cwd) : null;
    const votes = new Map();
    if (here) votes.set(here.id, 0.5);
    for (const [file, n] of Object.entries(s.files || {})) {
      const p = path.isAbsolute(file) ? projectAt(index, file) : null;
      if (p) votes.set(p.id, (votes.get(p.id) || 0) + n);
    }
    const ids = [...votes].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    list.push({...s, projects: ids.slice(0, 5)});
  }
  return list.sort((a, b) => (b.end || b.start).localeCompare(a.end || a.start));
}
export const sessionsOf = (list, id) => list.filter(s => s.projects.includes(id));
const plain = t => String(t || '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*|__|`+/g, '').replace(/^((Task|Background) \(from the session that started this one\):\s*)+/i, '').replace(/\s+/g, ' ').trim();
/** Title and outcome for display: the first request, or the outcome when the session has no written request. */
export function describeSession(s) {
  const title = plain(s.title || s.summary);
  return title ? {title, outcome: plain(s.outcome)} : {title: clip(plain(s.outcome), 120) || '(no prompt)', outcome: ''};
}
export function sessionLine(s, {project} = {}) {
  const when = (s.end || s.start).slice(0, 10);
  const edits = Object.keys(s.files || {}).length;
  const {title: head, outcome} = describeSession(s);
  const tailText = outcome ? ' → ' + clip(outcome, 140) : '';
  return `${when} · ${s.agent}${project ? ' · ' + project : ''}${edits ? ` · ${edits} file${edits === 1 ? '' : 's'}` : ''} · "${clip(head, 110)}"${tailText}`;
}

// ---- Token usage & cost -------------------------------------------------------------------------
// USD per million tokens: [input, output, cache read]. Cache writes are billed at 1.25× input.
// List prices of the Anthropic API; subscriptions (Pro/Max) are flat-rate, so treat these as API-equivalent value.
const PRICES = [
  // Anthropic (claude-*): [pattern, input, output, cache read]
  ['claude', /fable-5-2|mythos-5-2/, 8, 40, 0.2], ['claude', /fable-5|mythos-5/, 10, 50], ['claude', /opus-5-5/, 4, 20, 0.2], ['claude', /opus-5/, 5, 25],
  ['claude', /opus-4-[5-9]/, 5, 25], ['claude', /opus-4|opus-3|3-opus/, 15, 75], ['claude', /sonnet-5-5/, 2, 10, 0.1], ['claude', /sonnet-5/, 2, 10],
  ['claude', /sonnet|3-7|3-5-sonnet/, 3, 15], ['claude', /haiku-5-5/, 0.1, 0.5], ['claude', /haiku-4/, 1, 5], ['claude', /3-5-haiku|haiku-3-5/, 0.8, 4], ['claude', /haiku/, 0.25, 1.25],
  // OpenAI (Codex): GPT-6.2 Astra and Sol, list prices with cached input
  ['gpt', /^gpt-6\.2-astra/, 8, 40, 0.4], ['gpt', /^gpt-6\.2-sol/, 2, 10, 0.1],
];
let custom;
async function priceOf(model) {
  custom ??= await readJSON(state('prices.json'), {});
  const own = Object.entries(custom).find(([k]) => model.includes(k));
  if (own && Array.isArray(own[1])) return {in: own[1][0], out: own[1][1], cr: own[1][2] ?? own[1][0] * 0.1, cw: own[1][3] ?? own[1][0] * 1.25};
  const row = PRICES.find(([vendor, re]) => model.startsWith(vendor) && re.test(model));
  if (!row) return null;
  return {in: row[2], out: row[3], cr: row[4] ?? row[2] * 0.1, cw: row[2] * 1.25};
}
/** USD per million tokens for a model: {in, out, cr (cache read), cw (5-minute cache write)}, or null. */
export const rates = model => priceOf(model);
export async function costOf(model, u) {
  const p = await priceOf(model);
  return p ? ((u.in || 0) * p.in + (u.out || 0) * p.out + (u.cr || 0) * p.cr + (u.cw || 0) * p.cw) / 1e6 : null;
}

export async function usageData(list, {days = 30} = {}) {
  const since = day(Date.now() - (days - 1) * 86400e3);
  const out = {days: {}, models: {}, projects: {}, agents: {}, total: {in: 0, out: 0, cr: 0, cw: 0, usd: 0, unpriced: 0, sessions: 0}};
  for (const s of list) {
    const d = (s.start || '').slice(0, 10);
    if (!d || d < since) continue;
    out.total.sessions++;
    for (const [model, u] of Object.entries(s.usage || {})) {
      const usd = await costOf(model, u);
      const tok = (u.in || 0) + (u.out || 0) + (u.cr || 0) + (u.cw || 0);
      for (const [map, key] of [[out.days, d], [out.models, model], [out.agents, s.agent], [out.projects, s.projects[0] || '(no project)']]) {
        const row = map[key] ||= {in: 0, out: 0, cr: 0, cw: 0, tokens: 0, usd: 0, sessions: new Set()};
        row.in += u.in || 0; row.out += u.out || 0; row.cr += u.cr || 0; row.cw += u.cw || 0; row.tokens += tok; row.usd += usd || 0; row.sessions.add(s.sid);
      }
      out.total.in += u.in || 0; out.total.out += u.out || 0; out.total.cr += u.cr || 0; out.total.cw += u.cw || 0;
      if (usd == null) out.total.unpriced += tok; else out.total.usd += usd;
    }
  }
  for (const map of [out.days, out.models, out.projects, out.agents]) for (const row of Object.values(map)) row.sessions = row.sessions.size;
  out.tools = {}; out.images = 0;
  for (const s of list) {
    const d = (s.start || '').slice(0, 10);
    if (!d || d < since) continue;
    out.images += s.img || 0;
    for (const [name, chars] of Object.entries(s.out || {})) {
      if (name.startsWith('images:')) continue;
      const key = toolLabel(name);
      out.tools[key] = (out.tools[key] || 0) + Math.round(chars / 3.6);
    }
  }
  return out;
}

/** mcp__<server>__<tool> → short readable label. */
export function toolLabel(name) {
  const m = String(name).match(/^mcp__(.+?)__(.+)$/);
  if (!m) return name;
  const server = /^[0-9a-f-]{20,}$/i.test(m[1]) ? '' : m[1].replace(/^claude-in-chrome$/, 'chrome').replace(/^Claude_/, '') + ':';
  return 'mcp ' + server + m[2];
}
/** Friendly model names for reports: claude-opus-5-5 → Claude Opus 5.5, gpt-6.2-astra → GPT-6.2 Astra. */
export function modelLabel(id) {
  const c = String(id).match(/^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?(?:-\d{8})?$/);
  if (c) return `Claude ${c[1][0].toUpperCase() + c[1].slice(1)} ${c[2]}${c[3] ? '.' + c[3] : ''}`;
  const g = String(id).match(/^gpt-([\d.]+)(?:-(\w+))?$/i);
  if (g) return `GPT-${g[1]}${g[2] ? ' ' + g[2][0].toUpperCase() + g[2].slice(1) : ''}`;
  return id;
}

export async function usageReport(list, index, {days = 30, by = 'day'} = {}) {
  const u = await usageData(list, {days});
  const t = u.total;
  if (!t.sessions) return `No agent sessions in the last ${days} days. Run: leanbrain sessions --sync`;
  const names = new Map(index.projects.map(p => [p.id, p.name]));
  const usd = n => '$' + (n >= 100 ? fmt(n) : n.toFixed(2));
  const lines = [
    `Agent usage · last ${days} days · ${fmt(t.sessions)} sessions`,
    `Tokens: ${compact(t.in)} input · ${compact(t.cw)} cache write · ${compact(t.cr)} cache read · ${compact(t.out)} output`,
    `API-equivalent cost: ${usd(t.usd)}${t.unpriced ? ` (+${compact(t.unpriced)} tokens on models without a known price)` : ''}`,
    `Cache: ${t.cr + t.in + t.cw ? Math.round(100 * t.cr / (t.cr + t.in + t.cw)) : 0}% of input served from cache`,
  ];
  const table = (title, map, label = k => k, limit = 12) => {
    const rows = Object.entries(map).sort((a, b) => b[1].usd - a[1].usd || b[1].tokens - a[1].tokens).slice(0, limit);
    lines.push(title);
    for (const [k, r] of rows) lines.push(`  ${clip(label(k), 34).padEnd(34)} ${String(r.sessions).padStart(4)} sess  ${compact(r.tokens).padStart(7)} tok  ${usd(r.usd).padStart(9)}`);
  };
  if (by === 'day') {
    const rows = Object.entries(u.days).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14);
    lines.push('By day (newest first):');
    for (const [k, r] of rows) lines.push(`  ${k}  ${String(r.sessions).padStart(4)} sess  ${compact(r.tokens).padStart(7)} tok  ${usd(r.usd).padStart(9)}`);
    table('By project:', u.projects, k => names.get(k) || k, 8);
    table('By model:', u.models, modelLabel, 6);
  } else if (by === 'project') table('By project:', u.projects, k => names.get(k) || k, 30);
  else if (by === 'model') table('By model:', u.models, modelLabel);
  else if (by === 'tool') {
    const rows = Object.entries(u.tools).sort((a, b) => b[1] - a[1]);
    const text = rows.reduce((n, [, v]) => n + v, 0);
    const imageTokens = u.images * 1500;
    lines.push(`Tool output the model read: ≈${compact(text)} tokens of text + ${fmt(u.images)} images (≈${compact(imageTokens)} tokens at ~1.5k per screenshot)`);
    for (const [k, v] of rows.slice(0, 15)) lines.push(`  ${clip(k, 34).padEnd(34)} ${compact(v).padStart(7)} tok  ${String(Math.round(100 * v / (text || 1))).padStart(3)}%`);
    const bash = u.tools.Bash || 0, read = u.tools.Read || 0;
    lines.push('Biggest levers:');
    if (bash > text * 0.3) lines.push('  · Bash is the largest source: file printing (cat, sed -n) is trimmed by the LeanBrain guard; noisy commands go through `leanbrain run --`.');
    if (read > text * 0.08) lines.push('  · Large Read results: the guard answers first reads of big files with an outline and re-reads with stubs or diffs.');
    if (imageTokens > text * 0.2) lines.push('  · Screenshots: prefer page text or the accessibility tree when you do not need to see the layout.');
  }
  else if (by === 'agent') table('By agent:', u.agents);
  return lines.join('\n');
}

export const sessionFileCount = async () => Object.keys((await loadSessions()).files || {}).length;
export const homeDir = HOMEDIR;
export {inside};
