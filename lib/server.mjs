// Local dashboard: JSON API + static files, bound to 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ROOT, VERSION, loadIndex, pool, cliCommand, HOME, tilde} from './core.mjs';
import {tokens, ledger, record, PRICE, kindLabel} from './tokens.mjs';
import {context, packText, ctxText, activity, ranker, orientationCost, recallText, briefText} from './card.mjs';
import {sessionsOf, describeSession, modelLabel} from './sessions.mjs';
import {usageData, syncSessions} from './sessions.mjs';
import {mapText} from './code.mjs';
import {addNote, addTodo, closeTodo} from './memory.mjs';
import {status} from './install.mjs';
import {scan} from './scan.mjs';
import {readCatalog} from './catalog.mjs';

const run = promisify(execFile);
const ASSETS = new Map([
  ['/', ['dist/index.html', 'text/html']], ['/app.js', ['dist/app.js', 'text/javascript']], ['/style.css', ['dist/style.css', 'text/css']],
  ['/scene.js', ['dist/scene.js', 'text/javascript']], ['/core.jpg', ['dist/core.jpg', 'image/jpeg']], ['/icon.svg', ['dist/icon.svg', 'image/svg+xml']],
  ['/three.module.js', ['node_modules/three/build/three.module.js', 'text/javascript']], ['/three.core.js', ['node_modules/three/build/three.core.js', 'text/javascript']],
  ['/room.js', ['node_modules/three/examples/jsm/environments/RoomEnvironment.js', 'text/javascript']],
]);

let cache = {key: '', ctx: null, potential: null};
async function ctxCached() {
  const index = await loadIndex();
  const key = index.date + ':' + (await fs.stat(path.join(HOME, 'sessions.json')).then(s => s.mtimeMs, () => 0)) + ':' + (await fs.stat(path.join(HOME, 'notes.jsonl')).then(s => s.mtimeMs, () => 0)) + ':' + (await fs.stat(path.join(HOME, 'todos.json')).then(s => s.mtimeMs, () => 0));
  if (cache.key !== key) cache = {key, ctx: await context(), potential: cache.key.split(':')[0] === key.split(':')[0] ? cache.potential : null};
  return cache.ctx;
}
const slim = (p, ctx) => ({id: p.id, name: p.name, path: p.external ? '' : tilde(p.id), external: !!p.external, description: p.description || p.pkg?.description || p.py?.description || p.readme || '',
  stack: [...new Set([...(p.frameworks || []), ...Object.keys(p.langs || {}).slice(0, 2)])].slice(0, 5), types: p.types, size: p.size, count: p.count, generated: p.generated, small: p.small,
  activity: activity(p, ctx) || 0, status: p.brain?.status || '', url: p.brain?.url?.[0] || '', branch: p.git?.branch || '', remote: p.git?.remote || '',
  notes: ctx.notes.filter(n => n.id === p.id).length, todos: ctx.todos.filter(t => t.id === p.id && !t.done).length, sessions: sessionsOf(ctx.sessions, p.id).length});
const sessionView = (s, names) => ({sid: s.sid, agent: s.agent, start: s.start, end: s.end, ...describeSession(s), last: s.last || '',
  project: s.projects[0] || '', projectName: names.get(s.projects[0]) || '', files: Object.keys(s.files || {}).length, turns: s.turns, tools: s.tools});

/** Card vs. orientation cost for every project. Persisted per index date, computed once in the background. */
let measuring = null;
async function potential() {
  const ctx = await ctxCached();
  if (cache.potential) return cache.potential;
  const file = path.join(HOME, 'potential.json');
  const saved = await fs.readFile(file, 'utf8').then(JSON.parse, () => null);
  if (saved?.date === ctx.index.date) return (cache.potential = saved.rows);
  measuring ||= (async () => {
    const rows = await pool(ctx.index.projects, 8, async x => ({id: x.id, name: x.name, card: tokens(packText(x, ctx, 500)), base: await orientationCost(x, ctx)}));
    const {atomic} = await import('./core.mjs');
    await atomic(file, JSON.stringify({date: ctx.index.date, rows}));
    cache.potential = rows;
    return rows;
  })().finally(() => { measuring = null; });
  return measuring;
}

async function body(req, limit = 1 << 20) {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > limit) throw Error('Request too large.'); }
  return data ? JSON.parse(data) : {};
}

async function api(url, req) {
  const q = url.searchParams;
  const p = url.pathname;
  if (req.method === 'GET') {
    if (p === '/api/summary') {
      const ctx = await ctxCached();
      const names = new Map(ctx.index.projects.map(x => [x.id, x.name]));
      const usage = await usageData(ctx.sessions, {days: 30});
      const week = Date.now() - 7 * 86400e3;
      const ranked = ctx.index.projects.map(x => [x, activity(x, ctx)]).filter(([, t]) => t).sort((a, b) => b[1] - a[1]);
      return {version: VERSION, cli: cliCommand(), home: tilde(HOME), price: PRICE,
        index: {projects: ctx.index.projects.length, local: ctx.index.projects.filter(x => !x.external).length, roots: ctx.index.roots.length, date: ctx.index.date, source: ctx.index.source ? tilde(ctx.index.source) : '', bytes: ctx.index.bytes, files: ctx.index.count, skipped: ctx.index.skipped},
        memory: {sessions: ctx.sessions.length, synced: ctx.synced, notes: ctx.notes.length, todos: ctx.todos.filter(t => !t.done).length, activeWeek: ranked.filter(([, t]) => t > week).length},
        gain: await ledger(), usage: {total: usage.total, days: usage.days},
        recent: ctx.sessions.slice(0, 10).map(s => sessionView(s, names)),
        active: ranked.slice(0, 8).map(([x]) => slim(x, ctx)), status: await status()};
    }
    if (p === '/api/projects') { const ctx = await ctxCached(); return ctx.index.projects.map(x => slim(x, ctx)); }
    if (p === '/api/brief') { const ctx = await ctxCached(); return {text: await briefText(ctx, {here: '/'})}; }
    if (p === '/api/find') { const ctx = await ctxCached(); return ranker(ctx)(q.get('q') || '').slice(0, 60).map(h => h.p.id); }
    if (p === '/api/project') {
      const ctx = await ctxCached();
      const x = ctx.index.projects.find(y => y.id === q.get('id'));
      if (!x) throw Error('Unknown project.');
      const names = new Map(ctx.index.projects.map(y => [y.id, y.name]));
      const card = packText(x, ctx, 500);
      return {project: slim(x, ctx), card, cardTokens: tokens(card), baseline: await orientationCost(x, ctx), full: ctxText(x, ctx),
        sessions: sessionsOf(ctx.sessions, x.id).slice(0, 20).map(s => sessionView(s, names)),
        notes: ctx.notes.filter(n => n.id === x.id).slice(-30).reverse(), todos: ctx.todos.filter(t => t.id === x.id)};
    }
    if (p === '/api/map') {
      const ctx = await ctxCached();
      const x = ctx.index.projects.find(y => y.id === q.get('id'));
      if (!x || x.external) throw Error('No local folder for this project.');
      return {text: await mapText(x, {budget: Number(q.get('budget')) || 1500, record: false})};
    }
    if (p === '/api/sessions') {
      const ctx = await ctxCached();
      const names = new Map(ctx.index.projects.map(y => [y.id, y.name]));
      const agent = q.get('agent');
      return ctx.sessions.filter(s => !agent || s.agent === agent).slice(0, Number(q.get('limit')) || 200).map(s => sessionView(s, names));
    }
    if (p === '/api/insights') {
      const ctx = await ctxCached();
      const ins = await import('./insights.mjs');
      const names = new Map(ctx.index.projects.map(y => [y.id, y.name]));
      const since = Date.now() - 60 * 60e3;
      return {pause: await ins.pauseData(ctx.sessions, {days: 30}), immunity: await ins.loadImmunity(),
        active: ctx.sessions.filter(s => Date.parse(s.end || s.start) > since).slice(0, 12).map(s => sessionView(s, names))};
    }
    if (p === '/api/dejavu') {
      const ctx = await ctxCached();
      const ins = await import('./insights.mjs');
      return ins.dejaVu(q.get('q') || '', ctx, {limit: 6});
    }
    if (p === '/api/recall') { const ctx = await ctxCached(); return {text: recallText(q.get('q') || '', ctx, {limit: 30})}; }
    if (p === '/api/usage') {
      const ctx = await ctxCached();
      const u = await usageData(ctx.sessions, {days: Math.min(365, Number(q.get('days')) || 30)});
      const names = new Map(ctx.index.projects.map(y => [y.id, y.name]));
      u.projects = Object.fromEntries(Object.entries(u.projects).map(([k, v]) => [names.get(k) || k, v]));
      u.models = Object.fromEntries(Object.entries(u.models).map(([k, v]) => [modelLabel(k), v]));
      return u;
    }
    if (p === '/api/gain') { const g = await ledger(); g.labels = Object.fromEntries(Object.keys(g.kinds).map(k => [k, kindLabel(k)])); return g; }
    if (p === '/api/potential') return potential();
    if (p === '/api/disk') {
      const ctx = await ctxCached();
      return {large: ctx.index.large.slice(0, 400), folders: ctx.index.folders || [],
        generated: ctx.index.projects.filter(x => x.generated > 0).sort((a, b) => b.generated - a.generated).slice(0, 200).map(x => ({id: x.id, name: x.name, path: tilde(x.id), generated: x.generated, size: x.size})),
        roots: ctx.index.roots, source: ctx.index.source || ''};
    }
  }
  if (req.method === 'POST') {
    if (req.headers['x-leanbrain'] !== '1') throw Error('Missing header.');
    if (p === '/api/scan') {
      const index = await loadIndex();
      const catalog = index.source ? await readCatalog(index.source) : null;
      await scan([...(catalog?.roots || index.roots), ...(catalog ? index.extra || [] : [])], catalog, {extra: index.extra});
      cache.key = '';
      return {ok: true};
    }
    if (p === '/api/sync') { const r = await syncSessions({index: await loadIndex()}); cache.key = ''; return r; }
    if (p === '/api/roots') {
      const roots = await body(req);
      if (!Array.isArray(roots) || !roots.length || roots.some(r => typeof r !== 'string' || !path.isAbsolute(r))) throw Error('One absolute path per line.');
      await scan(roots); cache.key = '';
      return {ok: true};
    }
    if (p === '/api/copied') {
      const {id, kind = 'pack', text = ''} = await body(req);
      const ctx = await ctxCached();
      const x = ctx.index.projects.find(y => y.id === id);
      if (x) await record(kind, kind === 'pack' ? await orientationCost(x, ctx) : tokens(text) * 10, tokens(text), x.id);
      return {ok: true};
    }
    if (p === '/api/note') {
      const {id, text} = await body(req);
      const ctx = await ctxCached();
      const x = ctx.index.projects.find(y => y.id === id);
      if (!x) throw Error('Unknown project.');
      await addNote(x, text); cache.key = '';
      return {ok: true};
    }
    if (p === '/api/todo') {
      const {id, text, done} = await body(req);
      if (done) await closeTodo(done);
      else {
        const ctx = await ctxCached();
        const x = ctx.index.projects.find(y => y.id === id);
        if (!x) throw Error('Unknown project.');
        await addTodo(x, text);
      }
      cache.key = '';
      return {ok: true};
    }
    if (p === '/api/trash') {
      const {file} = await body(req);
      const index = await loadIndex();
      const item = index.large.find(f => f.path === file);
      if (!item || await fs.realpath(file) !== file) throw Error('Rescan first.');
      const st = await fs.lstat(file);
      if (!st.isFile() || st.ino !== item.ino || st.mtimeMs !== item.modified || st.size !== item.size) throw Error('The file changed. Rescan first.');
      if (process.platform === 'darwin') await run('osascript', ['-l', 'JavaScript', '-e', `ObjC.import('Foundation');function run(a){const u=$.NSURL.fileURLWithPath(a[0]);const e=Ref();if(!$.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError(u,null,e))throw Error(ObjC.unwrap(e[0].localizedDescription));}`, file]);
      else if (process.platform === 'linux') await run('gio', ['trash', file]);
      else throw Error('Trash is available on macOS and on Linux with gio.');
      index.large = index.large.filter(f => f.path !== file);
      const {atomic, state} = await import('./core.mjs');
      await atomic(state('index.json'), JSON.stringify(index));
      cache.key = '';
      return {ok: true};
    }
  }
  return undefined;
}

export async function serve({port = Number(process.env.PORT) || 4317, open = false} = {}) {
  const server = http.createServer(async (req, res) => {
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(req.headers.host) || (req.headers.origin && !hosts.some(h => req.headers.origin === 'http://' + h))) { res.writeHead(403).end(); return; }
    const url = new URL(req.url, 'http://' + req.headers.host);
    try {
      if (url.pathname.startsWith('/api/')) {
        const data = await api(url, req);
        if (data === undefined) { res.writeHead(404).end(); return; }
        res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
        res.end(JSON.stringify(data));
        return;
      }
      const asset = ASSETS.get(url.pathname);
      if (!asset || req.method !== 'GET') { res.writeHead(404).end(); return; }
      res.writeHead(200, {'Content-Type': asset[1] + (asset[1].startsWith('image/jp') ? '' : '; charset=utf-8'), 'X-Content-Type-Options': 'nosniff'});
      res.end(await fs.readFile(path.join(ROOT, asset[0])));
    } catch (e) { res.writeHead(400, {'Content-Type': 'text/plain; charset=utf-8'}).end(e.message); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = `http://127.0.0.1:${port}`;
  console.log(`LeanBrain dashboard: ${address}`);
  setTimeout(() => potential().catch(() => {}), 1500).unref();
  if (open) run(process.platform === 'darwin' ? 'open' : 'xdg-open', [address]).catch(() => {});
  return server;
}
