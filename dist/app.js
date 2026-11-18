// LeanBrain dashboard. Plain ES modules, no framework: every view is a function that renders HTML.
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const fmt = n => new Intl.NumberFormat('en-US').format(Math.round(n || 0));
const compact = n => { n = Math.round(n || 0); const a = Math.abs(n); return a >= 1e9 ? (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B' : a >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : a >= 1e4 ? Math.round(n / 1e3) + 'k' : a >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k' : String(n); };
const money = n => '$' + (n >= 1000 ? fmt(n) : n >= 100 ? Math.round(n) : (n || 0).toFixed(2));
const bytes = (n = 0) => { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1000 && i < 4) { n /= 1000; i++; } return (Math.round(n * 10) / 10) + ' ' + u[i]; };
const ago = t => { t = typeof t === 'number' ? t : Date.parse(t); if (!t) return '—'; const s = (Date.now() - t) / 1000; return s < 90 ? 'now' : s < 3600 ? Math.round(s / 60) + 'm' : s < 129600 ? Math.round(s / 3600) + 'h' : s < 3888000 ? Math.round(s / 86400) + 'd' : s < 34560000 ? Math.round(s / 2592000) + 'mo' : Math.round(s / 31536000) + 'y'; };
const AGENT = {claude: 'C', codex: 'X', gemini: 'G'};
const since = t => { const a = ago(t); return a === 'now' ? 'just now' : a === '—' ? 'never' : a + ' ago'; };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const store = {summary: null, projects: null, view: 'overview', art: null};
async function get(url) { const r = await fetch(url, {cache: 'no-store'}); if (!r.ok) throw Error(await r.text()); return r.json(); }
async function post(url, data) { const r = await fetch(url, {method: 'POST', headers: {'X-LeanBrain': '1', 'Content-Type': 'application/json'}, body: JSON.stringify(data ?? {})}); if (!r.ok) throw Error(await r.text()); return r.json(); }
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2600); }
async function copy(text, msg = 'Copied') { try { await navigator.clipboard.writeText(text); toast(msg); } catch { toast('Copy failed: select the text manually'); } }
const status = msg => { $('#status').textContent = msg || ''; };

// ---------- Routing ----------
const VIEWS = {overview: renderOverview, projects: renderProjects, memory: renderMemory, insights: renderInsights, usage: renderUsage, savings: renderSavings, disk: renderDisk, setup: renderSetup};
const TITLES = {overview: 'Overview', projects: 'Projects', memory: 'Memory', insights: 'Insights', usage: 'Agent usage', savings: 'Savings', disk: 'Disk', setup: 'Setup'};
function route() {
  const [view = 'overview', query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const params = new URLSearchParams(query);
  if (!params.get('p')) $('#drawer').hidden = true;
  store.view = VIEWS[view] ? view : 'overview';
  $$('nav button').forEach(b => b.classList.toggle('active', b.dataset.view === store.view));
  $('#crumb').textContent = TITLES[store.view];
  document.title = TITLES[store.view] + ' · LeanBrain';
  VIEWS[store.view](params).catch(e => { $('#view').innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
  if (params.get('p')) openProject(params.get('p'), params.get('tab') || 'card');
}
const go = (view, params) => { location.hash = '#/' + view + (params ? '?' + new URLSearchParams(params) : ''); };
$$('nav button').forEach(b => b.onclick = () => go(b.dataset.view));
window.addEventListener('hashchange', route);

async function summary(force) { if (force || !store.summary) store.summary = await get('/api/summary'); return store.summary; }
async function projects(force) { if (force || !store.projects) store.projects = await get('/api/projects'); return store.projects; }
function freshness(s) {
  const parts = [`${fmt(s.index.projects)} projects`, s.index.date ? `indexed ${since(s.index.date)}` : 'not indexed', s.memory.synced ? `sessions synced ${since(s.memory.synced)}` : 'sessions never synced'];
  $('#freshness').textContent = parts.join(' · ');
}

// ---------- Overview ----------
function sparkBars(values) { const peak = Math.max(...values, 1); return values.map(v => `<i style="height:${Math.max(4, Math.round(100 * v / peak))}%"></i>`).join(''); }
const lastDays = (map, n, pick = v => v) => Array.from({length: n}, (_, i) => { const d = new Date(Date.now() - (n - 1 - i) * 864e5).toISOString().slice(0, 10); return pick(map?.[d]) || 0; });
function sessionItem(s) {
  return `<div class="feed-item" data-project="${esc(s.project)}" title="${esc(s.title)}">
    <span class="agent ${esc(s.agent)}" aria-label="${esc(s.agent)}">${AGENT[s.agent] || '?'}</span>
    <div><b>${esc(s.title || '(no prompt)')}</b><p>${s.projectName ? `<strong>${esc(s.projectName)}</strong> · ` : ''}${s.outcome ? '→ ' + esc(s.outcome) : esc(s.last || '')}</p></div>
    <span class="when">${ago(s.end || s.start)}${s.files ? `<br><span class="chip">${plural(s.files, 'file')}</span>` : ''}</span></div>`;
}
function bindFeed(root) { root.querySelectorAll('[data-project]').forEach(el => { if (el.dataset.project) el.onclick = () => openProject(el.dataset.project, 'sessions'); }); }
function projectCard(p) {
  return `<div class="pcard" data-id="${esc(p.id)}"><b>${esc(p.name)}</b><p>${esc(p.description || p.path)}</p>
    <div class="chips">${p.status ? `<span class="chip ok">${esc(p.status)}</span>` : ''}${p.stack.slice(0, 3).map(s => `<span class="chip">${esc(s)}</span>`).join('')}<span class="chip">${ago(p.activity)}</span></div></div>`;
}
function healthChecks(s) {
  const st = s.status, rules = Object.values(st.rules), ok = rules.every(r => r.startsWith('installed'));
  const indexOld = !s.index.date || Date.now() - Date.parse(s.index.date) > 7 * 864e5;
  const items = [
    [ok ? 'ok' : 'warn', 'Agent rules', ok ? 'CLAUDE.md · AGENTS.md · GEMINI.md' : 'Run install to update the rules'],
    [st.mcp.claude || st.mcp.codex ? 'ok' : 'warn', 'MCP tools', [st.mcp.claude && 'Claude', st.mcp.codex && 'Codex', st.mcp.gemini && 'Gemini'].filter(Boolean).join(' · ') || 'off · install --mcp'],
    [st.hook ? 'ok' : 'warn', 'Token guard', st.hook ? 'Claude Code hooks trim reads and inject the brief' : 'off · install --guard'],
    [indexOld ? 'warn' : 'ok', 'Index', s.index.date ? `updated ${since(s.index.date)}` : 'never'],
  ];
  return items.map(([k, t, d]) => `<div class="check"><span class="chip ${k}">${k === 'ok' ? '✓' : '!'}</span><div><b>${t}</b><div class="faint" style="font-size:12.5px">${esc(d)}</div></div></div>`).join('');
}
async function renderOverview() {
  const s = await summary();
  freshness(s);
  const g = s.gain, u = s.usage.total;
  const pct = g.full ? Math.round(1000 * g.saved / g.full) / 10 : 0;
  const cacheHit = u.cr + u.in + u.cw ? Math.round(100 * u.cr / (u.cr + u.in + u.cw)) : 0;
  $('#view').innerHTML = `
  <section class="hero">
    <div class="hero-copy">
      <span class="eyebrow">Local second brain for coding agents</span>
      <h1>Your agents never <em>start from zero.</em></h1>
      <p>${fmt(s.index.projects)} projects mapped, ${fmt(s.memory.sessions)} agent sessions remembered${g.saved ? ` and ${compact(g.saved)} tokens saved` : ''} — on this machine, for Claude Code, Codex and Gemini.</p>
      <div class="actions"><button class="primary" id="copyBrief">Copy agent brief</button><button id="toProjects">Browse projects</button></div>
    </div>
    <div id="artSlot"></div>
  </section>
  <div class="kpis">
    <button class="kpi accent" data-go="savings"><small>Tokens saved</small><strong>${compact(g.saved)}</strong><span>${pct ? `<span class="delta">−${pct}%</span> ` : ''}${g.uses ? `${fmt(g.uses)} lean operation${g.uses === 1 ? '' : 's'} · ≈ ${money(g.usd)}` : 'Starts with the first pack, map or read'}</span><div class="spark">${sparkBars(lastDays(g.days, 14))}</div></button>
    <button class="kpi" data-go="usage"><small>Agent usage · 30 days</small><strong>${money(u.usd)}</strong><span>${compact(u.in + u.cw + u.cr + u.out)} tokens · ${cacheHit}% cache hits</span><div class="spark">${sparkBars(lastDays(s.usage.days, 30, d => d?.usd))}</div></button>
    <button class="kpi" data-go="memory"><small>Memory</small><strong>${fmt(s.memory.sessions)}</strong><span>sessions · ${fmt(s.memory.notes)} notes · ${fmt(s.memory.todos)} open todos</span></button>
    <button class="kpi" data-go="projects"><small>Projects</small><strong>${fmt(s.index.projects)}</strong><span>${fmt(s.index.local)} local · ${fmt(s.memory.activeWeek)} active this week</span></button>
  </div>
  <div class="grid2">
    <section class="card"><h3>Pick up where you left off</h3><p class="sub">Latest agent sessions, with the request and how it ended.</p><div class="feed" id="recentFeed">${s.recent.map(sessionItem).join('') || '<div class="empty">No sessions yet: press “Sync sessions”.</div>'}</div></section>
    <div style="display:grid;gap:18px;align-content:start">
      <section class="card"><h3>Active projects</h3><p class="sub">Most recent activity: files, commits, sessions, notes.</p><div class="project-cards">${s.active.map(projectCard).join('')}</div></section>
      <section class="card"><h3>Health</h3><p class="sub">What your agents see at the start of a chat.</p><div class="checks">${healthChecks(s)}</div></section>
    </div>
  </div>`;
  mountArt();
  $('#copyBrief').onclick = async () => copy((await get('/api/brief')).text, 'Brief copied');
  $('#toProjects').onclick = () => go('projects');
  $$('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
  $$('.pcard').forEach(c => c.onclick = () => openProject(c.dataset.id));
  bindFeed($('#recentFeed'));
}
function mountArt() {
  const slot = $('#artSlot');
  if (!slot) return;
  if (!store.art) {
    store.art = document.createElement('div');
    store.art.className = 'core-art';
    store.art.innerHTML = `<label class="scene-choice" hidden><span>Sculpture</span><select id="sculpture" aria-label="3D sculpture"><option value="cache" selected>Circular memory</option><option value="prism">Token prism</option><option value="map">Project map</option><option value="original">Layered frames</option></select></label><button id="motion" aria-label="Animation">Ⅱ Pause</button><img src="/core.jpg" alt="" width="1100" height="733">`;
    slot.replaceWith(store.art);
    import('/scene.js').catch(() => store.art.classList.add('layer-fallback'));
  } else slot.replaceWith(store.art);
}

// ---------- Projects ----------
const FILTERS = {all: 'All', active: 'Active 30d', memory: 'With memory', live: 'Live', catalogue: 'Catalogue only'};
async function renderProjects(params) {
  const list = await projects();
  const q = params.get('q') || '';
  let filter = params.get('f') || 'all', sort = params.get('s') || 'activity', limit = 60;
  $('#view').innerHTML = `<div class="page-title"><h1>Projects</h1><p>Everything your agents can load in one call. Open a project to see the exact card an agent receives, its repo map, sessions and notes.</p></div>
  <div class="toolbar"><input id="pq" type="search" placeholder="Search by name, purpose, stack, notes or past sessions…" value="${esc(q)}">
    <div class="seg" id="pf">${Object.entries(FILTERS).map(([k, v]) => `<button data-f="${k}" aria-pressed="${k === filter}">${v}</button>`).join('')}</div>
    <div class="seg" id="ps"><button data-s="activity" aria-pressed="${sort === 'activity'}">Recent</button><button data-s="name" aria-pressed="${sort === 'name'}">Name</button><button data-s="size" aria-pressed="${sort === 'size'}">Size</button></div></div>
  <div class="card" style="padding:6px 8px"><table class="table"><thead><tr><th>Project</th><th class="hide-sm">Stack</th><th class="r">Activity</th><th class="r hide-sm">Memory</th><th class="r hide-sm">Size</th></tr></thead><tbody id="prows"></tbody></table><div class="more" id="pmore"></div></div>`;
  let ranked = null;
  const draw = () => {
    let rows = ranked ? ranked.map(id => list.find(p => p.id === id)).filter(Boolean) : list.slice();
    const month = Date.now() - 30 * 864e5;
    if (filter === 'active') rows = rows.filter(p => p.activity > month);
    if (filter === 'memory') rows = rows.filter(p => p.sessions || p.notes || p.todos);
    if (filter === 'live') rows = rows.filter(p => p.status || p.url);
    if (filter === 'catalogue') rows = rows.filter(p => p.external);
    if (!ranked) rows.sort(sort === 'name' ? (a, b) => a.name.localeCompare(b.name) : sort === 'size' ? (a, b) => b.size - a.size : (a, b) => b.activity - a.activity);
    $('#prows').innerHTML = rows.slice(0, limit).map(p => `<tr class="click" data-id="${esc(p.id)}"><td class="name"><b>${esc(p.name)}</b><small>${esc(p.external ? 'catalogue entry · no local folder' : p.path)}</small>${p.description ? `<small class="muted">${esc(p.description.slice(0, 120))}</small>` : ''}</td>
      <td class="hide-sm"><div class="chips">${p.status ? `<span class="chip ok">${esc(p.status)}</span>` : ''}${p.stack.map(x => `<span class="chip">${esc(x)}</span>`).join('')}</div></td>
      <td class="r">${ago(p.activity)}</td><td class="r hide-sm">${[p.sessions && p.sessions + ' sess', p.notes && p.notes + ' notes', p.todos && p.todos + ' todo'].filter(Boolean).join(' · ') || '—'}</td><td class="r hide-sm">${p.external ? '—' : bytes(p.size)}</td></tr>`).join('') || `<tr><td colspan="5"><div class="empty">No project matches.</div></td></tr>`;
    $('#pmore').innerHTML = rows.length > limit ? `<button id="moreBtn">Show ${Math.min(60, rows.length - limit)} more of ${fmt(rows.length - limit)}</button>` : '';
    if ($('#moreBtn')) $('#moreBtn').onclick = () => { limit += 60; draw(); };
    $$('#prows tr[data-id]').forEach(tr => tr.onclick = () => openProject(tr.dataset.id));
  };
  const search = async value => { ranked = value.trim() ? await get('/api/find?q=' + encodeURIComponent(value)) : null; limit = 60; draw(); };
  let timer;
  $('#pq').oninput = e => { clearTimeout(timer); timer = setTimeout(() => search(e.target.value), 160); };
  $$('#pf button').forEach(b => b.onclick = () => { filter = b.dataset.f; $$('#pf button').forEach(x => x.setAttribute('aria-pressed', x === b)); limit = 60; draw(); });
  $$('#ps button').forEach(b => b.onclick = () => { sort = b.dataset.s; $$('#ps button').forEach(x => x.setAttribute('aria-pressed', x === b)); ranked = null; $('#pq').value = ''; draw(); });
  if (q) await search(q); else draw();
  $('#pq').focus();
}

// ---------- Project drawer ----------
const TABS = [['card', 'Agent card'], ['map', 'Repo map'], ['sessions', 'Sessions'], ['notes', 'Notes & todos'], ['details', 'Everything']];
async function openProject(id, tab = 'card') {
  const drawer = $('#drawer');
  drawer.hidden = false;
  $('#drawerTitle').textContent = 'Loading…'; $('#drawerSub').textContent = ''; $('#drawerBody').innerHTML = '';
  const data = await get('/api/project?id=' + encodeURIComponent(id)).catch(e => { $('#drawerBody').innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
  if (!data) return;
  const p = data.project;
  $('#drawerTitle').textContent = p.name;
  $('#drawerSub').textContent = p.external ? 'Catalogue entry (no local folder)' : p.path;
  const tabs = TABS.filter(([k]) => k !== 'map' || !p.external);
  $('#drawerTabs').innerHTML = tabs.map(([k, v]) => `<button role="tab" data-tab="${k}" aria-selected="${k === tab}">${v}${k === 'sessions' && data.sessions.length ? ` (${data.sessions.length})` : ''}</button>`).join('');
  const show = async k => {
    $$('#drawerTabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === k));
    const body = $('#drawerBody');
    if (k === 'card') {
      const saved = data.baseline ? Math.max(0, Math.round(100 * (1 - data.cardTokens / data.baseline))) : 0;
      body.innerHTML = `<div class="compare"><div><small>Agent card</small><b>${fmt(data.cardTokens)}</b> <span class="faint">tokens</span></div><div><small>Reading the files</small><b>${fmt(data.baseline)}</b> <span class="faint">tokens</span></div><div><small>Saved</small><b>${saved}%</b></div></div>
        <div class="row-actions"><button class="primary" id="copyCard">Copy card</button><button id="copyCmd">Copy command</button></div>
        <p class="faint" style="font-size:12.5px;margin:4px 0 10px">This is exactly what <code>pack</code> returns to an agent (o200k tokens). Baseline: guides, manifests and listing an agent would otherwise read.</p>
        <pre class="card-text">${esc(data.card)}</pre>`;
      $('#copyCard').onclick = async () => { await copy(data.card, 'Card copied'); post('/api/copied', {id: p.id, kind: 'pack', text: data.card}).catch(() => {}); };
      $('#copyCmd').onclick = () => copy(`${store.summary?.cli || 'leanbrain'} pack "${p.external ? p.name : p.path}"`, 'Command copied');
    } else if (k === 'map') {
      body.innerHTML = '<p class="muted">Building the map…</p>';
      const m = await get('/api/map?id=' + encodeURIComponent(p.id)).catch(e => ({text: e.message}));
      body.innerHTML = `<div class="row-actions"><button class="primary" id="copyMap">Copy map</button></div><p class="faint" style="font-size:12.5px">Files ranked by how much the rest of the code uses them, with symbol names and line numbers.</p><pre class="card-text">${esc(m.text)}</pre>`;
      $('#copyMap').onclick = () => copy(m.text, 'Map copied');
    } else if (k === 'sessions') {
      body.innerHTML = data.sessions.length ? `<div class="feed">${data.sessions.map(sessionItem).join('')}</div>` : '<div class="empty">No agent session has worked here yet.</div>';
    } else if (k === 'notes') {
      body.innerHTML = `<h3 style="margin:0">Notes</h3><p class="faint" style="font-size:12.5px;margin:2px 0">Durable facts for future sessions. Never secrets.</p>
        <div class="note-box"><input id="noteText" maxlength="600" placeholder="e.g. Deploy with ./deploy.sh; staging runs on the build server"><button class="primary" id="addNote">Save</button></div>
        <div class="feed">${data.notes.map(n => `<div class="feed-item" style="cursor:default"><span class="chip">${esc(n.date.slice(0, 10))}</span><div><p style="-webkit-line-clamp:unset;color:var(--text)">${esc(n.text)}</p></div><span></span></div>`).join('') || '<p class="muted">No notes yet.</p>'}</div>
        <h3 style="margin:22px 0 0">Todos</h3><div class="note-box"><input id="todoText" maxlength="300" placeholder="An open thread to resume later"><button id="addTodo">Add</button></div>
        <div class="feed">${data.todos.map(t => `<div class="feed-item" style="cursor:default"><span class="chip ${t.done ? 'ok' : 'warn'}">#${t.n}</span><div><p style="-webkit-line-clamp:unset;color:var(--text)">${t.done ? '<s>' + esc(t.text) + '</s>' : esc(t.text)}</p></div>${t.done ? '<span class="faint">done</span>' : `<button data-done="${t.n}">Done</button>`}</div>`).join('') || '<p class="muted">No todos.</p>'}</div>`;
      const reload = async () => { store.summary = null; store.projects = null; await openProject(id, 'notes'); };
      $('#addNote').onclick = async () => { try { await post('/api/note', {id: p.id, text: $('#noteText').value}); toast('Note saved'); reload(); } catch (e) { toast(e.message); } };
      $('#addTodo').onclick = async () => { try { await post('/api/todo', {id: p.id, text: $('#todoText').value}); toast('Todo added'); reload(); } catch (e) { toast(e.message); } };
      $$('[data-done]').forEach(b => b.onclick = async () => { await post('/api/todo', {done: Number(b.dataset.done)}); reload(); });
    } else body.innerHTML = `<div class="row-actions"><button id="copyAll">Copy</button></div><pre class="card-text">${esc(data.full)}</pre>`;
    if ($('#copyAll')) $('#copyAll').onclick = () => copy(data.full);
  };
  $$('#drawerTabs button').forEach(b => b.onclick = () => show(b.dataset.tab));
  show(tabs.some(([k]) => k === tab) ? tab : 'card');
  $('.drawer-panel [data-close]').focus();
}
function closeDrawer() { $('#drawer').hidden = true; if (/[?&]p=/.test(location.hash)) history.replaceState(null, '', location.hash.replace(/[?&]p=[^&]*(&tab=[^&]*)?/, '')); }
$$('[data-close]').forEach(el => el.onclick = closeDrawer);

// ---------- Memory ----------
async function renderMemory(params) {
  let agent = params.get('agent') || '';
  $('#view').innerHTML = `<div class="page-title"><h1>Memory</h1><p>Every Claude Code, Codex and Gemini session on this machine, summarised: what was asked, how it ended, which files changed. Agents query it with <code>recall</code>.</p></div>
  <div class="toolbar"><input id="mq" type="search" placeholder="Ask your memory: “deploy staging”, “newsletter fake signups”…" value="${esc(params.get('q') || '')}">
  <div class="seg" id="ma">${[['', 'All agents'], ['claude', 'Claude Code'], ['codex', 'Codex'], ['gemini', 'Gemini']].map(([k, v]) => `<button data-a="${k}" aria-pressed="${k === agent}">${v}</button>`).join('')}</div></div>
  <section class="card" id="recallBox" hidden><h3>Recall</h3><pre class="card-text" id="recallText"></pre></section>
  <section class="card"><h3>Timeline</h3><p class="sub" id="mcount"></p><div class="feed" id="mfeed"></div><div class="more" id="mmore"></div></section>`;
  let limit = 60, list = [];
  const draw = () => {
    const groups = new Map();
    for (const s of list.slice(0, limit)) { const d = (s.end || s.start).slice(0, 10); groups.set(d, [...(groups.get(d) || []), s]); }
    $('#mfeed').innerHTML = [...groups].map(([d, rows]) => `<h4 class="faint" style="margin:16px 4px 4px;font-size:12px;letter-spacing:.06em;text-transform:uppercase">${new Date(d).toLocaleDateString('en-GB', {weekday: 'long', day: 'numeric', month: 'long'})}</h4>${rows.map(sessionItem).join('')}`).join('') || '<div class="empty">No sessions. Press “Sync sessions”.</div>';
    $('#mcount').textContent = `${fmt(list.length)} sessions${agent ? ' · ' + agent : ''}`;
    $('#mmore').innerHTML = list.length > limit ? `<button id="mm">Show more</button>` : '';
    if ($('#mm')) $('#mm').onclick = () => { limit += 60; draw(); };
    bindFeed($('#mfeed'));
  };
  const load = async () => { list = await get('/api/sessions?limit=1000' + (agent ? '&agent=' + agent : '')); limit = 60; draw(); };
  $$('#ma button').forEach(b => b.onclick = () => { agent = b.dataset.a; $$('#ma button').forEach(x => x.setAttribute('aria-pressed', x === b)); load(); });
  let timer;
  const recall = async q => {
    if (!q.trim()) { $('#recallBox').hidden = true; return; }
    const r = await get('/api/recall?q=' + encodeURIComponent(q));
    $('#recallBox').hidden = false; $('#recallText').textContent = r.text;
  };
  $('#mq').oninput = e => { clearTimeout(timer); timer = setTimeout(() => recall(e.target.value), 220); };
  await load();
  if (params.get('q')) recall(params.get('q'));
}

// ---------- Insights ----------
async function renderInsights() {
  const d = await get('/api/insights');
  const p = d.pause, im = d.immunity || {missing: {}, bsd: {}, modules: {}};
  const total = p.shortUsd + p.longUsd;
  const facts = [...Object.entries(im.missing).map(([k, f]) => [k, f.n, f.alt]), ...Object.entries(im.bsd).map(([k, f]) => [k.slice(4), f.n, f.fix])].sort((a, b) => b[1] - a[1]);
  const verdict = p.short > 3 && p.net1h > 0.5 ? `A 1-hour cache would save ${money(p.net1h)} net: set <code>CLAUDE_CODE_PROMPT_CACHE_TTL=1h</code>.`
    : p.short + p.long ? `A 1-hour cache would not pay off (saves ${money(p.shortUsd)}, costs ${money(p.extra1h)} more in writes). For breaks over an hour, start a fresh session: the LeanBrain brief restores context in a few hundred tokens.` : 'No rebuild after idle pauses. Nothing to fix.';
  $('#view').innerHTML = `<div class="page-title"><h1>Insights</h1><p>Signals no other tool computes, read from your own agent sessions on this machine. The guard acts on them automatically.</p></div>
  <div class="grid2">
    <section class="card"><h3>Pause tax</h3><p class="sub">Prompt-cache rebuilds after idle pauses, last 30 days (API list prices).</p>
      <div class="bignum">${money(total)}</div><p class="muted" style="margin:4px 0 12px">${fmt(p.short + p.long)} rebuilds · ${compact(p.shortTokens + p.longTokens)} tokens rewritten</p>
      <div class="hbar"><span>Pauses of 5–60 min · ${fmt(p.short)}</span><b>${money(p.shortUsd)}</b><i style="--w:${total ? 100 * p.shortUsd / total : 0}%"></i></div>
      <div class="hbar"><span>Pauses over 1 hour · ${fmt(p.long)}</span><b>${money(p.longUsd)}</b><i style="--w:${total ? 100 * p.longUsd / total : 0}%"></i></div>
      <p style="font-size:13.5px">${verdict}</p></section>
    <section class="card"><h3>Immunity</h3><p class="sub">Commands and flags that keep failing on this machine. The guard stops them before they run and says what to use instead.</p>
      ${facts.length ? `<table class="table"><tbody>${facts.map(([k, n, fix]) => `<tr><td><code>${esc(k)}</code></td><td class="r">${n}×</td><td class="muted" style="font-size:12.5px">${esc(fix)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No recurring failure learned yet.</div>'}</section>
    <section class="card"><h3>Collision radar</h3><p class="sub">Agent sessions active in the last hour. Before an edit, the guard warns if another session changed the same file in the last 30 minutes.</p>
      <div class="feed">${d.active.map(sessionItem).join('') || '<div class="empty">No other session active.</div>'}</div></section>
    <section class="card"><h3>Déjà vu</h3><p class="sub">Describe a task: LeanBrain finds where you (or another agent, in any project) already solved something similar. In Claude Code this runs on every prompt.</p>
      <div class="note-box"><input id="djq" placeholder="e.g. rate limit the signup endpoint"><button class="primary" id="djb">Search</button></div><div class="feed" id="djr"></div></section>
  </div>`;
  bindFeed(document.querySelector('.grid2'));
  const search = async () => {
    const q = $('#djq').value.trim();
    if (!q) return;
    const hits = await get('/api/dejavu?q=' + encodeURIComponent(q));
    $('#djr').innerHTML = hits.map(h => `<div class="feed-item" style="cursor:default"><span class="chip ok">↺</span><div><p style="-webkit-line-clamp:3;color:var(--text)">${esc(h.line)}</p></div><span></span></div>`).join('') || '<p class="muted">Nothing similar yet.</p>';
  };
  $('#djb').onclick = search;
  $('#djq').onkeydown = e => { if (e.key === 'Enter') search(); };
}

// ---------- Usage ----------
async function renderUsage(params) {
  let days = Number(params.get('days')) || 30, metric = params.get('m') || 'tokens';
  $('#view').innerHTML = `<div class="page-title"><h1>Agent usage</h1><p>Tokens your agents consumed, read from local transcripts, priced at Anthropic API list prices. On a Pro or Max plan this is the API-equivalent value, not your bill.</p></div>
  <div class="toolbar"><div class="seg" id="ud">${[7, 30, 90].map(d => `<button data-d="${d}" aria-pressed="${d === days}">${d} days</button>`).join('')}</div>
  <div class="seg" id="um"><button data-m="tokens" aria-pressed="${metric === 'tokens'}">Tokens</button><button data-m="cost" aria-pressed="${metric === 'cost'}">Cost</button></div></div><div id="ubody"><p class="muted">Loading…</p></div>`;
  const draw = async () => {
    const u = await get('/api/usage?days=' + days);
    const t = u.total, tot = t.in + t.cw + t.cr + t.out;
    const cacheHit = t.cr + t.in + t.cw ? Math.round(100 * t.cr / (t.cr + t.in + t.cw)) : 0;
    const series = Array.from({length: days}, (_, i) => { const d = new Date(Date.now() - (days - 1 - i) * 864e5).toISOString().slice(0, 10); return [d, u.days[d] || {in: 0, cw: 0, cr: 0, out: 0, usd: 0, tokens: 0}]; });
    const peak = Math.max(1, ...series.map(([, r]) => metric === 'cost' ? r.usd : r.tokens));
    const col = ([d, r]) => metric === 'cost'
      ? `<div class="col" title="${d} · ${money(r.usd)}"><i style="height:${100 * r.usd / peak}%;background:var(--accent)"></i></div>`
      : `<div class="col" title="${d} · ${compact(r.tokens)} tokens">${[['in', 'c-input'], ['cw', 'c-cachew'], ['cr', 'c-cacher'], ['out', 'c-output']].map(([k, c]) => `<i style="height:${100 * r[k] / peak}%;background:var(--${c})"></i>`).join('')}</div>`;
    const hb = (rows, key) => { const max = Math.max(1, ...rows.map(r => r[1][key])); return rows.map(([k, r]) => `<div class="hbar"><span>${esc(k)}</span><b>${key === 'usd' ? money(r.usd) : compact(r.tokens)}</b><i style="--w:${100 * r[key] / max}%"></i></div>`).join(''); };
    const byModel = Object.entries(u.models).sort((a, b) => b[1].usd - a[1].usd || b[1].tokens - a[1].tokens);
    const byProject = Object.entries(u.projects).sort((a, b) => b[1].usd - a[1].usd || b[1].tokens - a[1].tokens).slice(0, 15);
    $('#ubody').innerHTML = `<div class="kpis">
      <div class="kpi accent"><small>API-equivalent cost</small><strong>${money(t.usd)}</strong><span>${days} days${t.unpriced ? ` · +${compact(t.unpriced)} unpriced tokens` : ''}</span></div>
      <div class="kpi"><small>Tokens</small><strong>${compact(tot)}</strong><span>${compact(t.out)} output · ${compact(t.in)} fresh input</span></div>
      <div class="kpi"><small>Cache hits</small><strong>${cacheHit}%</strong><span>${compact(t.cr)} tokens read from cache</span></div>
      <div class="kpi"><small>Sessions</small><strong>${fmt(t.sessions)}</strong><span>${t.sessions ? money(t.usd / t.sessions) + ' per session' : '—'}</span></div></div>
    <section class="card"><h3>${metric === 'cost' ? 'Cost per day' : 'Tokens per day'}</h3><div class="bars">${series.map(col).join('')}</div>
      <div class="axis"><span>${series[0][0]}</span><span>${series.at(-1)[0]}</span></div>
      ${metric === 'tokens' ? '<div class="legend"><span style="--c:var(--c-input)">Input</span><span style="--c:var(--c-cachew)">Cache write</span><span style="--c:var(--c-cacher)">Cache read</span><span style="--c:var(--c-output)">Output</span></div>' : ''}</section>
    <div class="grid2" style="margin-top:18px">
      <section class="card"><h3>By project</h3><p class="sub">Attributed by working folder and edited files.</p><table class="table"><thead><tr><th>Project</th><th class="r">Sessions</th><th class="r">Tokens</th><th class="r">Cost</th></tr></thead><tbody>${byProject.map(([k, r]) => `<tr><td>${esc(k)}</td><td class="r">${r.sessions}</td><td class="r">${compact(r.tokens)}</td><td class="r">${money(r.usd)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No data</td></tr>'}</tbody></table></section>
      <section class="card"><h3>By model</h3><p class="sub">${metric === 'cost' ? 'Estimated cost' : 'Tokens'} per model.</p>${hb(byModel, metric === 'cost' ? 'usd' : 'tokens') || '<p class="muted">No data</p>'}
        <h3 style="margin-top:20px">By agent</h3>${hb(Object.entries(u.agents), metric === 'cost' ? 'usd' : 'tokens')}</section></div>
    ${toolCard(u)}`;
  };
  $$('#ud button').forEach(b => b.onclick = () => { days = Number(b.dataset.d); $$('#ud button').forEach(x => x.setAttribute('aria-pressed', x === b)); draw(); });
  $$('#um button').forEach(b => b.onclick = () => { metric = b.dataset.m; $$('#um button').forEach(x => x.setAttribute('aria-pressed', x === b)); draw(); });
  await draw();
}

function toolCard(u) {
  const rows = Object.entries(u.tools || {}).sort((a, b) => b[1] - a[1]);
  const text = rows.reduce((n, [, v]) => n + v, 0);
  if (!text && !u.images) return '';
  const img = (u.images || 0) * 1500;
  const top = [...rows.slice(0, 9), ...(img ? [[`Screenshots (${fmt(u.images)} images, ≈1.5k each)`, img]] : [])].sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...top.map(r => r[1]));
  return `<section class="card" style="margin-top:18px"><h3>Where the tokens go</h3><p class="sub">Tool output the model actually read, by tool: ≈${compact(text)} tokens of text${img ? ` + ≈${compact(img)} in screenshots` : ''}. The LeanBrain guard trims file reads in Read and Bash.</p>
    ${top.map(([k, v]) => `<div class="hbar"><span>${esc(k)}</span><b>${compact(v)} · ${Math.round(100 * v / (text + img))}%</b><i style="--w:${100 * v / max}%"></i></div>`).join('')}</section>`;
}

// ---------- Savings ----------
async function renderSavings() {
  const g = await get('/api/gain');
  const s = await summary();
  const pct = g.full ? Math.round(1000 * g.saved / g.full) / 10 : 0;
  const days = lastDays(g.days, 30);
  const peak = Math.max(1, ...days);
  const kinds = Object.entries(g.kinds).sort((a, b) => b[1].saved - a[1].saved);
  const max = Math.max(1, ...kinds.map(([, v]) => v.saved));
  $('#view').innerHTML = `<div class="page-title"><h1>Savings</h1><p>Each LeanBrain call logs two numbers: the tokens an agent would have read without it (whole files, raw output) and the tokens it actually returned. Only counts, never content.</p></div>
  <div class="grid3">
    <section class="card" style="text-align:center"><h3>Overall reduction</h3><div class="donut" style="--p:${pct}"><strong>${pct}%</strong></div><p class="muted" style="margin:0">${compact(g.full)} → ${compact(g.compact)} tokens</p></section>
    <section class="card"><h3>Tokens saved</h3><div class="bignum">${compact(g.saved)}</div><p class="muted">over ${fmt(g.uses)} operations</p><h3 style="margin-top:18px">Value</h3><div class="bignum">${money(g.usd)}</div><p class="muted">at $${s.price}/M input tokens (LEANBRAIN_USD_PER_MTOK)</p></section>
    <section class="card"><h3>Last 30 days</h3><div class="bars" style="height:150px">${days.map((v, i) => `<div class="col" title="${compact(v)} tokens"><i style="height:${100 * v / peak}%;background:var(--accent)"></i></div>`).join('')}</div><div class="axis"><span>30 days ago</span><span>today</span></div></section>
  </div>
  <div class="grid2" style="margin-top:18px">
    <section class="card"><h3>By operation</h3><p class="sub">Where the savings come from.</p>${kinds.map(([k, v]) => `<div class="hbar"><span>${esc(g.labels[k] || k)} · ${fmt(v.uses)} ops</span><b>${compact(v.saved)} · ${v.full ? Math.round(100 * v.saved / v.full) : 0}%</b><i style="--w:${100 * v.saved / max}%"></i></div>`).join('') || '<p class="muted">Nothing yet.</p>'}</section>
    <section class="card" id="potential"><h3>Catalogue potential</h3><p class="sub">One card per project versus reading its guides and manifests.</p><p class="muted">Measuring ${fmt(s.index.projects)} projects…</p></section>
  </div>`;
  const rows = await get('/api/potential');
  const base = rows.reduce((n, r) => n + r.base, 0), card = rows.reduce((n, r) => n + r.card, 0);
  const top = rows.map(r => ({...r, saved: r.base - r.card})).sort((a, b) => b.saved - a.saved).slice(0, 8);
  const tmax = Math.max(1, ...top.map(r => r.saved));
  $('#potential').innerHTML = `<h3>Catalogue potential</h3><p class="sub">One card per project versus reading its guides and manifests.</p>
    <div class="compare"><div><small>Files</small><b>${compact(base)}</b></div><div><small>Cards</small><b>${compact(card)}</b></div><div><small>Reduction</small><b>${base ? Math.round(100 * (1 - card / base)) : 0}%</b></div></div>
    ${top.map(r => `<div class="hbar"><span>${esc(r.name)}</span><b>−${compact(r.saved)}</b><i style="--w:${100 * r.saved / tmax}%"></i></div>`).join('')}`;
}

// ---------- Disk ----------
async function renderDisk(params) {
  let mode = params.get('mode') || 'large', limit = 80;
  const d = await get('/api/disk');
  $('#view').innerHTML = `<div class="page-title"><h1>Disk</h1><p>Large files, dependency and build folders per project, and folders full of tiny files. Logical sizes from the last scan.</p></div>
  <div class="toolbar"><div class="seg" id="dm"><button data-m="large" aria-pressed="${mode === 'large'}">Large files</button><button data-m="generated" aria-pressed="${mode === 'generated'}">Dependencies & build</button><button data-m="folders" aria-pressed="${mode === 'folders'}">Microfiles</button></div><input id="dq" type="search" placeholder="Filter by path…"></div>
  <div class="card" style="padding:6px 8px"><table class="table"><tbody id="drows"></tbody></table><div class="more" id="dmore"></div></div>`;
  const draw = () => {
    const q = $('#dq').value.toLowerCase();
    const rows = (mode === 'large' ? d.large : mode === 'generated' ? d.generated : d.folders).filter(r => (r.path || '').toLowerCase().includes(q));
    $('#drows').innerHTML = rows.slice(0, limit).map((r, i) => mode === 'large'
      ? `<tr><td class="name"><b>${esc(r.path.split('/').pop())}</b><small>${esc(r.path)}</small></td><td class="r">${bytes(r.size)}</td><td class="r"><button data-trash="${esc(r.path)}">Move to Trash…</button></td></tr>`
      : mode === 'generated' ? `<tr class="click" data-id="${esc(r.id)}"><td class="name"><b>${esc(r.name)}</b><small>${esc(r.path)}</small></td><td class="r">${bytes(r.generated)}</td><td class="r faint">of ${bytes(r.size)}</td></tr>`
      : `<tr><td class="name"><b>${esc(r.path.split('/').pop())}</b><small>${esc(r.path)}</small></td><td class="r">${fmt(r.small)} files under 4 KiB</td><td class="r"><button data-copy="${esc(r.path)}">Copy path</button></td></tr>`).join('') || '<tr><td><div class="empty">Nothing here.</div></td></tr>';
    $('#dmore').innerHTML = rows.length > limit ? '<button id="dmb">Show more</button>' : '';
    if ($('#dmb')) $('#dmb').onclick = () => { limit += 80; draw(); };
    $$('[data-trash]').forEach(b => b.onclick = async () => {
      if (!confirm('Move this file to the Trash?\n' + b.dataset.trash)) return;
      b.disabled = true;
      try { await post('/api/trash', {file: b.dataset.trash}); d.large = d.large.filter(x => x.path !== b.dataset.trash); toast('Moved to Trash'); draw(); } catch (e) { toast(e.message); b.disabled = false; }
    });
    $$('[data-copy]').forEach(b => b.onclick = () => copy(b.dataset.copy));
    $$('#drows tr[data-id]').forEach(tr => tr.onclick = () => openProject(tr.dataset.id, 'details'));
  };
  $$('#dm button').forEach(b => b.onclick = () => { mode = b.dataset.m; limit = 80; $$('#dm button').forEach(x => x.setAttribute('aria-pressed', x === b)); draw(); });
  $('#dq').oninput = draw;
  draw();
}

// ---------- Setup ----------
const COMMANDS = [
  ['brief', 'Digest at the start of a chat'], ['pack .', 'Card of the project here (≤500 tokens)'], ['find <words>', 'Find a project'],
  ['map .', 'Ranked files and symbols'], ['grep "<regex>" --glob "*.ts"', 'Grouped code search'], ['read <file> --chat <id>', 'Outline, then diffs on re-reads'],
  ['run -- npm test', 'Failures + summary only'], ['recall <words>', 'Search past sessions and notes'], ['note . "<fact>"', 'Remember a durable fact'],
  ['usage --by tool', 'Where the tokens go'], ['audit', 'Fixed context every call re-reads'], ['gain', 'Tokens saved'], ['install --guard', 'Automatic token guard for Claude Code'],
];
async function renderSetup() {
  const s = await summary(true);
  const st = s.status;
  const row = (label, on, detail) => `<div class="check"><span class="chip ${on ? 'ok' : 'warn'}">${on ? '✓' : '—'}</span><div><b>${label}</b><div class="faint" style="font-size:12.5px">${esc(detail)}</div></div></div>`;
  $('#view').innerHTML = `<div class="page-title"><h1>Setup</h1><p>How your agents reach LeanBrain. Everything runs locally; data lives in <code>${esc(s.home)}</code>.</p></div>
  <div class="grid2">
    <section class="card"><h3>Integrations</h3><p class="sub">Rules are read by every chat; MCP adds native tools; the hook gives Claude Code the brief automatically.</p><div class="checks">
      ${Object.entries(st.rules).map(([k, v]) => row({claude: 'Claude Code rule (CLAUDE.md)', codex: 'Codex rule (AGENTS.md)', gemini: 'Gemini rule (GEMINI.md)'}[k], v.startsWith('installed'), v)).join('')}
      ${row('MCP · Claude Code', st.mcp.claude, st.mcp.claude ? 'leanbrain server registered' : 'off')}${row('MCP · Codex', st.mcp.codex, st.mcp.codex ? 'in config.toml' : 'off')}${row('MCP · Gemini CLI', st.mcp.gemini, st.mcp.gemini ? 'in settings.json' : 'off')}
      ${row('Token guard (Claude Code hooks)', st.hook, st.hook ? 'stubs for re-reads, outlines for big files, diffs after edits, brief at start' : 'off')}</div>
      <div class="cmd" style="margin-top:14px"><small>Enable everything</small><code>${esc(s.cli)} install --all</code><button data-c="${esc(s.cli)} install --all">Copy</button></div></section>
    <section class="card"><h3>Index</h3><p class="sub">${s.index.source ? `Catalogue: <code>${esc(s.index.source)}</code> · ` : ''}${fmt(s.index.roots)} folders · ${fmt(s.index.files)} files · ${bytes(s.index.bytes)}</p>
      <div class="checks">${row('Projects', true, `${fmt(s.index.projects)} (${fmt(s.index.local)} local) · updated ${since(s.index.date)}`)}${row('Agent sessions', !!s.memory.synced, `${fmt(s.memory.sessions)} remembered · synced ${since(s.memory.synced)}`)}</div>
      <div class="row-actions" style="margin-top:14px"><button class="primary" id="setupScan">Rescan now</button><button id="setupSync">Sync sessions</button><button id="editRoots">Edit folders…</button></div>
      <div id="rootsEditor" hidden><p class="faint" style="font-size:12.5px">One absolute path per line. Saving switches to a manual selection${s.index.source ? ' instead of the catalogue' : ''}.</p><textarea id="rootsText" rows="7" style="width:100%;font-family:var(--mono);font-size:12px;border-radius:10px;border:1px solid var(--line-2);background:var(--surface-2);padding:10px"></textarea><button class="primary" id="saveRoots">Scan these folders</button></div></section>
  </div>
  <section class="card" style="margin-top:18px"><h3>Commands for agents</h3><p class="sub">Prefix: <code>${esc(s.cli)}</code></p>${COMMANDS.map(([c, d]) => `<div class="cmd"><small>${esc(d)}</small><code>${esc(c)}</code><button data-c="${esc(s.cli + ' ' + c)}">Copy</button></div>`).join('')}</section>`;
  $$('[data-c]').forEach(b => b.onclick = () => copy(b.dataset.c, 'Command copied'));
  $('#setupScan').onclick = () => rescan($('#setupScan'));
  $('#setupSync').onclick = () => syncNow($('#setupSync'));
  $('#editRoots').onclick = async () => { const d = await get('/api/disk'); $('#rootsText').value = d.roots.join('\n'); $('#rootsEditor').hidden = false; };
  $('#saveRoots').onclick = async () => {
    const roots = $('#rootsText').value.split('\n').map(x => x.trim()).filter(Boolean);
    if (!roots.length) return toast('Add at least one folder');
    if (s.index.source && !confirm('Switch from the catalogue to this manual selection?')) return;
    $('#saveRoots').disabled = true; status('Scanning…');
    try { await post('/api/roots', roots); store.summary = store.projects = null; toast('Scan complete'); renderSetup(); } catch (e) { toast(e.message); } finally { status(''); }
  };
}

async function rescan(button) {
  button.disabled = true; status('Scanning your folders… this can take a minute.');
  try { await post('/api/scan'); store.summary = store.projects = null; toast('Index updated'); route(); } catch (e) { toast(e.message); } finally { button.disabled = false; status(''); }
}
async function syncNow(button) {
  button.disabled = true; status('Reading new agent sessions…');
  try { const r = await post('/api/sync'); store.summary = null; toast(r.busy ? 'A sync is already running' : `${fmt(r.sessions)} sessions remembered`); route(); } catch (e) { toast(e.message); } finally { button.disabled = false; status(''); }
}
$('#rescan').onclick = () => rescan($('#rescan'));
$('#sync').onclick = () => syncNow($('#sync'));

// ---------- Global search, keyboard, theme ----------
$('#globalSearch').addEventListener('keydown', e => { if (e.key === 'Enter') go('projects', {q: e.target.value}); });
$('#globalSearch').addEventListener('input', e => { if (store.view === 'projects' && $('#pq')) { $('#pq').value = e.target.value; $('#pq').dispatchEvent(new Event('input')); } });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer();
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); $('#globalSearch').focus(); }
});
const THEMES = ['auto', 'dark', 'light'];
$('#theme').onclick = () => {
  const now = document.documentElement.dataset.theme || 'auto';
  const next = THEMES[(THEMES.indexOf(now) + 1) % THEMES.length];
  if (next === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = next;
  try { next === 'auto' ? localStorage.removeItem('leanbrain-theme') : localStorage.setItem('leanbrain-theme', next); } catch {}
  toast('Theme: ' + next);
};
route();
