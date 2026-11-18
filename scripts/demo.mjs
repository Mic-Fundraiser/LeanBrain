#!/usr/bin/env node
// Builds a fictional workspace (projects, git history, Claude Code and Codex transcripts, notes, savings)
// and serves the dashboard on it. Used for screenshots and for trying LeanBrain without touching real data.
//   node scripts/demo.mjs [--port 4321] [--no-serve]
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOME = path.join(await fs.realpath(os.tmpdir()), 'leanbrain-demo');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 4321;
let seed = 7;
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = list => list[Math.floor(rand() * list.length)];
const between = (a, b) => Math.round(a + rand() * (b - a));
const write = async (file, text) => { await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, text); };
const daysAgo = (d, h = 10) => new Date(Date.now() - d * 86400e3 + h * 3600e3 - 12 * 3600e3);

const PROJECTS = [
  {dir: 'shop-api', pkg: {name: 'shop-api', description: 'REST service that issues electronic invoices and handles refunds for the online shop.', scripts: {dev: 'tsx watch src/server.ts', test: 'vitest run', build: 'tsc -p .', lint: 'eslint .', deploy: './deploy.sh production'}, dependencies: {express: '5', prisma: '6', stripe: '18'}, devDependencies: {typescript: '5', vitest: '3'}},
    compose: 'services:\n  api:\n    build: .\n    ports:\n      - "8080:80"\n  db:\n    image: postgres:17\n    ports:\n      - "5432:5432"\n',
    files: {'src/server.ts': 'import express from "express";\nimport {invoices} from "./routes/invoices";\nimport {refunds} from "./routes/refunds";\nexport function createServer() {\n  const app = express();\n  app.use("/invoices", invoices);\n  app.use("/refunds", refunds);\n  return app;\n}\n',
      'src/routes/invoices.ts': 'import {Router} from "express";\nimport {issueInvoice, findInvoice} from "../services/billing";\nexport const invoices = Router();\ninvoices.post("/", async (req, res) => res.json(await issueInvoice(req.body)));\ninvoices.get("/:id", async (req, res) => res.json(await findInvoice(req.params.id)));\n',
      'src/routes/refunds.ts': 'import {Router} from "express";\nimport {refundInvoice} from "../services/billing";\nexport const refunds = Router();\nrefunds.post("/:id", async (req, res) => res.json(await refundInvoice(req.params.id)));\n',
      'src/services/billing.ts': 'import {db} from "../db";\nexport async function issueInvoice(order: Order) {\n  const total = totalOf(order);\n  return db.invoice.create({data: {total}});\n}\nexport async function findInvoice(id: string) {\n  return db.invoice.findUnique({where: {id}});\n}\nexport async function refundInvoice(id: string) {\n  const invoice = await findInvoice(id);\n  return db.refund.create({data: {invoiceId: invoice.id}});\n}\nexport const totalOf = (order: Order) => order.items.reduce((n, i) => n + i.price, 0);\nexport interface Order { items: {price: number}[] }\n',
      'src/db.ts': 'import {PrismaClient} from "@prisma/client";\nexport const db = new PrismaClient();\n'},
    readme: '# Shop API\n\nREST service that issues electronic invoices and handles refunds for the online shop.\n', brain: true},
  {dir: 'storefront', pkg: {name: 'storefront', description: 'Next.js storefront with product search, cart and checkout.', scripts: {dev: 'next dev', build: 'next build', start: 'next start', test: 'playwright test'}, dependencies: {next: '16', react: '19', tailwindcss: '4'}, devDependencies: {'@playwright/test': '1'}},
    files: {'app/page.tsx': 'export default function Home() {\n  return <ProductGrid />;\n}\nexport function ProductGrid() {\n  return null;\n}\n', 'app/cart/page.tsx': 'export default function Cart() {\n  return null;\n}\n', 'lib/search.ts': 'export async function searchProducts(q: string) {\n  return fetch("/api/search?q=" + q);\n}\n'}},
  {dir: 'billing-engine', py: '[project]\nname = "billing-engine"\ndescription = "Computes taxes, discounts and multi-currency totals for invoices."\ndependencies = ["fastapi", "pydantic", "uvicorn"]\n[project.scripts]\nbilling = "billing.cli:main"\n',
    files: {'billing/taxes.py': 'RATES = {"IT": 0.22, "DE": 0.19, "FR": 0.20}\n\ndef vat_for(country, amount):\n    return round(amount * RATES.get(country, 0), 2)\n\nclass TaxEngine:\n    def compute(self, invoice):\n        return vat_for(invoice.country, invoice.total)\n', 'billing/api.py': 'from fastapi import FastAPI\nfrom .taxes import TaxEngine\n\napp = FastAPI()\n\n@app.post("/quote")\ndef quote(invoice):\n    return TaxEngine().compute(invoice)\n'}},
  {dir: 'data-pipeline', py: '[project]\nname = "data-pipeline"\ndescription = "Nightly ETL that loads orders into the warehouse and builds sales reports."\ndependencies = ["pandas", "sqlalchemy"]\n', make: 'extract:\n\tpython -m pipeline.extract\nload:\n\tpython -m pipeline.load\nreport:\n\tpython -m pipeline.report\n',
    files: {'pipeline/extract.py': 'def extract_orders(since):\n    return []\n', 'pipeline/report.py': 'def weekly_sales(df):\n    return df\n'}},
  {dir: 'mobile-app', swift: '// swift-tools-version:6.0\nimport PackageDescription\nlet package = Package(name: "ShopMobile")\n', files: {'Sources/App/CartView.swift': 'import SwiftUI\nstruct CartView: View {\n  var body: some View { Text("Cart") }\n}\nfunc checkout() {}\n'}},
  {dir: 'docs-site', pkg: {name: 'docs-site', description: 'Developer documentation built with Astro.', scripts: {dev: 'astro dev', build: 'astro build'}, dependencies: {astro: '6'}}, files: {'src/pages/index.md': '# Developer docs\n\n## Invoices API\n\n## Webhooks\n'}},
  {dir: 'infra', compose: 'services:\n  proxy:\n    image: caddy\n    ports:\n      - "443:443"\n  metrics:\n    image: prom/prometheus\n    ports:\n      - "9090:9090"\n', make: 'deploy:\n\t./deploy.sh\nbackup:\n\t./backup.sh\n', files: {'deploy.sh': '#!/bin/sh\ndeploy() {\n  echo deploy\n}\n'}, readme: '# Infra\n\nCaddy, Prometheus and backup jobs for the production servers.\n'},
  {dir: 'ml-ranker', py: '[project]\nname = "ml-ranker"\ndescription = "Learning-to-rank model that orders search results by purchase likelihood."\ndependencies = ["torch", "pandas"]\n', files: {'ranker/model.py': 'class Ranker:\n    def fit(self, data):\n        pass\n    def score(self, items):\n        return items\n'}},
  {dir: 'cli-tools', go: 'module example.com/cli-tools\n\ngo 1.25\n', files: {'main.go': 'package main\n\nfunc main() {}\n\nfunc SyncCatalog(path string) error { return nil }\n'}, readme: '# cli-tools\n\nSmall Go commands to sync the product catalog and rotate API keys.\n'},
  {dir: 'design-system', pkg: {name: '@shop/design-system', description: 'React component library with tokens, themes and visual tests.', scripts: {dev: 'storybook dev', test: 'vitest', build: 'tsup'}, dependencies: {react: '19'}, devDependencies: {vitest: '3', typescript: '5'}}, files: {'src/Button.tsx': 'export function Button() {\n  return null;\n}\n', 'src/tokens.ts': 'export const colors = {brand: "#059669"};\n'}},
];

const TASKS = {
  'shop-api': [['Add idempotency keys to POST /invoices', 'Added an idempotency middleware and 6 tests; all green.'], ['Why do refunds time out under load?', 'Missing index on refunds.invoice_id; migration 042 adds it and p95 drops from 2.3 s to 90 ms.'], ['Rotate the Stripe webhook secret without downtime', 'Dual-secret verification shipped; old secret can be removed on Friday.'], ['Write the changelog for v2.4', 'Changelog drafted from 31 merged PRs.']],
  storefront: [['Make product search tolerate typos', 'Search now uses trigram matching; “sneker” finds sneakers.'], ['Fix the cart badge flicker on mobile', 'Badge state moved to the server component; no more flicker.'], ['Add Playwright tests for checkout', '12 checkout tests added, running in 41 s.']],
  'billing-engine': [['Support reverse charge for EU B2B invoices', 'Reverse charge rules added for 27 countries with tests.'], ['Explain how rounding works in multi-currency totals', 'Banker’s rounding per line, totals in minor units; documented in ROUNDING.md.']],
  'data-pipeline': [['The nightly ETL failed twice this week', 'Timeout on the orders export; batched the query and added a retry.'], ['Weekly sales report by region', 'Report job added; first run produced 14 regions.']],
  'mobile-app': [['Implement Apple Pay in the cart', 'Apple Pay sheet wired to the payments endpoint; sandbox purchase works.']],
  'docs-site': [['Document the webhooks API', 'Webhooks page with signing, retries and examples published.']],
  infra: [['Set up daily database backups', 'Backups at 03:00 with 14-day retention; restore tested.'], ['Why is the proxy returning 502?', 'Upstream port changed in the last deploy; Caddyfile fixed.']],
  'ml-ranker': [['Retrain the ranker on last month of orders', 'NDCG@10 up from 0.61 to 0.66 on the holdout set.']],
  'cli-tools': [['Add a command to sync the product catalog', 'sync-catalog command with dry-run and progress output.']],
  'design-system': [['Add a dark theme to the tokens', 'Dark tokens added; contrast checked on all components.']],
};
const CLAUDE_MODELS = [['claude-opus-5-5', 0.62], ['claude-fable-5-2', 0.16], ['claude-sonnet-5-5', 0.14], ['claude-haiku-5-5', 0.08]];
const CODEX_MODELS = ['gpt-6.2-astra', 'gpt-6.2-sol'];
const modelPick = () => { let r = rand(); for (const [m, p] of CLAUDE_MODELS) { if ((r -= p) <= 0) return m; } return 'claude-opus-5-5'; };

async function build() {
  await fs.rm(HOME, {recursive: true, force: true});
  const code = path.join(HOME, 'code');
  for (const p of PROJECTS) {
    const dir = path.join(code, p.dir);
    if (p.pkg) await write(path.join(dir, 'package.json'), JSON.stringify(p.pkg, null, 2));
    if (p.py) await write(path.join(dir, 'pyproject.toml'), p.py);
    if (p.swift) await write(path.join(dir, 'Package.swift'), p.swift);
    if (p.go) await write(path.join(dir, 'go.mod'), p.go);
    if (p.compose) await write(path.join(dir, 'docker-compose.yml'), p.compose);
    if (p.make) await write(path.join(dir, 'Makefile'), p.make);
    await write(path.join(dir, 'README.md'), p.readme || `# ${p.dir}\n\n${p.pkg?.description || ''}\n`);
    for (const [rel, text] of Object.entries(p.files || {})) await write(path.join(dir, rel), text);
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], {stdio: 'ignore', env: {...process.env, GIT_AUTHOR_DATE: daysAgo(between(0, 9)).toISOString(), GIT_COMMITTER_DATE: daysAgo(between(0, 9)).toISOString()}});
    git('init', '-q', '-b', 'main'); git('add', '.');
    git('-c', 'user.name=Demo', '-c', 'user.email=demo@example.com', 'commit', '-q', '-m', pick(['Retry failed webhook deliveries', 'Add search ranking tests', 'Bump dependencies', 'Fix rounding in totals', 'Document the API']));
    git('remote', 'add', 'origin', `https://github.com/example/${p.dir}.git`);
    const when = daysAgo(PROJECTS.indexOf(p) * 1.3 + rand() * 2);
    for (const rel of [...Object.keys(p.files || {}), 'README.md', 'package.json', 'pyproject.toml', 'Makefile', 'docker-compose.yml', 'go.mod', 'Package.swift']) await fs.utimes(path.join(dir, rel), when, when).catch(() => {});
  }
  // Catalogue entries (live URLs, deploy commands, open items).
  await write(path.join(HOME, 'catalogue', 'dati', 'progetti.json'), JSON.stringify([
    {id: 'shop-api', nome: 'shop-api', descrizione: PROJECTS[0].pkg.description, stato: 'online', locale: {percorso: path.join(code, 'shop-api'), porta: 8080}, url: ['https://api.example.com'], server: 'prod', percorso_server: '/srv/shop-api', deploy: './deploy.sh production', aperti: ['Remove the old webhook secret on Friday']},
    {id: 'storefront', nome: 'storefront', descrizione: PROJECTS[1].pkg.description, stato: 'online', locale: {percorso: path.join(code, 'storefront')}, url: ['https://shop.example.com'], deploy: 'vercel --prod'},
    {id: 'partner-portal', nome: 'Partner portal', descrizione: 'Portal for wholesale partners (hosted, no local copy).', stato: 'online', url: ['https://partners.example.com']},
  ].concat(PROJECTS.slice(2).map(p => ({id: p.dir, nome: p.dir, locale: {percorso: path.join(code, p.dir)}})))));

  // Claude Code transcripts.
  const line = o => JSON.stringify(o) + '\n';
  let sessions = 0;
  for (let d = 29; d >= 0; d--) {
    const count = d % 7 === 5 || d % 7 === 6 ? between(0, 1) : between(1, 3);
    for (let k = 0; k < count; k++) {
      const p = rand() < 0.45 ? PROJECTS[pick([0, 0, 1, 2])] : pick(PROJECTS);
      const [title, outcome] = pick(TASKS[p.dir]);
      const dir = path.join(code, p.dir);
      const sid = `demo-${d}-${k}-${between(1000, 9999)}`;
      const t0 = daysAgo(d, 9 + k * 3);
      const model = modelPick();
      const rows = [line({type: 'user', cwd: dir, sessionId: sid, timestamp: t0.toISOString(), message: {role: 'user', content: title}})];
      const steps = between(6, 22);
      for (let i = 0; i < steps; i++) {
        const gap = i === Math.floor(steps / 2) && rand() < 0.5 ? pick([22, 41, 75, 130]) * 60e3 : 0;
        t0.setTime(t0.getTime() + gap);
        const ts = new Date(t0.getTime() + i * 60e3).toISOString();
        const tool = pick(['Bash', 'Bash', 'Bash', 'Read', 'Read', 'Edit', 'Grep', 'WebSearch']);
        const id = `toolu_${sid}_${i}`;
        const scale = model.includes('haiku') ? 0.2 : model.includes('sonnet') ? 0.6 : 1;
        rows.push(line({type: 'assistant', cwd: dir, timestamp: ts, message: {id: `msg_${sid}_${i}`, model, usage: {input_tokens: between(3, 40), output_tokens: Math.round(between(400, 9000) * scale), cache_read_input_tokens: Math.round(between(40e3, 260e3) * scale), cache_creation_input_tokens: gap ? between(110e3, 190e3) : Math.round(between(1e3, 30e3) * scale)},
          content: [{type: 'tool_use', id, name: tool, input: tool === 'Edit' ? {file_path: path.join(dir, Object.keys(p.files || {'README.md': 1})[0])} : tool === 'Read' ? {file_path: path.join(dir, 'README.md')} : {command: 'npm test'}}]}}));
        const size = tool === 'Bash' ? between(200, 9000) : tool === 'Read' ? between(800, 14000) : between(100, 3000);
        const failure = tool === 'Bash' && rand() < 0.12 ? pick(['Exit code 127\nzsh: command not found: deployctl', 'Exit code 127\nzsh: command not found: timeout', 'Exit code 1\nsed: 1: "s/v1/v2/": invalid command code']) : null;
        const content = [{type: 'text', text: failure || 'x'.repeat(size)}];
        if (tool === 'Bash' && rand() < 0.08) content.push({type: 'image', source: {type: 'base64', media_type: 'image/png', data: 'AAAA'}});
        rows.push(line({type: 'user', cwd: dir, timestamp: ts, message: {role: 'user', content: [{type: 'tool_result', tool_use_id: id, content, ...(failure ? {is_error: true} : {})}]}}));
      }
      rows.push(line({type: 'assistant', cwd: dir, timestamp: new Date(t0.getTime() + steps * 60e3).toISOString(), message: {id: `msg_${sid}_end`, model, usage: {input_tokens: 5, output_tokens: 600, cache_read_input_tokens: 90e3, cache_creation_input_tokens: 2e3}, content: [{type: 'text', text: outcome}]}}));
      await write(path.join(HOME, '.claude', 'projects', '-demo-' + p.dir, sid + '.jsonl'), rows.join(''));
      sessions++;
    }
  }
  // Codex transcripts.
  for (let d = 0; d < 10; d++) {
    const p = pick(PROJECTS);
    const [title, outcome] = pick(TASKS[p.dir]);
    const model = CODEX_MODELS[d % 2];
    const t = daysAgo(d * 3, 15).toISOString();
    const input = between(8e5, 4e6);
    const rows = [line({timestamp: t, type: 'session_meta', payload: {id: `codex-demo-${d}`, cwd: path.join(code, p.dir), timestamp: t}}), line({timestamp: t, type: 'turn_context', payload: {model}}),
      line({timestamp: t, type: 'response_item', payload: {type: 'message', role: 'user', content: [{type: 'input_text', text: title}]}}),
      line({timestamp: t, type: 'event_msg', payload: {type: 'token_count', info: {total_token_usage: {input_tokens: input, cached_input_tokens: Math.round(input * 0.86), output_tokens: between(30e3, 160e3)}}}}),
      line({timestamp: t, type: 'event_msg', payload: {type: 'task_complete', last_agent_message: outcome}})];
    await write(path.join(HOME, '.codex', 'sessions', '2026', '11', String(10 + d), `rollout-demo-${d}.jsonl`), rows.join(''));
  }
  // LeanBrain memory and savings.
  const state = path.join(HOME, '.leanbrain');
  const notes = [['shop-api', 'Staging uses the sandbox payment keys from the team vault; never the live ones.'], ['shop-api', 'Refund jobs run on the "refunds" queue; scale workers before sales events.'], ['storefront', 'Search ranking lives in lib/search.ts; tune weights there, not in the API.'], ['billing-engine', 'All amounts are integers in minor units; convert only at the edges.'], ['infra', 'Backups at 03:00 UTC, 14 days retention; restore runbook in infra/README.md.'], ['data-pipeline', 'The warehouse is read-only between 02:00 and 03:00 during compaction.']];
  await write(path.join(state, 'notes.jsonl'), notes.map(([dir, text], i) => JSON.stringify({id: path.join(code, dir), date: daysAgo(12 - i * 2).toISOString(), text})).join('\n') + '\n');
  await write(path.join(state, 'todos.json'), JSON.stringify([
    {n: 1, id: path.join(code, 'shop-api'), text: 'Remove the old webhook secret after Friday', date: daysAgo(3).toISOString()},
    {n: 2, id: path.join(code, 'storefront'), text: 'A/B test the new search ranking', date: daysAgo(2).toISOString()},
    {n: 3, id: path.join(code, 'billing-engine'), text: 'Add Swiss VAT rules', date: daysAgo(1).toISOString()},
  ]));
  const kinds = [['pack', 2400, 380], ['map', 38000, 1100], ['grep', 4200, 700], ['read', 9000, 900], ['reuse', 6000, 30], ['run', 7000, 300], ['guard-outline', 12000, 800], ['guard-reread', 5000, 40], ['guard-diff', 9000, 400], ['recall', 3000, 400]];
  const ledger = [];
  for (let d = 29; d >= 0; d--) for (let k = 0; k < between(4, 18); k++) {
    const [kind, full, short] = pick(kinds);
    const f = Math.round(full * (0.4 + rand() * 1.4));
    ledger.push(JSON.stringify({kind, full: f, compact: Math.round(Math.min(f, short * (0.6 + rand()))), day: daysAgo(d).toISOString().slice(0, 10), at: daysAgo(d).getTime()}));
  }
  await write(path.join(state, 'token-use.jsonl'), ledger.join('\n') + '\n');
  // A bin dir so the dashboard shows the short `leanbrain` command.
  const bin = path.join(HOME, 'bin');
  await fs.mkdir(bin, {recursive: true});
  await fs.symlink(path.join(ROOT, 'leanbrain.mjs'), path.join(bin, 'leanbrain')).catch(() => {});
  const env = {...process.env, HOME, LEANBRAIN_HOME: state, CLAUDE_CONFIG_DIR: path.join(HOME, '.claude'), CODEX_HOME: path.join(HOME, '.codex'), PATH: bin + path.delimiter + process.env.PATH};
  execFileSync(process.execPath, [path.join(ROOT, 'leanbrain.mjs'), 'catalog', path.join(HOME, 'catalogue')], {env, stdio: 'ignore'});
  await write(path.join(HOME, '.claude', 'CLAUDE.md'), '# Team rules\n\nUse pnpm. Run tests before committing.\n');
  execFileSync(process.execPath, [path.join(ROOT, 'leanbrain.mjs'), 'install', '--guard'], {env, stdio: 'ignore'});
  return {env, sessions};
}

const {env, sessions} = await build();
console.log(`Demo workspace: ${HOME} · ${PROJECTS.length} projects · ${sessions} Claude sessions + 10 Codex sessions`);
if (!process.argv.includes('--no-serve')) {
  const child = spawn(process.execPath, [path.join(ROOT, 'leanbrain.mjs'), 'serve', '--port', String(port)], {env, stdio: 'inherit'});
  process.on('SIGINT', () => child.kill());
}
