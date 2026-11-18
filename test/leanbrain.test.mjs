import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const SCRIPT = fileURLToPath(new URL('../leanbrain.mjs', import.meta.url));
async function sandbox(t) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'leanbrain-')));
  t.after(() => fs.rm(tmp, {recursive: true, force: true}));
  const env = {...process.env, HOME: tmp, USERPROFILE: tmp, LEANBRAIN_HOME: path.join(tmp, 'state'), ATLANTE_HOME: '',
    CLAUDE_CONFIG_DIR: path.join(tmp, '.claude'), CODEX_HOME: path.join(tmp, '.codex'), LEANBRAIN_USD_PER_MTOK: '3'};
  const run = (args, opts = {}) => execFileSync(process.execPath, [SCRIPT, ...args], {env, encoding: 'utf8', cwd: opts.cwd || tmp, input: opts.input});
  const fail = (args, opts = {}) => { try { run(args, opts); } catch (e) { return e; } throw Error('expected failure: ' + args.join(' ')); };
  return {tmp, env, run, fail};
}
const write = async (file, text) => { await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, text); };

test('scan, cards, notes, ranked find and project resolution', async t => {
  const {tmp, run, fail} = await sandbox(t);
  const work = path.join(tmp, 'work'), shop = path.join(work, 'shop-api'), mobile = path.join(work, 'mobile');
  await write(path.join(shop, 'package.json'), JSON.stringify({name: 'shop-api', description: 'Invoices and payments API', scripts: {dev: 'node server.js', test: 'node --test'}, dependencies: {express: '4'}}));
  await write(path.join(shop, 'README.md'), '# Shop API\n\n[![badge](x)](y)\n\nREST service that issues electronic invoices for the online shop.\n');
  await write(path.join(shop, 'docker-compose.yml'), 'services:\n  web:\n    image: x\n    ports:\n      - "8080:80"\n  db:\n    image: postgres\n');
  await write(path.join(shop, 'node_modules', 'dep', 'index.js'), 'x'.repeat(5000));
  await write(path.join(mobile, 'Package.swift'), '// swift');
  assert.match(run(['scan', work]), /Indexed 2 projects/);
  const card = run(['pack', 'shop-api']);
  assert.match(card, /# shop-api — /);
  assert.match(card, /Invoices and payments API/);
  assert.match(card, /npm run dev\|test/);
  assert.match(card, /compose: web 8080:80; db/);
  assert.match(card, /Express/);
  assert.match(run(['pack', '.'], {cwd: shop}), /shop-api/);
  run(['note', 'mobile', 'Push notifications use APNs certificates in the keychain']);
  assert.match(run(['find', 'notificatons']), /mobile/, 'typo tolerant search over notes');
  assert.match(run(['find', 'invoice']), /shop-api/);
  assert.match(run(['ctx', 'shop-api']), /Scripts:\n {2}dev: node server\.js/);
  assert.match(run(['ctx', 'shop-api']), /dependencies\/build/);
  assert.match(fail(['pack', 'nothing-like-this']).stderr, /No project matches/);
  assert.match(fail(['note', 'mobile', 'token sk-ant-abcdefghijklmnopqrstuvwxyz']).stderr, /secret/);
  assert.match(run(['todo', 'shop-api', 'Rotate the payment webhook']), /Todo #1/);
  assert.match(run(['todo']), /#1 shop-api/);
  assert.match(run(['pack', 'shop-api']), /Open:\n- #1 Rotate the payment webhook/);
  assert.match(run(['todo', '--done', '1']), /Closed #1/);
  assert.match(run(['brief'], {cwd: shop}), /Here: shop-api/);
});

test('catalogue import keeps remote entries and the card respects its token budget', async t => {
  const {tmp, run} = await sandbox(t);
  const data = path.join(tmp, 'cervello', 'dati'), work = path.join(tmp, 'docs');
  await write(path.join(work, 'draft.txt'), 'draft');
  await write(path.join(data, 'progetti.json'), JSON.stringify([
    {id: 'local', nome: 'Notebook', locale: {percorso: work}, url: ['https://example.org'], deploy: './deploy.sh', aperti: ['Fix the footer']},
    {id: 'remote', nome: 'Archive', descrizione: 'Historical collection', stato: 'online'},
  ]));
  run(['catalog', path.dirname(data)]);
  run(['scan']);
  const index = JSON.parse(await fs.readFile(path.join(tmp, 'state', 'index.json'), 'utf8'));
  assert.equal(index.projects.length, 2);
  assert.equal(index.folders[0].small, 1);
  assert.match(run(['find', 'historical']), /Archive — catalogue/);
  const card = run(['pack', 'Notebook']);
  assert.match(card, /Live: https:\/\/example\.org/);
  assert.match(card, /Deploy: \.\/deploy\.sh/);
  assert.match(card, /- Fix the footer/);
  for (let i = 0; i < 8; i++) run(['note', 'Notebook', 'a durable fact number ' + i + ' '.repeat(10) + 'x'.repeat(400)]);
  const {countTokens} = await import('gpt-tokenizer/encoding/o200k_base');
  assert.ok(countTokens(run(['pack', 'Notebook', '--budget', '300'])) <= 310);
  assert.match(run(['pack', 'cervello:remote']), /Historical collection/);
});

test('repo map, symbols, grouped grep, outline reads, diffs on re-read and excerpts', async t => {
  const {tmp, run} = await sandbox(t);
  const root = path.join(tmp, 'app');
  await write(path.join(root, 'package.json'), '{}');
  await write(path.join(root, 'src', 'billing.js'), 'export function createInvoice(order) {\n  return totalOf(order);\n}\nexport const totalOf = (o) => o.items.length;\nexport class InvoiceStore {\n  save(invoice) {\n    return invoice;\n  }\n}\n');
  await write(path.join(root, 'src', 'routes.js'), "import {createInvoice} from './billing.js';\nexport function route(req) {\n  return createInvoice(req.body);\n}\n");
  await write(path.join(root, 'server.py'), 'class Server:\n    def handle(self):\n        pass\n\ndef main():\n    Server().handle()\n');
  const big = Array.from({length: 900}, (_, i) => i % 50 === 0 ? `function step${i}() {\n  return ${i};\n}` : `// filler line ${i} with some words to make it long enough`).join('\n');
  await write(path.join(root, 'src', 'big.js'), big);
  run(['scan', root]);
  const map = run(['map', '.'], {cwd: root});
  assert.match(map, /src\/billing\.js \(9\)\n {2}.*createInvoice\(\):1/);
  assert.match(map, /InvoiceStore:5/);
  assert.match(run(['sym', 'createInvoice'], {cwd: root}), /createInvoice · fn · src\/billing\.js:1/);
  const grep = run(['grep', 'createinvoice'], {cwd: root});
  assert.match(grep, /3 matches in 2 files/);
  assert.match(grep, /src\/routes\.js \(2\)\n {2}1: import/);
  assert.match(run(['grep', 'Invoice', '--glob', '*.py'], {cwd: root}), /No match/);
  const outline = run(['read', 'src/big.js'], {cwd: root});
  assert.match(outline, /outline \(\d+ symbols\)/);
  assert.match(outline, /53: function step50\(\)/);
  assert.match(run(['read', 'src/big.js', '--range', '2:3'], {cwd: root}), /^src\/big\.js lines 2-3 of 936\n2\| /);
  const first = run(['read', 'src/billing.js', '--chat', 'c1'], {cwd: root});
  assert.match(first, /createInvoice/);
  assert.match(run(['read', 'src/billing.js', '--chat', 'c1'], {cwd: root}), /unchanged since your last read/);
  await fs.appendFile(path.join(root, 'src', 'billing.js'), 'export function refund(id) {\n  return id;\n}\n');
  const diff = run(['read', 'src/billing.js', '--chat', 'c1'], {cwd: root});
  assert.match(diff, /changed since your last read/);
  assert.match(diff, /\+ export function refund\(id\) \{/);
  assert.doesNotMatch(diff, /class InvoiceStore/);
  assert.match(run(['read', 'src/billing.js', '--chat', 'c2'], {cwd: root}), /^export function createInvoice/, 'another chat reads the full file');
  assert.match(run(['excerpt', 'app', 'src/big.js', 'step100', 'x']), /1 matches · src\/big\.js\n104 \| .*\n105 \| function step100/);
  assert.match(run(['excerpt', 'app', 'src/big.js', 'step100', 'x']), /unchanged in this chat/);
  const gain = run(['gain']);
  assert.match(gain, /repo maps/);
  assert.match(gain, /avoided re-reads/);
});

test('run compresses noisy output, keeps the raw log and preserves the exit code', async t => {
  const {run, env} = await sandbox(t);
  const script = 'for(let i=0;i<200;i++)console.log("✓ case "+i+" passed in "+(i%9)+"ms");console.log("✗ case 200 failed");console.log("  AssertionError: expected 1 to equal 2");console.log("Tests: 1 failed, 200 passed, 201 total");process.exit(4)';
  let error;
  try { run(['run', '--', process.execPath, '-e', script]); } catch (e) { error = e; }
  assert.equal(error.status, 4);
  assert.match(error.stdout, /✗ case 200 failed/);
  assert.match(error.stdout, /Tests: 1 failed/);
  assert.ok(error.stdout.split('\n').length < 20);
  const id = error.stdout.match(/leanbrain show (r[0-9a-f]{6})/)[1];
  assert.match(run(['show', id, '--grep', 'case 150']), /✓ case 150 passed/);
  const filtered = execFileSync(process.execPath, [SCRIPT, 'filter'], {env, encoding: 'utf8', input: 'same line\n'.repeat(500) + 'ERROR: disk full\n'});
  assert.match(filtered, /×500 identical lines/);
  assert.match(filtered, /ERROR: disk full/);
});

test('agent sessions: incremental sync, attribution, usage dedupe, recall', async t => {
  const {tmp, run} = await sandbox(t);
  const project = path.join(tmp, 'site');
  await write(path.join(project, 'package.json'), '{}');
  run(['scan', project]);
  const dir = path.join(tmp, '.claude', 'projects', '-site');
  const line = o => JSON.stringify(o) + '\n';
  const usage = {input_tokens: 10, output_tokens: 1000, cache_read_input_tokens: 100000, cache_creation_input_tokens: 2000};
  const transcript = [
    line({type: 'user', cwd: project, sessionId: 's1', timestamp: '2026-11-10T10:00:00Z', message: {role: 'user', content: '<system-reminder>ignore me</system-reminder>Add a newsletter signup guard against fake emails'}}),
    line({type: 'assistant', cwd: project, timestamp: '2026-11-10T10:01:00Z', message: {id: 'm1', model: 'claude-opus-5-5', usage, content: [{type: 'tool_use', name: 'Edit', input: {file_path: path.join(project, 'guard.js')}}]}}),
    line({type: 'assistant', cwd: project, timestamp: '2026-11-10T10:01:01Z', message: {id: 'm1', model: 'claude-opus-5-5', usage, content: [{type: 'text', text: 'Added guard.js blocking disposable domains.'}]}}),
    line({type: 'user', cwd: project, timestamp: '2026-11-10T10:02:00Z', message: {role: 'user', content: [{type: 'tool_result', content: 'x'.repeat(5000)}]}}),
  ].join('');
  await write(path.join(dir, 's1.jsonl'), transcript);
  await write(path.join(tmp, '.codex', 'sessions', '2026', '11', '11', 'rollout-2026-11-11T09-00-00-abc.jsonl'), [
    line({timestamp: '2026-11-11T09:00:00Z', type: 'session_meta', payload: {id: 'codex-1', cwd: project, timestamp: '2026-11-11T09:00:00Z'}}),
    line({timestamp: '2026-11-11T09:00:01Z', type: 'turn_context', payload: {model: 'gpt-x'}}),
    line({timestamp: '2026-11-11T09:00:02Z', type: 'response_item', payload: {type: 'message', role: 'user', content: [{type: 'input_text', text: '<environment_context>x</environment_context>'}]}}),
    line({timestamp: '2026-11-11T09:00:03Z', type: 'response_item', payload: {type: 'message', role: 'user', content: [{type: 'input_text', text: 'Translate the footer to English'}]}}),
    line({timestamp: '2026-11-11T09:00:04Z', type: 'response_item', payload: {type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: footer.html\n'}}),
    line({timestamp: '2026-11-11T09:00:05Z', type: 'event_msg', payload: {type: 'token_count', info: {total_token_usage: {input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 300}}}}),
    line({timestamp: '2026-11-11T09:00:06Z', type: 'event_msg', payload: {type: 'task_complete', last_agent_message: 'Footer translated.'}}),
  ].join(''));
  assert.match(run(['sessions', '--sync']), /2 sessions remembered/);
  const list = run(['sessions', '--in', 'site']);
  assert.match(list, /claude · 1 file · "Add a newsletter signup guard against fake emails" → Added guard\.js/);
  assert.match(list, /codex · 1 file · "Translate the footer to English" → Footer translated\./);
  assert.match(run(['recall', 'disposable']), /newsletter signup guard/);
  assert.match(run(['pack', 'site']), /Recent sessions:/);
  const usageText = run(['usage', '--days', '3650']);
  assert.match(usageText, /2 sessions/);
  assert.match(usageText, /104k cache read/, 'duplicated message ids count once');
  await fs.appendFile(path.join(dir, 's1.jsonl'), line({type: 'user', cwd: project, timestamp: '2026-11-12T08:00:00Z', message: {role: 'user', content: 'Now also rate limit the endpoint'}}));
  assert.match(run(['sessions', '--sync']), /1 transcript files read/);
  assert.match(run(['recall', 'rate limit']), /newsletter signup guard/);
  const db = JSON.parse(await fs.readFile(path.join(tmp, 'state', 'sessions.json'), 'utf8'));
  assert.equal(db.sessions.s1.last, 'Now also rate limit the endpoint');
  assert.equal(db.sessions.s1.usage['claude-opus-5-5'].cr, 100000);
});

test('MCP server answers initialize, tools/list and tools/call', async t => {
  const {tmp, env, run} = await sandbox(t);
  const root = path.join(tmp, 'tool');
  await write(path.join(root, 'go.mod'), 'module tool');
  await write(path.join(root, 'main.go'), 'package main\n\nfunc main() {}\n\nfunc Serve(port int) error { return nil }\n');
  run(['scan', root]);
  const child = spawn(process.execPath, [SCRIPT, 'mcp'], {env, cwd: root});
  const replies = [];
  let buffer = '';
  child.stdout.on('data', d => { buffer += d; let i; while ((i = buffer.indexOf('\n')) >= 0) { replies.push(JSON.parse(buffer.slice(0, i))); buffer = buffer.slice(i + 1); } });
  const send = m => child.stdin.write(JSON.stringify(m) + '\n');
  send({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'test', version: '1'}}});
  send({jsonrpc: '2.0', method: 'notifications/initialized'});
  send({jsonrpc: '2.0', id: 2, method: 'tools/list'});
  send({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'map', arguments: {project: 'tool'}}});
  send({jsonrpc: '2.0', id: 4, method: 'tools/call', params: {name: 'pack', arguments: {project: 'no-such-project'}}});
  send({jsonrpc: '2.0', id: 5, method: 'bogus'});
  child.stdin.end();
  await new Promise(resolve => child.on('close', resolve));
  const byId = Object.fromEntries(replies.map(r => [r.id, r]));
  assert.equal(byId[1].result.protocolVersion, '2025-06-18');
  assert.equal(byId[1].result.serverInfo.name, 'leanbrain');
  assert.deepEqual(byId[2].result.tools.map(x => x.name), ['brief', 'find', 'pack', 'map', 'grep', 'read', 'recall', 'note']);
  assert.match(byId[3].result.content[0].text, /main\.go \(5\)\n {2}.*Serve\(\):5/);
  assert.equal(byId[4].result.isError, true);
  assert.equal(byId[5].error.code, -32601);
});

test('install replaces the old Atlante rule, is idempotent, and uninstall cleans up', async t => {
  const {tmp, run} = await sandbox(t);
  const rules = path.join(tmp, '.claude', 'CLAUDE.md');
  await write(rules, 'My own rule\n\n<!-- atlante:start -->\n## Atlante\nold text\n<!-- atlante:end -->\n\nAnother rule\n');
  await write(path.join(tmp, '.claude', 'settings.json'), JSON.stringify({hooks: {SessionStart: [{matcher: 'startup', hooks: [{type: 'command', command: 'other brief'}]}]}}));
  run(['install', '--hook']);
  const first = await fs.readFile(rules, 'utf8');
  assert.match(first, /My own rule/);
  assert.match(first, /Another rule/);
  assert.match(first, /<!-- leanbrain:start -->/);
  assert.doesNotMatch(first, /atlante:start|old text/);
  assert.ok(first.indexOf('leanbrain:start') < first.indexOf('Another rule'), 'replaced in place');
  run(['install', '--hook']);
  assert.equal(await fs.readFile(rules, 'utf8'), first);
  const settings = JSON.parse(await fs.readFile(path.join(tmp, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.hooks.SessionStart.length, 2);
  assert.match(settings.hooks.SessionStart[1].hooks[0].command, /leanbrain\.mjs' hook session-start/);
  assert.match(run(['status']), /claude installed/);
  run(['uninstall', '--all']);
  assert.doesNotMatch(await fs.readFile(rules, 'utf8'), /leanbrain/);
  const after = JSON.parse(await fs.readFile(path.join(tmp, '.claude', 'settings.json'), 'utf8'));
  assert.equal(after.hooks.SessionStart.length, 1);
  assert.match(await fs.readFile(path.join(tmp, '.codex', 'AGENTS.md'), 'utf8').catch(() => ''), /^$|^\s*$/);
});

test('first run migrates Atlante data from ~/.atlante', async t => {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'leanbrain-mig-')));
  t.after(() => fs.rm(tmp, {recursive: true, force: true}));
  const project = path.join(tmp, 'old');
  await write(path.join(project, 'package.json'), '{}');
  await write(path.join(tmp, '.atlante', 'index.json'), JSON.stringify({roots: [tmp], projects: [{id: project, name: 'old', types: ['Node.js'], guides: [], size: 2, small: 1, count: 1, generated: 0}], large: [], folders: [], date: new Date().toISOString()}));
  await write(path.join(tmp, '.atlante', 'notes.jsonl'), JSON.stringify({id: project, date: '2026-01-01T00:00:00.000Z', text: 'Imported from Atlante'}) + '\n');
  const env = {...process.env, HOME: tmp, USERPROFILE: tmp, CLAUDE_CONFIG_DIR: path.join(tmp, '.claude'), CODEX_HOME: path.join(tmp, '.codex')};
  delete env.LEANBRAIN_HOME; delete env.ATLANTE_HOME;
  const out = execFileSync(process.execPath, [SCRIPT, 'pack', 'old'], {env, encoding: 'utf8', cwd: tmp});
  assert.match(out, /Imported from Atlante/);
  assert.ok(await fs.stat(path.join(tmp, '.leanbrain', 'index.json')));
  const shim = execFileSync(process.execPath, [fileURLToPath(new URL('../atlante.mjs', import.meta.url)), 'find', 'old'], {env, encoding: 'utf8', cwd: tmp});
  assert.match(shim, /1\. old/);
});

test('guard: outline for big first reads, escape hatch, stubs for unchanged re-reads, diffs after edits, Bash readers', async t => {
  const {tmp, env, run} = await sandbox(t);
  const hook = (event, payload) => {
    const out = execFileSync(process.execPath, [SCRIPT, 'hook', event], {env, encoding: 'utf8', input: JSON.stringify(payload)});
    return out.trim() ? JSON.parse(out) : null;
  };
  const reason = r => r?.hookSpecificOutput?.permissionDecisionReason || '';
  const file = path.join(tmp, 'big.js');
  const body = Array.from({length: 120}, (_, i) => `export function handler${i}(req) {\n${'  // validate payload, write the audit entry and update the counters\n'.repeat(12)}  return ${i};\n}`).join('\n') + '\n';
  await write(file, body);
  const read = (extra = {}) => hook('pre-tool', {session_id: 's1', tool_name: 'Read', tool_input: {file_path: file, ...extra}, cwd: tmp});
  const first = read();
  assert.equal(first.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(reason(first), /is large \(1800 lines/);
  assert.match(reason(first), /1: export function handler0\(req\)/);
  assert.equal(read(), null, 'repeating the same call goes through');
  assert.match(reason(read()), /unchanged since you read it earlier/);
  assert.match(reason(read({offset: 100, limit: 50})), /lines 100-149 are unchanged/);
  const bash = command => hook('pre-tool', {session_id: 's1', tool_name: 'Bash', tool_input: {command}, cwd: tmp});
  assert.match(reason(bash(`sed -n '20,40p' big.js`)), /lines 20-40 are unchanged/);
  assert.match(reason(bash(`cd ${tmp} && cat big.js`)), /unchanged/);
  assert.equal(bash('cat big.js | wc -l'), null, 'pipelines are never touched');
  assert.equal(bash('npm test'), null);
  await fs.writeFile(file, body.replace('return 7;', 'return 7000;'));
  const diff = read();
  assert.match(reason(diff), /changed since you read it/);
  assert.match(reason(diff), /- {3}return 7;\n\+ {3}return 7000;\n {2}\}/);
  assert.equal(hook('pre-tool', {session_id: 's2', tool_name: 'Read', tool_input: {file_path: path.join(tmp, 'missing.js')}}), null);
  assert.equal(hook('pre-compact', {session_id: 's1', trigger: 'auto'}), null);
  assert.match(reason(read()), /is large/, 'after compaction the memory is reset');
  assert.equal(execFileSync(process.execPath, [SCRIPT, 'hook', 'pre-tool'], {env, encoding: 'utf8', input: 'not json'}), '', 'errors fail open');
  assert.match(run(['gain']), /guard: outlines of big files/);
  run(['install', '--guard']);
  const settings = JSON.parse(await fs.readFile(path.join(tmp, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.hooks.PreToolUse[0].matcher, 'Read|Bash|Edit|Write|MultiEdit|NotebookEdit');
  assert.match(settings.hooks.UserPromptSubmit[0].hooks[0].command, /hook prompt$/);
  assert.match(run(['status']), /Guard \(Claude Code hooks\): on/);
});

test('session-start and prompt hooks inject the brief and the card of a named project', async t => {
  const {tmp, env, run} = await sandbox(t);
  const shop = path.join(tmp, 'shopfront'), billing = path.join(tmp, 'billing-engine');
  await write(path.join(shop, 'package.json'), JSON.stringify({description: 'Storefront for the online shop'}));
  await write(path.join(billing, 'package.json'), JSON.stringify({description: 'Computes invoices and taxes'}));
  run(['scan', tmp]);
  const hook = (event, payload) => JSON.parse(execFileSync(process.execPath, [SCRIPT, 'hook', event], {env, encoding: 'utf8', input: JSON.stringify(payload)}) || 'null');
  const start = hook('session-start', {session_id: 'p1', source: 'startup', cwd: shop});
  assert.match(start.hookSpecificOutput.additionalContext, /LeanBrain · 2 projects/);
  assert.match(start.hookSpecificOutput.additionalContext, /# shopfront — /);
  const named = hook('prompt', {session_id: 'p1', cwd: shop, prompt: 'Use the tax rules from billing-engine here'});
  assert.match(named.hookSpecificOutput.additionalContext, /card for "billing-engine"/);
  assert.match(named.hookSpecificOutput.additionalContext, /Computes invoices and taxes/);
  assert.equal(hook('prompt', {session_id: 'p1', cwd: shop, prompt: 'and again billing-engine'}), null, 'once per session');
  assert.match(run(['audit']), /Fixed context audit/);
});

test('immunity, collision radar, déjà vu and pause tax', async t => {
  const {tmp, env, run} = await sandbox(t);
  const site = path.join(tmp, 'site'), shop = path.join(tmp, 'shop');
  await write(path.join(site, 'package.json'), '{}');
  await write(path.join(shop, 'package.json'), '{}');
  run(['scan', tmp]);
  const line = o => JSON.stringify(o) + '\n';
  const now = Date.now();
  const iso = ms => new Date(ms).toISOString();
  const usage = cw => ({input_tokens: 5, output_tokens: 500, cache_read_input_tokens: 90000, cache_creation_input_tokens: cw});
  const rows = [
    line({type: 'user', cwd: site, timestamp: iso(now - 9 * 86400e3), message: {role: 'user', content: 'Add rate limiting to the signup endpoint against bots'}}),
    line({type: 'assistant', cwd: site, timestamp: iso(now - 9 * 86400e3 + 1000), message: {id: 'a1', model: 'claude-opus-5-5', usage: usage(1000), content: [{type: 'tool_use', id: 't1', name: 'Bash', input: {command: 'frobnicate-xyz --fast'}}]}}),
    line({type: 'user', cwd: site, timestamp: iso(now - 9 * 86400e3 + 2000), message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Exit code 127\nzsh: command not found: frobnicate-xyz'}]}}),
    line({type: 'assistant', cwd: site, timestamp: iso(now - 9 * 86400e3 + 3000), message: {id: 'a2', model: 'claude-opus-5-5', usage: usage(1000), content: [{type: 'tool_use', id: 't2', name: 'Bash', input: {command: 'frobnicate-xyz'}}]}}),
    line({type: 'user', cwd: site, timestamp: iso(now - 9 * 86400e3 + 4000), message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'Exit code 127\nbash: line 1: frobnicate-xyz: command not found'}]}}),
    line({type: 'assistant', cwd: site, timestamp: iso(now - 9 * 86400e3 + 20 * 60e3), message: {id: 'a3', model: 'claude-opus-5-5', usage: usage(50000), content: [{type: 'text', text: 'Rate limiting added with a sliding window per IP in limiter.js.'}]}}),
  ].join('');
  await write(path.join(tmp, '.claude', 'projects', '-site', 'old.jsonl'), rows);
  run(['sessions', '--sync']);
  assert.match(run(['immunity']), /frobnicate-xyz {0,}failed 2×/);
  assert.match(run(['pauses', '--days', '30']), /Pauses of 5–60 min: 1 rebuilds/);
  const hook = (event, payload) => { const out = execFileSync(process.execPath, [SCRIPT, 'hook', event], {env, encoding: 'utf8', input: JSON.stringify(payload)}); return out.trim() ? JSON.parse(out) : null; };
  const reason = r => r?.hookSpecificOutput?.permissionDecisionReason || '';
  assert.match(reason(hook('pre-tool', {session_id: 'n1', tool_name: 'Bash', tool_input: {command: 'cd /tmp && frobnicate-xyz run'}, cwd: shop})), /LeanBrain immunity: frobnicate-xyz is not available/);
  assert.equal(hook('pre-tool', {session_id: 'n1', tool_name: 'Bash', tool_input: {command: 'cd /tmp && frobnicate-xyz run'}, cwd: shop}), null, 'repeat runs it anyway');
  const deja = hook('prompt', {session_id: 'n1', cwd: shop, prompt: 'Please add rate limiting to our signup endpoint'});
  assert.match(deja.hookSpecificOutput.additionalContext, /déjà vu/);
  assert.match(deja.hookSpecificOutput.additionalContext, /site · claude · "Add rate limiting to the signup endpoint against bots" → Rate limiting added/);
  const file = path.join(shop, 'index.js');
  await write(file, 'x');
  assert.equal(hook('pre-tool', {session_id: 'n1', tool_name: 'Edit', tool_input: {file_path: file}, cwd: shop}), null);
  assert.match(reason(hook('pre-tool', {session_id: 'n2', tool_name: 'Write', tool_input: {file_path: file}, cwd: shop})), /LeanBrain radar: another claude session edited/);
  assert.equal(hook('pre-tool', {session_id: 'n2', tool_name: 'Write', tool_input: {file_path: file}, cwd: shop}), null, 'repeat proceeds');
  const radar = hook('prompt', {session_id: 'n3', cwd: shop, prompt: 'continue'});
  assert.match(radar.hookSpecificOutput.additionalContext, /LeanBrain radar: another claude session is active in shop/);
  assert.match(run(['radar']), /Radar · sessions active/);
});
