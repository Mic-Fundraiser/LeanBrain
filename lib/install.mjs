// Connects LeanBrain to coding agents: a short rule in their global instructions, optional MCP
// registration and an optional Claude Code SessionStart hook. Every edit is idempotent and backed up.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {SCRIPT, atomic, readJSON} from './core.mjs';

const run = promisify(execFile);
const home = os.homedir();
const quoted = "'" + SCRIPT.replaceAll("'", "'\\''") + "'";
const BEGIN = '<!-- leanbrain:start -->', END = '<!-- leanbrain:end -->';
const OLD = [['<!-- atlante:start -->', '<!-- atlante:end -->']];

export const targets = () => ({
  claude: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'CLAUDE.md'),
  codex: path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'AGENTS.md'),
  gemini: path.join(home, '.gemini', 'GEMINI.md'),
});
const claudeSettings = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json');
const codexConfig = () => path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml');
const geminiSettings = () => path.join(home, '.gemini', 'settings.json');

export function ruleText() {
  return [BEGIN,
    '## LeanBrain — project memory and lean context',
    `CLI: \`node ${quoted}\` (written \`lb\` below). If no LeanBrain brief is in context yet, run \`lb brief\` first.`,
    '- Orient: `lb pack <project|.>` (≤500 tokens: purpose, stack, run/deploy, git, notes, last sessions) · `lb find <words>` · past work: `lb recall <words>`.',
    '- Code: `lb map .` · `lb sym <name>` · `lb grep <regex> [--glob "*.ts"]` · `lb read <file> --chat <id>` (outline, `--range a:b`, diff on re-reads). Read only the ranges you need.',
    '- Noisy commands: `lb run -- <cmd>` (failures + summary; full log `lb show <id>`). Prefer page text to screenshots unless the layout matters.',
    '- A "LeanBrain" message instead of file content is the token guard: use the outline or ranges, or repeat the same call to get everything.',
    '- Remember: `lb note . "<durable fact>"` · `lb todo . "<open thread>"`. Never store secrets.',
    END].join('\n');
}

async function readText(file) {
  try { return await fs.readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
}
async function backupAndWrite(file, before, after) {
  if (after === before) return false;
  await fs.mkdir(path.dirname(file), {recursive: true});
  if (before) await fs.copyFile(file, file + '.leanbrain-backup-' + randomUUID().slice(0, 8));
  await atomic(file, after);
  return true;
}
function replaceBlock(text, begin, end, block) {
  const start = text.indexOf(begin), stop = text.indexOf(end);
  if ((start < 0) !== (stop < 0) || (stop >= 0 && stop < start)) throw Error('Incomplete marker block (' + begin + ')');
  if (start < 0) return null;
  return text.slice(0, start) + block + text.slice(stop + end.length);
}

export async function installRules() {
  const done = [];
  for (const file of Object.values(targets())) {
    const before = await readText(file);
    let text = before;
    let next = replaceBlock(text, BEGIN, END, ruleText());
    if (next === null) for (const [b, e] of OLD) { next = replaceBlock(text, b, e, ruleText()); if (next !== null) break; }
    if (next === null) next = (text ? text.replace(/\n*$/, '\n\n') : '') + ruleText() + '\n';
    for (const [b, e] of OLD) { const cleaned = replaceBlock(next, b, e, ''); if (cleaned !== null) next = cleaned; }
    if (await backupAndWrite(file, before, next)) done.push(file);
  }
  return done;
}

export async function uninstallRules() {
  const done = [];
  for (const file of Object.values(targets())) {
    const before = await readText(file);
    const next = replaceBlock(before, BEGIN, END, '');
    if (next !== null && await backupAndWrite(file, before, next.replace(/\n{3,}/g, '\n\n'))) done.push(file);
  }
  return done;
}

const GUARD = {
  PreToolUse: {matcher: 'Read|Bash|Edit|Write|MultiEdit|NotebookEdit', command: `node ${quoted} hook pre-tool`, timeout: 5},
  SessionStart: {matcher: 'startup|resume|clear|compact', command: `node ${quoted} hook session-start`, timeout: 15},
  UserPromptSubmit: {command: `node ${quoted} hook prompt`, timeout: 5},
  PreCompact: {command: `node ${quoted} hook pre-compact`, timeout: 5},
};
const ours = h => String(h.command || '').includes('leanbrain.mjs');
function strip(settings) {
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    settings.hooks[event] = groups.map(g => ({...g, hooks: (g.hooks || []).filter(h => !ours(h))})).filter(g => g.hooks.length);
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
}
/** The guard: PreToolUse (Read|Bash), SessionStart, UserPromptSubmit and PreCompact hooks in Claude Code. */
export async function installHook() {
  const file = claudeSettings();
  const before = await readText(file);
  const settings = before ? JSON.parse(before) : {};
  settings.hooks ||= {};
  strip(settings);
  for (const [event, h] of Object.entries(GUARD)) {
    const entry = {hooks: [{type: 'command', command: h.command, timeout: h.timeout}]};
    if (h.matcher) entry.matcher = h.matcher;
    (settings.hooks[event] ||= []).push(entry);
  }
  return backupAndWrite(file, before, JSON.stringify(settings, null, 2) + '\n');
}
export async function uninstallHook() {
  const file = claudeSettings();
  const before = await readText(file);
  if (!before) return false;
  const settings = JSON.parse(before);
  strip(settings);
  return backupAndWrite(file, before, JSON.stringify(settings, null, 2) + '\n');
}

export async function installMcp() {
  const out = [];
  try {
    await run('claude', ['mcp', 'get', 'leanbrain'], {timeout: 20000});
    out.push('Claude Code: already registered');
  } catch {
    try { await run('claude', ['mcp', 'add', '--scope', 'user', 'leanbrain', '--', process.execPath, SCRIPT, 'mcp'], {timeout: 30000}); out.push('Claude Code: registered (user scope)'); }
    catch (e) { out.push('Claude Code: not registered (' + (e.code === 'ENOENT' ? 'claude CLI not found' : clipErr(e)) + ')'); }
  }
  const toml = codexConfig();
  const tomlBefore = await readText(toml);
  const block = `# leanbrain:start\n[mcp_servers.leanbrain]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(SCRIPT)}, "mcp"]\n# leanbrain:end`;
  const tomlNext = replaceBlock(tomlBefore, '# leanbrain:start', '# leanbrain:end', block) ?? ((tomlBefore ? tomlBefore.replace(/\n*$/, '\n\n') : '') + block + '\n');
  if (await fs.access(path.dirname(toml)).then(() => true, () => false)) out.push('Codex: ' + (await backupAndWrite(toml, tomlBefore, tomlNext) ? 'registered' : 'already registered'));
  const gem = geminiSettings();
  if (await fs.access(path.dirname(gem)).then(() => true, () => false)) {
    const before = await readText(gem);
    const settings = before ? JSON.parse(before) : {};
    settings.mcpServers ||= {};
    settings.mcpServers.leanbrain = {command: process.execPath, args: [SCRIPT, 'mcp']};
    out.push('Gemini CLI: ' + (await backupAndWrite(gem, before, JSON.stringify(settings, null, 2) + '\n') ? 'registered' : 'already registered'));
  }
  return out;
}
export async function uninstallMcp() {
  const out = [];
  try { await run('claude', ['mcp', 'remove', '--scope', 'user', 'leanbrain'], {timeout: 20000}); out.push('Claude Code: removed'); } catch {}
  const toml = codexConfig();
  const before = await readText(toml);
  const next = replaceBlock(before, '# leanbrain:start', '# leanbrain:end', '');
  if (next !== null && await backupAndWrite(toml, before, next.replace(/\n{3,}/g, '\n\n'))) out.push('Codex: removed');
  const gem = geminiSettings();
  const gBefore = await readText(gem);
  if (gBefore) {
    const s = JSON.parse(gBefore);
    if (s.mcpServers?.leanbrain) { delete s.mcpServers.leanbrain; await backupAndWrite(gem, gBefore, JSON.stringify(s, null, 2) + '\n'); out.push('Gemini CLI: removed'); }
  }
  return out;
}
const clipErr = e => String(e.stderr || e.message).trim().split('\n')[0].slice(0, 120);

export async function status() {
  const rules = {};
  for (const [agent, file] of Object.entries(targets())) {
    const text = await readText(file);
    rules[agent] = text.includes(BEGIN) ? (text.includes(SCRIPT) ? 'installed' : 'installed (other path)') : text.includes('<!-- atlante:start -->') ? 'old Atlante rule' : 'missing';
  }
  const settings = await readJSON(claudeSettings(), {}).catch(() => ({}));
  const hook = (settings.hooks?.PreToolUse || []).some(g => (g.hooks || []).some(h => /leanbrain\.mjs'? hook pre-tool/.test(String(h.command || ''))));
  const codex = (await readText(codexConfig())).includes('[mcp_servers.leanbrain]');
  const gemini = !!(await readJSON(geminiSettings(), {}).catch(() => ({}))).mcpServers?.leanbrain;
  let claudeMcp = false;
  const claudeJson = await readJSON(path.join(home, '.claude.json'), {}).catch(() => ({}));
  if (claudeJson.mcpServers?.leanbrain) claudeMcp = true;
  return {rules, hook, mcp: {claude: claudeMcp, codex, gemini}, script: SCRIPT};
}
