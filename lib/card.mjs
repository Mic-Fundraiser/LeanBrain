// Project cards and workspace digests: the smallest text that orients an agent.
import fs from 'node:fs/promises';
import path from 'node:path';
import {tilde, clip, ago, compact, cliCommand, loadIndex, readJSON, state} from './core.mjs';
import {tokens, ledger, PRICE} from './tokens.mjs';
import {createIndex} from './search.mjs';
import {notes as loadNotes, openTodos, todos as loadTodos} from './memory.mjs';
import {loadSessions, attribute, sessionsOf, sessionLine} from './sessions.mjs';

/** Everything the cards need, loaded once per command. */
export async function context() {
  const [index, notes, todos, db] = await Promise.all([loadIndex(), loadNotes(), loadTodos(), loadSessions()]);
  const sessions = attribute(db, index);
  return {index, notes, todos, sessions, synced: db.synced};
}

export function activity(p, ctx) {
  let t = p.mtime || 0;
  for (const n of ctx.notes) if (n.id === p.id) t = Math.max(t, Date.parse(n.date) || 0);
  const s = sessionsOf(ctx.sessions, p.id)[0];
  if (s) t = Math.max(t, Date.parse(s.end || s.start) || 0);
  return t;
}

export function ranker(ctx) {
  const notesBy = group(ctx.notes, n => n.id);
  const titlesBy = new Map();
  for (const s of ctx.sessions) for (const id of s.projects) {
    const list = titlesBy.get(id) || [];
    if (list.length < 12) list.push(s.title, s.summary);
    titlesBy.set(id, list);
  }
  const now = Date.now();
  const search = createIndex(ctx.index.projects.map(p => {
    const age = (now - activity(p, ctx)) / 86400e3;
    return {item: p, boost: age < 30 ? 1 + 0.25 * (1 - age / 30) : 1, fields: [
      [p.name, 4], [path.basename(p.id), 3], [p.id.split(/[\\/]/).slice(-4, -1).join(' '), 0.8], [p.brainId, 2],
      [p.description, 2], [p.readme, 1], [p.pkg?.description, 1.5], [p.py?.description, 1.5], [p.stack, 1],
      [(p.types || []).join(' '), 0.8], [(p.frameworks || []).join(' '), 1.2], [Object.keys(p.langs || {}).join(' '), 0.5],
      [p.brain?.area, 1], [(p.brain?.url || []).join(' '), 1], [(notesBy.get(p.id) || []).map(n => n.text).join(' '), 1.2],
      [(titlesBy.get(p.id) || []).filter(Boolean).join(' '), 0.7],
    ]};
  }));
  return query => search(query).map(r => ({p: r.item, score: r.score, complete: r.complete}));
}
const group = (rows, key) => {
  const map = new Map();
  for (const row of rows) { const k = key(row); map.set(k, [...(map.get(k) || []), row]); }
  return map;
};

function stackLine(p) {
  const langs = Object.entries(p.langs || {});
  const total = langs.reduce((n, [, c]) => n + c, 0);
  const share = langs.slice(0, 3).map(([l, c]) => `${l} ${Math.round(100 * c / total)}%`).join(', ');
  const parts = [(p.frameworks || []).join(', ') || (p.stack ? clip(p.stack, 90) : ''), share,
    (p.types || []).filter(t => !['Git', 'Project', 'Catalogue'].includes(t)).join('/')].filter(Boolean);
  return parts.length ? 'Stack: ' + [...new Set(parts)].join(' · ') : '';
}
function runLine(p) {
  const parts = [];
  const scripts = Object.keys(p.pkg?.scripts || {});
  const preferred = ['dev', 'start', 'serve', 'build', 'test', 'lint', 'deploy'];
  const shown = [...preferred.filter(s => scripts.includes(s)), ...scripts.filter(s => !preferred.includes(s))].slice(0, 6);
  if (shown.length) parts.push('npm run ' + shown.join('|'));
  if (p.py?.scripts?.length) parts.push('py: ' + p.py.scripts.slice(0, 4).join('|'));
  if (p.compose?.length) parts.push('compose: ' + p.compose.slice(0, 4).join('; '));
  if (p.make?.length) parts.push('make ' + p.make.slice(0, 5).join('|'));
  if (p.pkg?.bin?.length) parts.push('bin: ' + p.pkg.bin.join(', '));
  if (p.brain?.port) parts.push('local port ' + p.brain.port);
  return parts.length ? 'Run: ' + parts.join(' · ') : '';
}
function gitLine(p) {
  const g = p.git;
  if (!g) return '';
  const c = g.commit ? `${ago(g.commit.date)} ago ${g.commit.sha} "${clip(g.commit.msg, 70)}"` : '';
  return 'Git: ' + [g.branch, c, g.remote].filter(Boolean).join(' · ');
}
function liveLines(p) {
  const b = p.brain;
  if (!b) return [];
  const live = [b.status, (b.url || []).slice(0, 2).join(' '), b.server && 'server ' + b.server + (b.serverPath ? ` (${clip(b.serverPath, 60)}${b.serverPort ? ' :' + b.serverPort : ''})` : '')].filter(Boolean);
  const out = [];
  if (live.length) out.push('Live: ' + live.join(' · '));
  if (b.deploy) out.push('Deploy: ' + clip(b.deploy, 180));
  if (b.dependsOn?.length) out.push('Depends on: ' + b.dependsOn.join(', '));
  return out;
}

/** Budgeted card. Sections are added in priority order until the token budget is reached. */
export function packText(p, ctx, budget = 500) {
  const notes = ctx.notes.filter(n => n.id === p.id).slice(-6).reverse();
  const todos = ctx.todos.filter(t => t.id === p.id && !t.done);
  const sessions = sessionsOf(ctx.sessions, p.id).slice(0, 4);
  const open = p.brain?.open || [];
  const what = p.description || p.pkg?.description || p.py?.description || p.readme;
  const sections = [
    [`# ${p.name} — ${p.external ? 'catalogue only (no local folder)' : tilde(p.id)}`],
    [what && clip(what, 320)],
    [stackLine(p)], [runLine(p)], liveLines(p), [gitLine(p)],
    todos.length || open.length ? ['Open:', ...todos.slice(0, 4).map(t => `- #${t.n} ${clip(t.text, 140)}`), ...open.slice(0, 3).map(o => '- ' + clip(o, 140))] : [],
    notes.length ? ['Notes:', ...notes.map(n => `- ${n.date.slice(0, 10)} ${clip(n.text, 200)}`)] : [],
    sessions.length ? ['Recent sessions:', ...sessions.map(s => '- ' + sessionLine(s))] : [],
    [p.guides?.length ? 'Guides: ' + p.guides.join(', ') : ''],
  ].map(lines => lines.filter(Boolean)).filter(lines => lines.length);
  const out = [];
  let used = 0;
  for (const lines of sections) {
    let block = lines.join('\n');
    let cost = tokens(block) + 1;
    while (used + cost > budget && lines.length > 2) { lines.splice(-1, 1); block = lines.join('\n'); cost = tokens(block) + 1; }
    if (used + cost > budget) {
      if (out.length < 2) { const room = Math.max(20, (budget - used) * 3); out.push(clip(block, room)); used = budget; }
      continue;
    }
    out.push(block); used += cost;
  }
  return out.join('\n');
}

/** Everything known about a project, without a budget. */
export function ctxText(p, ctx) {
  const lines = packText(p, {...ctx, notes: [], sessions: []}, 1e9).split('\n');
  const scripts = Object.entries(p.pkg?.scripts || {}).map(([k, v]) => `  ${k}: ${v}`);
  if (scripts.length) lines.push('Scripts:', ...scripts);
  if (p.readme && p.description) lines.push('README: ' + p.readme);
  if (p.brain) lines.push('Catalogue: ' + JSON.stringify(p.brain));
  lines.push(`Size: ${compact(p.size)}B in ${compact(p.count)} files (${compact(p.generated)}B dependencies/build) · ${p.small} files under 4 KiB`);
  const children = ctx.index.projects.filter(c => c.parent === p.id).map(c => c.name);
  if (children.length) lines.push('Nested projects: ' + children.join(', '));
  if (p.parent) lines.push('Inside: ' + tilde(p.parent));
  const notes = ctx.notes.filter(n => n.id === p.id).slice(-20).reverse();
  if (notes.length) lines.push('Notes:', ...notes.map(n => `- ${n.date.slice(0, 10)} ${n.text}`));
  const done = ctx.todos.filter(t => t.id === p.id && t.done).slice(-5);
  if (done.length) lines.push('Recently closed:', ...done.map(t => `- #${t.n} ${t.text}`));
  const sessions = sessionsOf(ctx.sessions, p.id).slice(0, 10);
  if (sessions.length) lines.push('Sessions:', ...sessions.map(s => '- ' + sessionLine(s) + (Object.keys(s.files).length ? '\n    edited: ' + Object.keys(s.files).slice(0, 6).map(f => tilde(f)).join(', ') : '')));
  return lines.join('\n');
}

/** What an agent would typically read to get oriented without LeanBrain: guides, manifests, a listing. */
export async function orientationCost(p, ctx) {
  if (p.external) return tokens(ctxText(p, ctx));
  let total = 0;
  const files = [...new Set([...(p.guides || []), 'package.json', 'pyproject.toml'])];
  for (const name of files) {
    try {
      const stat = await fs.stat(path.join(p.id, name));
      if (stat.isFile() && stat.size < 400_000) total += tokens(await fs.readFile(path.join(p.id, name), 'utf8'));
    } catch {}
  }
  try { total += tokens((await fs.readdir(p.id)).join('\n')); } catch {}
  return Math.max(total, tokens(ctxText(p, ctx)));
}

export async function briefText(ctx, {here = process.cwd()} = {}) {
  const {index} = ctx;
  const cli = cliCommand();
  if (!index.projects.length) return `LeanBrain: no index yet. Run: ${cli} scan <folder> [more folders]   (or: ${cli} cervello ~/cervello)`;
  const lines = [];
  const age = index.date ? ago(index.date) : '';
  const open = ctx.todos.filter(t => !t.done);
  lines.push(`LeanBrain · ${index.projects.length} projects · index ${!age ? 'date unknown' : age === 'now' ? 'fresh' : age + ' old'} · ${ctx.sessions.length} sessions remembered${open.length ? ` · ${open.length} open todos` : ''}`);
  const p = index.projects.filter(x => !x.external).reduce((best, x) => here === x.id || here.startsWith(x.id + path.sep) ? (!best || x.id.length > best.id.length ? x : best) : best, null);
  if (p) {
    const last = sessionsOf(ctx.sessions, p.id)[0];
    const what = p.description || p.pkg?.description || p.readme;
    lines.push(`Here: ${p.name}${what ? ' — ' + clip(what, 90) : ''}`);
    if (last) lines.push('Last time: ' + sessionLine(last));
    const note = ctx.notes.filter(n => n.id === p.id).at(-1);
    if (note) lines.push(`Latest note: ${note.date.slice(0, 10)} ${clip(note.text, 140)}`);
  }
  const recent = index.projects.map(x => [x, activity(x, ctx)]).filter(([x, t]) => t && x !== p).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (recent.length) lines.push('Active: ' + recent.map(([x, t]) => `${x.name} ${ago(t)}`).join(' · '));
  if (open.length) lines.push('Todos: ' + open.slice(-3).reverse().map(t => `#${t.n} ${clip(t.text, 60)}`).join(' · '));
  const gain = await ledger();
  if (gain.uses) lines.push(`Saved so far: ${compact(gain.saved)} tokens (−${Math.round(100 * gain.saved / gain.full)}%) ≈ $${gain.usd.toFixed(2)} at $${PRICE}/M`);
  lines.push(`Use: ${cli} pack <project|.> · find <words> · map . · grep <regex> · read <file> --chat <id> · run -- <cmd> · recall <words> · note . "<fact>"`);
  return lines.join('\n');
}

export function findText(query, ctx, {limit = 10} = {}) {
  const hits = ranker(ctx)(query).slice(0, limit);
  if (!hits.length) return `No project matches "${query}". Try fewer or different words.`;
  const lines = [`${hits.length} match${hits.length > 1 ? 'es' : ''} for "${query}"`];
  hits.forEach(({p}, i) => {
    const t = activity(p, ctx);
    const what = p.description || p.pkg?.description || p.readme || '';
    lines.push(`${i + 1}. ${p.name} — ${p.external ? 'catalogue' : tilde(p.id)}${t ? ' · ' + ago(t) : ''}${p.brain?.status ? ' · ' + p.brain.status : ''}${what ? ' · ' + clip(what, 70) : ''}`);
  });
  lines.push('Next: pack <name> for the card.');
  return lines.join('\n');
}

export function recallText(query, ctx, {project, limit = 12} = {}) {
  const names = new Map(ctx.index.projects.map(p => [p.id, p.name]));
  const docs = [];
  for (const n of ctx.notes) if (!project || n.id === project.id) docs.push({item: {date: n.date, line: `${n.date.slice(0, 10)} · note · ${names.get(n.id) || tilde(n.id)} · ${clip(n.text, 220)}`}, fields: [[n.text, 2], [names.get(n.id), 1]]});
  for (const t of ctx.todos) if (!project || t.id === project.id) docs.push({item: {date: t.date, line: `${t.date.slice(0, 10)} · todo #${t.n}${t.done ? ' (done)' : ''} · ${names.get(t.id) || tilde(t.id)} · ${clip(t.text, 200)}`}, fields: [[t.text, 2], [names.get(t.id), 1]]});
  for (const s of ctx.sessions) if (!project || s.projects.includes(project.id)) {
    const files = Object.keys(s.files || {}).map(f => path.basename(f)).join(' ');
    docs.push({item: {date: s.end || s.start, line: sessionLine(s, {project: names.get(s.projects[0]) || ''})},
      fields: [[s.title, 2], [s.last, 1.5], [s.summary, 1.5], [s.outcome, 1.2], [files, 0.8], [s.projects.map(id => names.get(id)).join(' '), 1]]});
  }
  const hits = createIndex(docs)(query, {limit});
  if (!hits.length) return `Nothing remembered about "${query}"${project ? ' in ' + project.name : ''}.`;
  return [`Memory · ${hits.length} hits for "${query}"${project ? ' in ' + project.name : ''}`, ...hits.map(h => h.item.line)].join('\n');
}

export function recentText(ctx, {limit = 15} = {}) {
  const rows = ctx.index.projects.map(p => [p, activity(p, ctx)]).filter(([, t]) => t).sort((a, b) => b[1] - a[1]).slice(0, limit);
  return rows.map(([p, t]) => `${ago(t).padStart(4)} · ${p.name} — ${p.external ? 'catalogue' : tilde(p.id)}`).join('\n') || 'No activity recorded yet.';
}

export const indexAge = async () => (await readJSON(state('index.json'), {})).date;
export {openTodos};
