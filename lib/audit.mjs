// Fixed context audit: what every model call re-reads before your first word (instructions, imports,
// skills list, start-up hook output), and what that costs across a month of agent calls.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readJSON, tilde, compact, fmt, projectAt, loadIndex} from './core.mjs';
import {tokens} from './tokens.mjs';
import {loadSessions, attribute, costOf} from './sessions.mjs';
import {briefText, context} from './card.mjs';

const home = os.homedir();
const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
const read = file => fs.readFile(file, 'utf8').catch(() => null);

/** A CLAUDE.md-style file plus the files it imports with @path lines (one level, like Claude Code). */
async function withImports(file) {
  const text = await read(file);
  if (text == null) return null;
  const parts = [{file, tokens: tokens(text)}];
  for (const m of text.matchAll(/^@(\S+)\s*$/gm)) {
    const target = path.resolve(path.dirname(file), m[1].replace(/^~(?=\/)/, home));
    const t = await read(target);
    if (t != null) parts.push({file: target, tokens: tokens(t), imported: true});
  }
  return parts;
}

async function skills() {
  let total = 0, count = 0;
  for (const dir of [path.join(claudeDir, 'skills')]) {
    for (const name of await fs.readdir(dir).catch(() => [])) {
      const text = await read(path.join(dir, name, 'SKILL.md'));
      const desc = text?.match(/^---[\s\S]*?^description:\s*(.+)$/m)?.[1];
      if (desc) { total += tokens(name + ': ' + desc); count++; }
    }
  }
  return {count, tokens: total};
}

export async function auditText({cwd = process.cwd(), days = 30} = {}) {
  const rows = [];
  const add = (label, t, note = '') => t && rows.push({label, tokens: t, note});
  for (const part of (await withImports(path.join(claudeDir, 'CLAUDE.md'))) || []) add((part.imported ? '  imported ' : 'Global ') + tilde(part.file), part.tokens, 'Claude Code');
  const index = await loadIndex();
  const here = projectAt(index, cwd);
  if (here) for (const name of ['CLAUDE.md', 'AGENTS.md', '.claude/CLAUDE.md']) {
    for (const part of (await withImports(path.join(here.id, name))) || []) add('Project ' + tilde(part.file), part.tokens, here.name);
  }
  const s = await skills();
  add(`Skill descriptions (${s.count} in ${tilde(path.join(claudeDir, 'skills'))})`, s.tokens, 'listed every session');
  const ctx = await context();
  add('LeanBrain brief (SessionStart)', tokens(await briefText(ctx, {here: cwd})), 'once per session');
  const settings = await readJSON(path.join(claudeDir, 'settings.json'), {}).catch(() => ({}));
  const otherStart = (settings.hooks?.SessionStart || []).flatMap(g => g.hooks || []).filter(h => !String(h.command).includes('leanbrain.mjs'));
  const claudeJson = await readJSON(path.join(home, '.claude.json'), {}).catch(() => ({}));
  const mcp = Object.keys(claudeJson.mcpServers || {});
  const codex = await read(path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'AGENTS.md'));
  const gemini = await read(path.join(home, '.gemini', 'GEMINI.md'));

  const perCall = rows.filter(r => r.note !== 'once per session').reduce((n, r) => n + r.tokens, 0);
  // How many model calls re-read that prefix: assistant messages with usage, last `days` days.
  const list = attribute(await loadSessions(), index);
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  let calls = 0, cost = 0;
  const models = {};
  for (const x of list) if ((x.start || '') >= since) for (const [model, u] of Object.entries(x.usage || {})) {
    calls += u.n || 0;
    models[model] = (models[model] || 0) + (u.n || 0);
  }
  for (const [model, n] of Object.entries(models)) cost += (await costOf(model, {cr: perCall * n})) || 0;

  const lines = [`Fixed context audit · what Claude Code re-reads on every model call`];
  for (const r of rows) lines.push(`  ${r.label.padEnd(58).slice(0, 58)} ${fmt(r.tokens).padStart(7)} tok  ${r.note}`);
  lines.push(`Per call: ≈${fmt(perCall)} tokens of instructions and skill descriptions (system prompt and tool schemas come on top).`);
  if (calls) lines.push(`Last ${days} days: ${fmt(calls)} model calls → ≈${compact(perCall * calls)} tokens re-read from cache ≈ $${cost.toFixed(2)} at cache-read prices.`);
  if (otherStart.length) lines.push(`Other SessionStart hooks: ${otherStart.length} (${otherStart.map(h => clipCmd(h.command)).join('; ')}) — their output is added to every session.`);
  if (mcp.length) lines.push(`MCP servers in ~/.claude.json: ${mcp.length} (${mcp.slice(0, 6).join(', ')}${mcp.length > 6 ? '…' : ''}).`);
  if (codex) lines.push(`Codex AGENTS.md: ${fmt(tokens(codex))} tok · Gemini GEMINI.md: ${fmt(tokens(gemini || ''))} tok.`);
  const tips = [];
  const global = rows.filter(r => r.label.startsWith('Global') || r.label.trim().startsWith('imported')).reduce((n, r) => n + r.tokens, 0);
  if (global > 1500) tips.push(`Global instructions are ${fmt(global)} tokens: move project-specific sections into that project's CLAUDE.md or a skill, so other sessions stop paying for them.`);
  if (s.tokens > 1500) tips.push(`${s.count} skill descriptions cost ${fmt(s.tokens)} tokens per call: shorten long descriptions or disable skills you rarely use.`);
  if (otherStart.length > 1) tips.push('Several start-up hooks print context: keep each one short, or merge them.');
  if (tips.length) lines.push('Suggestions:', ...tips.map(t => '  · ' + t));
  return lines.join('\n');
}
const clipCmd = c => String(c).replace(/\s+2>\/dev\/null.*$/, '').slice(0, 60);
