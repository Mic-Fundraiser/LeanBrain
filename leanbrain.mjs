#!/usr/bin/env node
// LeanBrain — the lean second brain for coding agents.
import os from 'node:os';
import path from 'node:path';
import {initState, parseArgs, loadIndex, VERSION, NAME, cliCommand, HOME, tilde, ago} from './lib/core.mjs';

const HELP = `${NAME} ${VERSION} — project memory and lean context for Claude Code, Codex and Gemini CLI

Orient
  brief                        Digest: project here, last session, active projects, todos, savings
  find <words>                 Rank projects (name, path, stack, notes, past sessions; typo tolerant)
  pack [project]               Card in ≤500 tokens: purpose, stack, run/deploy, git, notes, sessions  [--budget N]
  focus <words>                find + pack of the best match
  ctx [project]                Everything known about a project
  recent                       Projects by latest activity

Code (project defaults to the current folder)
  map [project]                Ranked files with their symbols  [--path sub] [--budget N]
  sym <name>                   Where a function/class is defined  [--in project] [--all]
  grep <regex>                 Matches grouped by file  [--in p] [--glob "*.ts,src/**"] [--fixed] [--context N]
  read <file>                  Outline for big files, diff on re-read  [--chat id] [--range a:b] [--full]
  run -- <command>             Run and compress output (failures + summary), exit code preserved
  show <run-id>                Page the raw log of a run  [--range a:b] [--grep regex]
  filter                       Compress text from stdin

Memory
  note [project] <text>        Save a durable fact (no secrets)       unnote <project> <match>
  todo [project] [text]        Add or list open threads  [--done N]
  recall <words>               Search notes, todos and past agent sessions  [--in project]
  sessions [--sync]            Recent sessions of Claude Code, Codex, Gemini  [--in project]
  usage                        Agent tokens and API-equivalent cost  [--days N] [--by day|project|model|agent|tool]
  audit                        Fixed context every model call re-reads (instructions, skills, hooks)
  pauses                       Pause tax: prompt-cache rebuilds after idle pauses, and whether a 1-hour cache pays
  immunity                     Commands and flags that keep failing on this machine (blocked by the guard)
  dejavu <request>             Past sessions, in any project or agent, that solved something similar
  radar                        Other agent sessions active now, and the files they touched
  gain                         Tokens saved by LeanBrain

Setup
  scan [folders…]              Index folders (adds to the saved selection; --reset replaces it)
  catalog <path>               Index from a project catalogue (dati/progetti.json)
  install [--guard] [--mcp]    Rule in CLAUDE.md, AGENTS.md, GEMINI.md · --guard: Claude Code hooks that trim reads
                               automatically and inject the brief · --mcp: native tools · --all: everything
  uninstall [--guard] [--mcp]  Remove them (--all for everything)
  status                       Integration and index health
  serve                        Dashboard on http://127.0.0.1:4317
  mcp                          MCP server on stdio
`;

const SPEC = {budget: 'number', path: 'string', in: 'string', all: 'bool', glob: 'string', fixed: 'bool', 'ignore-case': 'bool',
  context: 'number', 'per-file': 'number', range: 'string', full: 'bool', chat: 'string', numbers: 'bool', grep: 'string',
  done: 'number', sync: 'bool', quiet: 'bool', limit: 'number', days: 'number', by: 'string', hook: 'bool', mcp: 'bool',
  port: 'number', open: 'bool', catalog: 'string', shell: 'bool', reset: 'bool', guard: 'bool'};

async function main(argv) {
  const [command = 'brief', ...rest] = argv;
  if (['help', '--help', '-h'].includes(command)) return HELP;
  if (['version', '--version', '-v'].includes(command)) return VERSION;
  await initState();
  if (command === 'hook') return hook(rest[0]);
  cmd = await import('./lib/commands.mjs');
  if (command === 'run') {
    const dash = rest.indexOf('--');
    const flags = parseArgs(dash < 0 ? [] : rest.slice(0, dash), SPEC);
    const {runCommand} = await import('./lib/compress.mjs');
    const r = await runCommand(dash < 0 ? rest : rest.slice(dash + 1), {budget: flags.budget || 1500, shell: flags.shell});
    process.exitCode = r.code;
    return r.text;
  }
  const a = parseArgs(rest, SPEC);
  const words = a._.join(' ');
  switch (command) {
    case 'brief': return cmd.brief({hook: a.hook});
    case 'find': return cmd.find(words);
    case 'focus': return cmd.focus(words, {budget: a.budget});
    case 'pack': return cmd.pack(a._[0], {budget: a.budget || 500});
    case 'ctx': return cmd.ctx(a._[0]);
    case 'recent': return cmd.recent({limit: a.limit || 15});
    case 'map': return cmd.map(a._[0], {path: a.path, budget: a.budget || 1200});
    case 'sym': return cmd.sym(a._[0], {in: a.in, all: a.all});
    case 'grep': return cmd.grep(a._[0], {in: a.in, glob: a.glob, fixed: a.fixed, ignoreCase: a['ignore-case'] || undefined, context: a.context || 0, perFile: a['per-file'] || 6, budget: a.budget || 900});
    case 'read': return cmd.read(a._[0], {in: a.in, range: a.range, full: a.full, chat: a.chat, numbers: a.numbers});
    case 'excerpt': return cmd.excerpt(a._[0], a._[1], a._[2], a._[3]);
    case 'show': { const {showRun} = await import('./lib/compress.mjs'); return showRun(a._[0], {range: a.range, grep: a.grep}); }
    case 'filter': { const {filterStdin} = await import('./lib/compress.mjs'); return filterStdin({budget: a.budget || 1500}); }
    case 'note': case 'log': {
      if (!a._.length) throw Error('Usage: note [project] <text>');
      return a._.length === 1 ? cmd.note('.', a._[0]) : cmd.note(a._[0], a._.slice(1).join(' '));
    }
    case 'unnote': return cmd.unnote(a._[0], a._.slice(1).join(' '));
    case 'todo': return cmd.todo(a._[0], a._.slice(1).join(' '), {done: a.done});
    case 'recall': return cmd.recall(words, {in: a.in});
    case 'sessions': return cmd.sessions({in: a.in, sync: a.sync, quiet: a.quiet, limit: a.limit || 15});
    case 'usage': return cmd.usage({days: a.days || 30, by: a.by || 'day'});
    case 'gain': return cmd.gain({days: a.days || 14});
    case 'pauses': { const ins = await import('./lib/insights.mjs'); const s = await import('./lib/sessions.mjs'); return ins.pauseReport(s.attribute(await s.loadSessions(), await loadIndex()), {days: a.days || 30}); }
    case 'immunity': { const ins = await import('./lib/insights.mjs'); return ins.immunityText(await ins.loadImmunity()); }
    case 'dejavu': { const ins = await import('./lib/insights.mjs'); const {context} = await import('./lib/card.mjs'); const hits = ins.dejaVu(words, await context(), {limit: 5}); return hits.length ? hits.map(h => '- ' + h.line).join('\n') : 'No similar past session.'; }
    case 'radar': return radar();
    case 'audit': { const {auditText} = await import('./lib/audit.mjs'); return auditText({days: a.days || 30}); }
    case 'scan': case 'catalog': case 'cervello': return scan(command, a);
    case 'install': return install(a, true);
    case 'uninstall': return install(a, false);
    case 'status': case 'doctor': return status();
    case 'serve': { const {serve} = await import('./lib/server.mjs'); await serve({port: a.port, open: a.open}); return ''; }
    case 'mcp': { const {serveMcp} = await import('./lib/mcp.mjs'); await serveMcp(); return ''; }
    default: throw Error(`Unknown command "${command}". See: leanbrain help`);
  }
}

let cmd;

/** Claude Code hook entry point: JSON on stdin, JSON on stdout, never blocks the agent on errors. */
async function hook(event) {
  let raw = '';
  try {
    process.stdin.setEncoding('utf8');
    raw = await new Promise(resolve => {
      let data = '';
      const done = () => resolve(data);
      process.stdin.on('data', d => { data += d; });
      process.stdin.on('end', done);
      setTimeout(done, 3000).unref();
    });
    const {runHook} = await import('./lib/guard.mjs');
    const out = await runHook(event, raw);
    return out ? JSON.stringify(out) : '';
  } catch (e) {
    const {appendJSONL, state} = await import('./lib/core.mjs');
    await appendJSONL(state('guard-errors.jsonl'), {at: new Date().toISOString(), event, error: String(e?.stack || e).slice(0, 600)}).catch(() => {});
    return '';
  }
}

async function scan(command, a) {
  const {scan: run} = await import('./lib/scan.mjs');
  const {readCatalog} = await import('./lib/catalog.mjs');
  const index = await loadIndex();
  const progress = n => process.stderr.write(`\rScanning… ${n} folders`);
  const expand = p => path.resolve(p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
  let result;
  if (command === 'catalog' || command === 'cervello' || a.catalog !== undefined || (index.source && !a.reset)) {
    // Catalogue mode: the catalogue decides the roots; folders passed to scan are kept as extra roots.
    const fresh = command === 'catalog' || command === 'cervello';
    const source = fresh ? expand(a._[0] || '~/cervello') : (a.catalog ? expand(a.catalog) : index.source);
    const extra = fresh ? (index.extra || []) : [...new Set([...(index.extra || []), ...a._.map(expand)])];
    const catalog = await readCatalog(source);
    result = await run([...catalog.roots, ...extra], catalog, {onProgress: progress, extra});
  } else {
    // Manual mode: folders are added to the saved selection; --reset replaces it.
    const roots = a.reset ? a._.map(expand) : [...new Set([...(index.roots || []), ...a._.map(expand)])];
    result = await run(roots, null, {onProgress: progress});
  }
  process.stderr.write('\r\x1b[K');
  const local = result.projects.filter(p => !p.external).length;
  const sync = await cmd.syncSessions({index: result}).catch(() => null);
  return `Indexed ${result.projects.length} projects (${local} local) in ${result.roots.length} folders · ${result.count.toLocaleString('en-US')} files${sync?.sessions ? ` · ${sync.sessions} agent sessions remembered` : ''}.\nNext: ${cliCommand()} brief`;
}

async function install(a, on) {
  const inst = await import('./lib/install.mjs');
  const lines = [];
  if (on) {
    const files = await inst.installRules();
    lines.push(files.length ? 'Rule updated in: ' + files.map(tilde).join(', ') : 'Rules already up to date.');
    if (a.mcp || a.all) lines.push(...await inst.installMcp());
    if (a.hook || a.guard || a.all) lines.push(await inst.installHook() ? 'Guard on: Claude Code hooks for Read/Bash, session start, prompts and compaction.' : 'Guard already on.');
    if (!a.mcp && !a.hook && !a.guard && !a.all) lines.push('Optional: install --guard (automatic token guard in Claude Code) · install --mcp (native tools).');
  } else {
    if ((!a.mcp && !a.hook && !a.guard) || a.all) { const files = await inst.uninstallRules(); lines.push(files.length ? 'Rule removed from: ' + files.map(tilde).join(', ') : 'No rule found.'); }
    if (a.mcp || a.all) lines.push(...await inst.uninstallMcp());
    if (a.hook || a.guard || a.all) lines.push(await inst.uninstallHook() ? 'Guard hooks removed.' : 'No guard hooks found.');
  }
  return lines.join('\n');
}

async function radar() {
  const ins = await import('./lib/insights.mjs');
  const s = await import('./lib/sessions.mjs');
  const index = await loadIndex();
  const list = s.attribute(await s.loadSessions(), index);
  const a = await ins.loadActivity();
  const since = Date.now() - 60 * 60e3;
  const names = new Map(index.projects.map(p => [p.id, p.name]));
  const rows = list.filter(x => Date.parse(x.end || x.start) > since).map(x => `${ins.minutesAgo(Date.parse(x.end || x.start))} min ago · ${x.agent} · ${names.get(x.projects[0]) || 'no project'} · "${s.describeSession(x).title.slice(0, 80)}"${Object.keys(x.files || {}).length ? ' · edited ' + Object.keys(x.files).slice(0, 4).map(f => path.basename(f)).join(', ') : ''}`);
  const live = Object.entries(a.files).flatMap(([f, r]) => r.map(x => ({f, ...x}))).sort((x, y) => y.at - x.at).slice(0, 8).map(x => `${ins.minutesAgo(x.at)} min ago · ${tilde(x.f)}`);
  return [`Radar · sessions active in the last hour: ${rows.length}`, ...rows, live.length ? 'Latest edits seen by the guard:' : '', ...live].filter(Boolean).join('\n');
}

async function status() {
  const {status: read} = await import('./lib/install.mjs');
  const {loadSessions} = await import('./lib/sessions.mjs');
  const s = await read();
  const index = await loadIndex();
  const db = await loadSessions();
  const {ledger} = await import('./lib/tokens.mjs');
  const g = await ledger();
  const fsMod = await import('node:fs');
  const missing = (index.roots || []).filter(r => !fsMod.existsSync(r)).length;
  return [
    `${NAME} ${VERSION} · node ${process.versions.node} · data ${tilde(HOME)}`,
    `Index: ${index.projects.length} projects · ${index.roots.length} roots${missing ? ` (${missing} missing)` : ''} · ${index.date ? ago(index.date) + ' old' : 'never scanned'}${index.source ? ' · source ' + tilde(index.source) : ''}`,
    `Sessions: ${Object.keys(db.sessions || {}).length} remembered · synced ${db.synced ? ago(db.synced) + ' ago' : 'never'}`,
    `Rules: ${Object.entries(s.rules).map(([k, v]) => `${k} ${v}`).join(' · ')}`,
    `Guard (Claude Code hooks): ${s.hook ? 'on' : 'off'} · MCP: claude ${s.mcp.claude ? 'on' : 'off'} · codex ${s.mcp.codex ? 'on' : 'off'} · gemini ${s.mcp.gemini ? 'on' : 'off'}`,
    `Savings: ${g.uses} operations · ${g.saved.toLocaleString('en-US')} tokens saved`,
    `CLI: ${cliCommand()}`,
  ].join('\n');
}

main(process.argv.slice(2)).then(out => {
  if (out) process.stdout.write(String(out).replace(/\n?$/, '\n'));
}, e => {
  process.stderr.write((e?.message || String(e)) + '\n');
  process.exitCode = 1;
});
