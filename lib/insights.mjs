// Insights no other tool computes from local agent transcripts:
//  · pause tax  — what prompt-cache rebuilds after idle pauses cost, and whether a 1-hour cache pays off
//  · immunity   — commands and flags that keep failing on this machine, learned from your own sessions
//  · déjà vu    — past sessions (any project, any agent) that solved something similar to a new prompt
//  · radar      — other sessions working on the same project or files right now
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {state, atomic, readJSON, compact, fmt, clip, tilde, day} from './core.mjs';
import {rates, modelLabel, describeSession} from './sessions.mjs';
import {createIndex} from './search.mjs';

// ---- Pause tax ------------------------------------------------------------------------------------
export async function pauseData(list, {days = 30} = {}) {
  const since = day(Date.now() - (days - 1) * 86400e3);
  const out = {short: 0, shortTokens: 0, long: 0, longTokens: 0, shortUsd: 0, longUsd: 0, extra1h: 0, writes: 0, models: {}};
  for (const s of list) {
    if ((s.start || '').slice(0, 10) < since) continue;
    for (const [model, u] of Object.entries(s.usage || {})) {
      const r = await rates(model);
      if (!r) continue;
      out.writes += u.cw || 0;
      out.extra1h += (u.cw || 0) * (r.in * 2 - r.cw) / 1e6;
    }
    for (const [model, p] of Object.entries(s.pauses || {})) {
      const r = await rates(model);
      const excess = r ? (r.cw - r.cr) / 1e6 : 0;
      out.short += p.short; out.shortTokens += p.shortTokens; out.shortUsd += p.shortTokens * excess;
      out.long += p.long; out.longTokens += p.longTokens; out.longUsd += p.longTokens * excess;
      const m = out.models[model] ||= {n: 0, tokens: 0};
      m.n += p.short + p.long; m.tokens += p.shortTokens + p.longTokens;
    }
  }
  out.net1h = out.shortUsd - out.extra1h;
  return out;
}

export async function pauseReport(list, {days = 30} = {}) {
  const d = await pauseData(list, {days});
  const n = d.short + d.long;
  if (!n) return `Pause tax · last ${days} days: no prompt-cache rebuild after an idle pause. Nothing to fix.`;
  const usd = x => '$' + (x >= 100 ? fmt(x) : x.toFixed(2));
  const lines = [
    `Pause tax · last ${days} days · prompt cache rebuilt ${fmt(n)} times after an idle pause`,
    `  Pauses of 5–60 min: ${fmt(d.short)} rebuilds · ${compact(d.shortTokens)} tokens rewritten · ${usd(d.shortUsd)} above cache-hit price`,
    `  Pauses over 1 hour: ${fmt(d.long)} rebuilds · ${compact(d.longTokens)} tokens rewritten · ${usd(d.longUsd)} above cache-hit price`,
    '  (API-equivalent list prices; on a subscription this is usage, not your bill)',
  ];
  if (d.short > 3 && d.net1h > 0.5) lines.push(`A 1-hour cache would have avoided the 5–60 min rebuilds: −${usd(d.shortUsd)}, while every cache write costs more (2× instead of 1.25× input): +${usd(d.extra1h)} → net −${usd(d.net1h)}.`,
    'Enable it: export CLAUDE_CODE_PROMPT_CACHE_TTL=1h (Claude Code 2.1.242+; subscription plans within included usage already get 1 hour).');
  else if (d.short > 3) lines.push(`A 1-hour cache would not pay off here: it saves ${usd(d.shortUsd)} but costs ${usd(d.extra1h)} more in cache writes.`);
  if (d.longUsd > 1) lines.push('After pauses over an hour, a large context is rewritten anyway: for long breaks, start a fresh session (the LeanBrain brief restores the context in a few hundred tokens) or /compact before resuming.');
  return lines.join('\n');
}

// ---- Immunity -------------------------------------------------------------------------------------
const LOCAL_MODULES = new Set(['app', 'api', 'api_client', 'src', 'lib', 'tests', 'test', 'utils', 'config', 'main', 'core', 'models', 'server', 'scripts', 'tools']);
const EXTRA_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.cargo/bin'), path.join(os.homedir(), 'go/bin'), path.join(os.homedir(), '.bun/bin')];
export function installed(bin) {
  for (const dir of [...(process.env.PATH || '').split(path.delimiter), ...EXTRA_DIRS]) {
    try { fs.accessSync(path.join(dir, bin), fs.constants.X_OK); return true; } catch {}
  }
  return false;
}
const ALT = {
  timeout: "macOS has no timeout: use gtimeout (brew coreutils) or perl -e 'alarm 60; exec @ARGV' cmd",
  gh: 'GitHub CLI is not installed: use git, or curl https://api.github.com/...',
  python: 'use python3', pip: 'use python3 -m pip', rg: 'use grep -rn, or leanbrain grep',
  sha256sum: 'use shasum -a 256', md5sum: 'use md5', nproc: 'use sysctl -n hw.ncpu', tac: 'use tail -r', realpath: 'use python3 -c "import os,sys;print(os.path.realpath(sys.argv[1]))"',
  wget: 'use curl -LO', tree: 'use find . -maxdepth 2', fd: 'use find', bat: 'use cat', jq: 'use python3 -m json.tool',
};
const BSD = {
  'bsd:sed-i': ['BSD sed: write sed -i \'\' \'s/a/b/\' file (the empty suffix is required)', /(^|[;&|]\s*)sed\s+(-[a-zA-Z]*i)(?!\s*(''|""|\.\w+|-))\s/],
  'bsd:readlink-f': ['BSD readlink has no -f: use realpath, or python3 os.path.realpath', /\breadlink\s+-f\b/],
  'bsd:date-d': ['BSD date has no -d: use date -j -f FORMAT STRING, or date -v-1d', /\bdate\s+(-[a-zA-Z]*d\b|--date)/],
  'bsd:grep-P': ['BSD grep has no -P: use grep -E, or perl -ne', /\bgrep\s+(-[a-zA-Z]*P|--perl-regexp)/],
  'bsd:xargs-r': ['BSD xargs has no -r (it is the default behaviour): drop the flag', /\bxargs\s+(-[a-zA-Z]*r\b)/],
};

/** Learned facts about this machine, from failures in past sessions (evidence counts, last seen). */
export function learnImmunity(list) {
  const counts = {};
  for (const s of list) for (const [sig, row] of Object.entries(s.fails || {})) {
    const c = counts[sig] ||= {n: 0, at: '', cmd: row.cmd};
    c.n += row.n; if ((s.end || '') > c.at) c.at = s.end || c.at;
  }
  const facts = {missing: {}, bsd: {}, modules: {}, zshGlob: 0, updated: new Date().toISOString()};
  const recent = day(Date.now() - 90 * 86400e3);
  for (const [sig, c] of Object.entries(counts)) {
    if ((c.at || '').slice(0, 10) < recent) continue;
    const [kind, value] = sig.split(':');
    // Real commands are lowercase; a capitalised word is usually an unquoted path split at a space.
    if (kind === 'missing' && /^[a-z][\w.+-]{0,29}$/.test(value) && (c.n >= 2 || ALT[value]) && !installed(value)) facts.missing[value] = {n: c.n, alt: ALT[value] || 'not installed on this machine'};
    else if (kind === 'bsd' && process.platform !== 'linux') facts.bsd[sig] = {n: c.n, fix: BSD[sig]?.[0]};
    else if (kind === 'module' && c.n >= 2 && !LOCAL_MODULES.has(value)) facts.modules[value] = c.n;
    else if (kind === 'zsh') facts.zshGlob += c.n;
  }
  return facts;
}
export const loadImmunity = () => readJSON(state('immunity.json'), null).catch(() => null);
export const saveImmunity = facts => atomic(state('immunity.json'), JSON.stringify(facts));

export function immunityText(facts) {
  if (!facts) return 'Nothing learned yet. Run: leanbrain sessions --sync';
  const lines = ['Immunity · learned from failed commands in your own sessions (blocked before they run)'];
  for (const [bin, f] of Object.entries(facts.missing).sort((a, b) => b[1].n - a[1].n)) lines.push(`  ${bin.padEnd(12)} failed ${f.n}× · ${f.alt}`);
  for (const [sig, f] of Object.entries(facts.bsd)) lines.push(`  ${sig.slice(4).padEnd(12)} failed ${f.n}× · ${f.fix}`);
  for (const [mod, n] of Object.entries(facts.modules).sort((a, b) => b[1] - a[1]).slice(0, 6)) lines.push(`  python: no module ${mod} (${n}×) · install it in the project environment or use the project's venv`);
  if (facts.zshGlob) lines.push(`  zsh globs failed ${facts.zshGlob}× · quote patterns ('*.js') or use setopt nonomatch`);
  if (lines.length === 1) lines.push('  No recurring failure. Nothing to block.');
  return lines.join('\n');
}
/** One short line for the start of a session. */
export function immunityBrief(facts) {
  if (!facts) return '';
  const parts = [...Object.keys(facts.missing).slice(0, 6).map(b => `no ${b}`), ...Object.keys(facts.bsd).map(s => s === 'bsd:sed-i' ? "sed -i ''" : 'BSD ' + s.slice(4).replace('-', ' -')), facts.zshGlob ? 'quote globs' : ''].filter(Boolean);
  return parts.length ? 'Machine facts (learned from past failures): ' + parts.join(' · ') : '';
}

/** A Bash command that history says will fail here. Returns a reason, or null. */
export function immunityCheck(command, facts) {
  if (!facts) return null;
  const c = String(command || '');
  for (const segment of c.split(/&&|\|\||[;|\n]/)) {
    const words = segment.trim().replace(/^(\w+=\S*\s+)+/, '').split(/\s+/);
    while (['sudo', 'exec', 'time', 'nohup', 'command', 'env'].includes(words[0])) words.shift();
    const bin = words[0];
    if (bin && facts.missing[bin]) return `${bin} is not available on this machine (it failed ${facts.missing[bin].n}× in past sessions). ${facts.missing[bin].alt}.`;
  }
  for (const [sig, f] of Object.entries(facts.bsd)) if (BSD[sig]?.[1].test(c)) return `${f.fix} (this failed ${f.n}× in past sessions).`;
  return null;
}

// ---- Déjà vu --------------------------------------------------------------------------------------
const STOP = new Set(('a about after again all also an and any are as at be been before but by can could did do does done for from get got had has have how i if in into is it its just like make me more my need new no not now of on one only or other our out please so some than that the their them then there these they this to too up us use using want was way we were what when where which who why will with would you your ' +
  'a ad al alla alle anche ancora che chi ci come con cosa così da dal dalla dei del della delle di do e è fa fai fare gli ha hai ho i il in io la le lo ma mi mio mia ne nei nel nella no non o per più poi può qua qui quel quella questo questa se si sia sono su sul sulla ti tra tu tutto tutti un una uno va vorrei voglio fammi crea creami mi puoi sempre adesso ora bene').split(' '));
export const meaningful = text => [...new Set(String(text || '').toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '').split(/[^\p{L}\p{N}]+/u).filter(t => t.length > 2 && !STOP.has(t)))];

/** Past sessions similar to a new prompt, from any project or agent (excluding the running session). */
export function dejaVu(prompt, ctx, {sessionId, hereId, limit = 2} = {}) {
  const words = meaningful(prompt);
  if (words.length < 2) return [];
  const names = new Map(ctx.index.projects.map(p => [p.id, p.name]));
  const old = Date.now() - 7 * 86400e3;
  const docs = ctx.sessions.filter(s => s.sid !== sessionId && s.outcome && (s.projects[0] !== hereId || Date.parse(s.end || s.start) < old))
    .map(s => ({item: s, fields: [[s.title, 2], [s.last, 1.2], [s.outcome, 1.5], [Object.keys(s.files || {}).map(f => path.basename(f)).join(' '), 0.8], [names.get(s.projects[0]), 1]]}));
  const hits = createIndex(docs)(words.join(' '), {limit: 5});
  // Coverage, not raw BM25 scores: scores depend on how many sessions exist, coverage does not.
  const need = words.length <= 3 ? 2 : Math.max(3, Math.ceil(words.length * 0.5));
  return hits.filter(h => h.matched >= need).slice(0, limit).map(h => {
    const s = h.item;
    const {title, outcome} = describeSession(s);
    const files = Object.keys(s.files || {}).slice(0, 4).map(f => path.basename(f)).join(', ');
    return {sid: s.sid, line: `${(s.end || s.start).slice(0, 10)} · ${names.get(s.projects[0]) || 'no project'} · ${s.agent} · "${clip(title, 90)}"${outcome ? ' → ' + clip(outcome, 140) : ''}${files ? ` (edited: ${files})` : ''}`};
  });
}

// ---- Collision radar ------------------------------------------------------------------------------
const ACTIVITY = () => state('activity.json');
export async function loadActivity() {
  const a = await readJSON(ACTIVITY(), {files: {}, sessions: {}}).catch(() => ({files: {}, sessions: {}}));
  const cutoff = Date.now() - 3 * 3600e3;
  for (const [f, rows] of Object.entries(a.files)) { a.files[f] = rows.filter(r => r.at > cutoff); if (!a.files[f].length) delete a.files[f]; }
  for (const [sid, row] of Object.entries(a.sessions)) if (row.at < cutoff) delete a.sessions[sid];
  return a;
}
export const saveActivity = a => atomic(ACTIVITY(), JSON.stringify(a));

/** Other sessions that edited `file` in the last `minutes`, from live hooks and synced transcripts. */
export function editorsOf(file, a, sessions, {sid, minutes = 30} = {}) {
  const since = Date.now() - minutes * 60e3;
  const out = new Map();
  for (const r of a.files[file] || []) if (r.sid !== sid && r.at > since) out.set(r.sid, {agent: 'claude', at: r.at, title: a.sessions[r.sid]?.title || ''});
  for (const s of sessions || []) {
    if (s.sid === sid || out.has(s.sid) || !s.files?.[file]) continue;
    const at = Date.parse(s.end || s.start) || 0;
    if (at > since) out.set(s.sid, {agent: s.agent, at, title: describeSession(s).title});
  }
  return [...out.values()].sort((x, y) => y.at - x.at);
}
/** Other sessions active in the same project in the last `minutes`. */
export function neighbours(projectId, a, sessions, {sid, minutes = 20, inside} = {}) {
  const since = Date.now() - minutes * 60e3;
  const out = [];
  for (const [other, row] of Object.entries(a.sessions)) if (other !== sid && row.at > since && row.cwd && inside(projectId, row.cwd)) out.push({agent: 'claude', at: row.at, title: row.title || ''});
  for (const s of sessions || []) {
    if (s.sid === sid || !s.projects?.includes(projectId) || a.sessions[s.sid]) continue;
    const at = Date.parse(s.end || s.start) || 0;
    if (at > since) out.push({agent: s.agent, at, title: describeSession(s).title, files: Object.keys(s.files || {}).slice(0, 4).map(f => path.basename(f))});
  }
  return out;
}
export const minutesAgo = at => Math.max(1, Math.round((Date.now() - at) / 60e3));
export {tilde, modelLabel};
