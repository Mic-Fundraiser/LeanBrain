// Command implementations shared by the CLI, the MCP server and the dashboard. Each returns text.
import path from 'node:path';
import os from 'node:os';
import {loadIndex, resolveProject, projectAt, tilde, initState} from './core.mjs';
import {record, tokens, gainReport} from './tokens.mjs';
import {context, packText, ctxText, briefText, findText, recallText, recentText, ranker, orientationCost} from './card.mjs';
import {mapText, symText, grepText, readFileText, excerptText} from './code.mjs';
import {addNote, addTodo, closeTodo, openTodos, forget} from './memory.mjs';
import {syncSessions, syncInBackground, usageReport, attribute, loadSessions, sessionsOf, sessionLine} from './sessions.mjs';

export async function resolve(ctx, arg) {
  return resolveProject(ctx.index, arg, q => ranker(ctx)(q).filter(h => h.complete));
}

export async function brief({hook = false} = {}) {
  await initState();
  if (hook) await syncInBackground(15);
  return briefText(await context());
}

export async function find(query) {
  if (!query) throw Error('Usage: find <words>');
  return findText(query, await context());
}

export async function pack(arg, {budget = 500} = {}) {
  const ctx = await context();
  const p = await resolve(ctx, arg);
  const text = packText(p, ctx, budget);
  await record('pack', await orientationCost(p, ctx), tokens(text), p.id);
  return text;
}

export async function focus(words, {budget = 500} = {}) {
  if (!words) throw Error('Usage: focus <words>');
  const ctx = await context();
  const hits = ranker(ctx)(words);
  if (!hits.length) return `No project matches "${words}".`;
  const best = hits[0].p;
  const others = hits.slice(1, 4).map(h => `- ${h.p.name} — ${h.p.external ? 'catalogue' : tilde(h.p.id)}`);
  const text = packText(best, ctx, budget) + (others.length ? '\nAlso matching:\n' + others.join('\n') : '');
  await record('focus', await orientationCost(best, ctx) + tokens(others.join('\n')), tokens(text), best.id);
  return text;
}

export async function ctx(arg) {
  const c = await context();
  return ctxText(await resolve(c, arg), c);
}

export async function map(arg, {path: sub, budget = 1200} = {}) {
  const c = await context();
  const p = await resolve(c, arg);
  if (p.external) throw Error(`${p.name} has no local folder.`);
  return mapText(p, {sub, budget});
}

export async function sym(name, {in: where, all} = {}) {
  if (!name) throw Error('Usage: sym <name> [--in project] [--all]');
  const c = await context();
  const list = all ? c.index.projects.filter(p => !p.external) : [await resolve(c, where)];
  const text = await symText(name, list);
  return text;
}

export async function grep(pattern, opts = {}) {
  if (!pattern) throw Error('Usage: grep <regex> [--in project] [--glob "*.ts"] [--fixed] [--context N]');
  const c = await context();
  return grepText(pattern, await resolve(c, opts.in), opts);
}

export async function read(file, opts = {}) {
  if (!file) throw Error('Usage: read <file> [--in project] [--range a:b] [--full] [--chat id]');
  const c = await context();
  const abs = path.resolve(file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file);
  let p = null;
  if (opts.in) p = await resolve(c, opts.in);
  else p = projectAt(c.index, path.isAbsolute(file) || file.startsWith('~/') ? abs : process.cwd());
  return readFileText(p, opts.in ? file : (path.isAbsolute(file) || file.startsWith('~/') ? abs : file), opts);
}

export async function excerpt(arg, file, term, chat) {
  const c = await context();
  return excerptText(await resolve(c, arg), file, term, chat);
}

export async function recall(query, {in: where} = {}) {
  if (!query) throw Error('Usage: recall <words> [--in project]');
  const c = await context();
  const project = where ? await resolve(c, where) : null;
  return recallText(query, c, {project});
}

export async function note(arg, text) {
  const c = await context();
  const p = await resolve(c, arg);
  await addNote(p, text);
  return `Noted for ${p.name}.`;
}

export async function todo(arg, text, {done} = {}) {
  if (done) { const t = await closeTodo(done); return `Closed #${t.n}: ${t.text}`; }
  const c = await context();
  const p = arg ? await resolve(c, arg) : null;
  if (text) { const t = await addTodo(p || await resolve(c, '.'), text); return `Todo #${t.n} added.`; }
  const open = await openTodos(p?.id);
  if (!open.length) return 'No open todos' + (p ? ' for ' + p.name : '') + '.';
  const names = new Map(c.index.projects.map(x => [x.id, x.name]));
  return open.map(t => `#${t.n} ${names.get(t.id) || tilde(t.id)} · ${t.date.slice(0, 10)} · ${t.text}`).join('\n');
}

export async function unnote(arg, match) {
  const c = await context();
  const p = await resolve(c, arg);
  const n = await forget(p, match);
  return n ? `Removed ${n} note(s) from ${p.name}.` : 'No note matched.';
}

export async function sessions({in: where, sync, quiet, limit = 15} = {}) {
  const index = await loadIndex();
  if (sync) {
    const r = await syncSessions({index, onProgress: quiet ? null : (n, total, bytes) => process.stderr.write(`\rReading transcripts ${n}/${total} · ${Math.round(bytes / 1e6)} MB`)});
    if (!quiet) process.stderr.write('\n');
    if (r.busy) return 'Another sync is running.';
    if (quiet) return '';
    if (!where) return `Synced: ${r.read} transcript files read · ${r.sessions} sessions remembered.`;
  }
  const c = await context();
  const list = where ? sessionsOf(c.sessions, (await resolve(c, where)).id) : c.sessions;
  if (!list.length) return 'No sessions yet. Run: leanbrain sessions --sync';
  const names = new Map(c.index.projects.map(p => [p.id, p.name]));
  return list.slice(0, limit).map(s => sessionLine(s, {project: where ? '' : names.get(s.projects[0]) || ''})).join('\n');
}

export async function usage({days = 30, by = 'day'} = {}) {
  const index = await loadIndex();
  const list = attribute(await loadSessions(), index);
  return usageReport(list, index, {days, by});
}

export const gain = opts => gainReport(opts);
export async function recent({limit = 15} = {}) { return recentText(await context(), {limit}); }
export {syncSessions};
