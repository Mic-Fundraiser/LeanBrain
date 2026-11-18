// Workspace scanner: finds projects, measures disk use, and extracts the facts an agent needs first
// (purpose, stack, how to run, git state). It reads names, sizes and a few small manifest files only.
import fs from 'node:fs/promises';
import path from 'node:path';
import {HOME, atomic, state, head, tail, pool} from './core.mjs';

const MARKERS = new Map(Object.entries({
  'package.json': 'Node.js', 'deno.json': 'Deno', 'pyproject.toml': 'Python', 'requirements.txt': 'Python', 'setup.py': 'Python',
  'Cargo.toml': 'Rust', 'go.mod': 'Go', 'Package.swift': 'Swift', 'composer.json': 'PHP', 'pom.xml': 'Java',
  'build.gradle': 'Java', 'build.gradle.kts': 'Kotlin', 'Gemfile': 'Ruby', 'pubspec.yaml': 'Dart', 'mix.exs': 'Elixir', '.git': 'Git',
}));
export const GENERATED = new Set(['node_modules', '.venv', 'venv', '.build', '.next', '.nuxt', '.svelte-kit', '.turbo', '__pycache__',
  'target', 'dist', 'build', '.parcel-cache', '.cache', 'coverage', 'Pods', 'DerivedData', '.gradle', '.tox', '.mypy_cache', '.pytest_cache', 'bower_components']);
export const GUIDES = new Set(['README.md', 'readme.md', 'README', 'CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules']);
const LANGS = {js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', py: 'Python',
  go: 'Go', rs: 'Rust', swift: 'Swift', kt: 'Kotlin', java: 'Java', php: 'PHP', rb: 'Ruby', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', cs: 'C#',
  html: 'HTML', css: 'CSS', scss: 'SCSS', vue: 'Vue', svelte: 'Svelte', astro: 'Astro', sh: 'Shell', sql: 'SQL', dart: 'Dart', ex: 'Elixir',
  lua: 'Lua', md: 'Markdown', ipynb: 'Notebook'};
const FRAMEWORKS = {next: 'Next.js', react: 'React', vue: 'Vue', svelte: 'Svelte', '@sveltejs/kit': 'SvelteKit', astro: 'Astro', express: 'Express',
  fastify: 'Fastify', hono: 'Hono', koa: 'Koa', electron: 'Electron', vite: 'Vite', three: 'three.js', tailwindcss: 'Tailwind', prisma: 'Prisma',
  '@modelcontextprotocol/sdk': 'MCP', '@anthropic-ai/sdk': 'Anthropic SDK', openai: 'OpenAI SDK', 'react-native': 'React Native', expo: 'Expo',
  typescript: 'TypeScript', vitest: 'Vitest', jest: 'Jest', playwright: 'Playwright', '@playwright/test': 'Playwright', puppeteer: 'Puppeteer',
  'better-sqlite3': 'SQLite', sqlite3: 'SQLite', pg: 'Postgres', mongoose: 'MongoDB', 'socket.io': 'Socket.IO', '@supabase/supabase-js': 'Supabase',
  stripe: 'Stripe', nodemailer: 'Nodemailer', 'drizzle-orm': 'Drizzle'};
const PYFRAMEWORKS = {flask: 'Flask', django: 'Django', fastapi: 'FastAPI', streamlit: 'Streamlit', gradio: 'Gradio', pandas: 'pandas',
  anthropic: 'Anthropic SDK', openai: 'OpenAI SDK', playwright: 'Playwright', scrapy: 'Scrapy', sqlalchemy: 'SQLAlchemy', celery: 'Celery',
  torch: 'PyTorch', transformers: 'Transformers', langchain: 'LangChain', uvicorn: 'Uvicorn', selenium: 'Selenium', beautifulsoup4: 'BeautifulSoup',
  requests: 'requests', httpx: 'httpx', pytest: 'pytest', mcp: 'MCP', 'python-telegram-bot': 'Telegram', openpyxl: 'openpyxl', reportlab: 'ReportLab'};

export async function scan(inputs, catalog = null, {onProgress, extra} = {}) {
  const seen = new Set();
  for (const input of inputs) {
    const root = await fs.realpath(input).catch(e => { if (catalog) return null; throw e; });
    if (!root) continue;
    if (!(await fs.stat(root)).isDirectory()) throw Error('Not a folder: ' + root);
    seen.add(root);
  }
  const roots = [...seen].filter(r => ![...seen].some(s => s !== r && r.startsWith(s + path.sep)));
  if (!roots.length && !catalog) throw Error('Pass at least one folder: leanbrain scan <folder> [more folders]');
  const known = new Map((catalog?.records || []).filter(r => r.local).map(r => [r.local, r]));
  const result = {roots, source: catalog?.source, unavailable: catalog?.unavailable || 0, projects: [], large: [], folders: [],
    skipped: 0, bytes: 0, small: 0, count: 0, date: new Date().toISOString(), extra: extra?.length ? extra : undefined};
  const queue = roots.map(dir => ({dir, owner: null, generated: false, root: true}));
  let visited = 0;

  async function visit({dir, owner, generated, root}) {
    let entries;
    try { entries = await fs.readdir(dir, {withFileTypes: true}); }
    catch (e) {
      if (root && !catalog) throw e;
      result.skipped++; if (root) result.unavailable++;
      return;
    }
    if (++visited % 5000 === 0) onProgress?.(visited);
    const names = entries.filter(e => e.isFile() || e.name === '.git').map(e => e.name);
    const types = [...new Set(names.filter(n => MARKERS.has(n)).map(n => MARKERS.get(n)))];
    if (entries.some(e => e.isDirectory() && e.name.endsWith('.xcodeproj'))) types.push('Xcode');
    const record = known.get(dir);
    if ((record || types.length) && !generated) {
      owner = {id: dir, name: record?.name || path.basename(dir), description: record?.description || undefined, brainId: record?.key,
        stack: record?.stack || undefined, brain: record?.brain, types: types.length ? types : ['Project'],
        guides: names.filter(n => GUIDES.has(n) || (MARKERS.has(n) && n !== '.git')), size: 0, small: 0, count: 0, generated: 0,
        langs: {}, mtime: 0, parent: owner?.id};
      result.projects.push(owner);
    }
    const group = {path: dir, small: 0, size: 0};
    const files = [];
    for (const entry of entries) {
      if ((entry.name.startsWith('.') && !GENERATED.has(entry.name)) || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (full === HOME) continue;
      if (entry.isDirectory()) queue.push({dir: full, owner, generated: generated || GENERATED.has(entry.name)});
      else if (entry.isFile()) files.push(full);
    }
    for (let i = 0; i < files.length; i += 128) {
      const batch = files.slice(i, i + 128);
      const stats = await Promise.all(batch.map(f => fs.lstat(f).catch(() => null)));
      stats.forEach((stat, j) => {
        if (!stat) { result.skipped++; return; }
        if (!stat.isFile()) return;
        const size = stat.size;
        result.bytes += size; result.count++;
        if (size < 4096) { result.small++; group.small++; group.size += size; }
        if (owner) {
          owner.size += size; owner.count++;
          if (size < 4096) owner.small++;
          if (generated) owner.generated += size;
          else {
            if (stat.mtimeMs > owner.mtime) owner.mtime = stat.mtimeMs;
            const ext = path.extname(batch[j]).slice(1).toLowerCase();
            if (LANGS[ext]) owner.langs[LANGS[ext]] = (owner.langs[LANGS[ext]] || 0) + 1;
          }
        }
        if (size >= 10_000_000) result.large.push({path: batch[j], size, modified: stat.mtimeMs, ino: stat.ino});
      });
    }
    if (group.small) result.folders.push(group);
  }

  await new Promise((resolve, reject) => {
    let active = 0, failed = false;
    const pump = () => {
      if (failed) return;
      while (active < 48 && queue.length) {
        active++;
        visit(queue.pop()).then(() => { active--; queue.length || active ? pump() : resolve(); }, e => { failed = true; reject(e); });
      }
      if (!queue.length && !active) resolve();
    };
    pump();
  });

  result.folders = result.folders.sort((a, b) => b.small - a.small || b.size - a.size).slice(0, 250);
  const indexed = new Set(result.projects.map(p => p.brainId).filter(Boolean));
  for (const r of catalog?.records || []) if (!indexed.has(r.key)) {
    result.projects.push({id: 'cervello:' + r.key, brainId: r.key, name: r.name, description: r.description || undefined, stack: r.stack || undefined,
      brain: r.brain, types: ['Catalogue'], external: true, guides: [], size: 0, small: 0, count: 0, generated: 0, langs: {}, mtime: 0});
  }
  await pool(result.projects.filter(p => !p.external), 24, async p => Object.assign(p, await describe(p)));
  for (const p of result.projects) {
    p.langs = Object.fromEntries(Object.entries(p.langs || {}).sort((a, b) => b[1] - a[1]).slice(0, 5));
    p.mtime = Math.max(p.mtime || 0, p.git?.commit ? Date.parse(p.git.commit.date) : 0) || undefined;
  }
  result.large.sort((a, b) => b.size - a.size);
  result.large = result.large.slice(0, 2000);
  result.projects.sort((a, b) => a.id.localeCompare(b.id));
  await atomic(state('index.json'), JSON.stringify(result));
  return result;
}

/** Facts from manifests, README and git metadata. Never reads .env or other secret-bearing files. */
export async function describe(p) {
  const dir = p.id, out = {};
  const read = (name, max) => head(path.join(dir, name), max);
  const frameworks = new Set();
  const pkgText = await read('package.json', 262144);
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText);
      out.pkg = {name: typeof pkg.name === 'string' ? pkg.name : undefined, description: typeof pkg.description === 'string' ? pkg.description.slice(0, 300) : undefined,
        scripts: Object.fromEntries(Object.entries(pkg.scripts || {}).slice(0, 14).map(([k, v]) => [k, String(v).slice(0, 120)])),
        bin: typeof pkg.bin === 'string' ? [path.basename(pkg.bin)] : Object.keys(pkg.bin || {}).slice(0, 4)};
      for (const dep of Object.keys({...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies})) if (FRAMEWORKS[dep]) frameworks.add(FRAMEWORKS[dep]);
    } catch {}
  }
  const py = await read('pyproject.toml', 131072);
  if (py) {
    const name = py.match(/^\s*name\s*=\s*["']([^"']+)/m)?.[1];
    const description = py.match(/^\s*description\s*=\s*["']([^"'\n]+)/m)?.[1];
    const scripts = [...(py.match(/\[project\.scripts\]([\s\S]*?)(\n\[|$)/)?.[1] || '').matchAll(/^\s*([\w.-]+)\s*=/gm)].map(m => m[1]).slice(0, 8);
    out.py = {name, description: description?.slice(0, 300), scripts};
    for (const [k, v] of Object.entries(PYFRAMEWORKS)) if (new RegExp(`["'\\s]${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[<>=~!\\[",']`, 'i').test(py)) frameworks.add(v);
  }
  const req = await read('requirements.txt', 65536);
  if (req) for (const line of req.split('\n')) {
    const name = line.trim().split(/[<>=~!\[;\s]/)[0].toLowerCase();
    if (PYFRAMEWORKS[name]) frameworks.add(PYFRAMEWORKS[name]);
  }
  if (frameworks.size) out.frameworks = [...frameworks].slice(0, 8);
  for (const name of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const text = await read(name, 131072);
    if (text) { const services = compose(text); if (services.length) out.compose = services; break; }
  }
  const make = await read('Makefile', 65536);
  if (make) {
    const targets = [...make.matchAll(/^([a-zA-Z][\w.-]*)\s*:(?!=)/gm)].map(m => m[1]).filter(t => !t.startsWith('.'));
    if (targets.length) out.make = [...new Set(targets)].slice(0, 10);
  }
  for (const name of ['README.md', 'readme.md', 'Readme.md', 'README', 'README.txt', 'README.rst']) {
    const text = await read(name, 16384);
    if (text) { const summary = readme(text); if (summary) { out.readme = summary; break; } }
  }
  const git = await gitInfo(dir);
  if (git) out.git = git;
  return out;
}

function compose(text) {
  const services = [];
  let inServices = false, current = null, inPorts = false;
  for (const line of text.split('\n')) {
    if (/^services:\s*$/.test(line)) { inServices = true; continue; }
    if (/^\S/.test(line)) { inServices = false; continue; }
    if (!inServices) continue;
    const svc = line.match(/^ {2}([\w.-]+):\s*$/);
    if (svc) { current = {name: svc[1], ports: []}; services.push(current); inPorts = false; continue; }
    if (/^ {4}ports:\s*$/.test(line)) { inPorts = true; continue; }
    if (/^ {4}\S/.test(line)) inPorts = false;
    const port = inPorts && line.match(/^\s+-\s*["']?([\d.:]+(?:\/\w+)?)["']?/);
    if (port && current) current.ports.push(port[1]);
  }
  return services.slice(0, 10).map(s => s.ports.length ? s.name + ' ' + s.ports.slice(0, 3).join(',') : s.name);
}

export function readme(text) {
  const lines = text.replace(/<!--[\s\S]*?-->/g, '').replace(/```[\s\S]*?```/g, '').split(/\r?\n/);
  let title = '';
  const paragraphs = [];
  let current = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (/^#\s+/.test(line) && !title) { title = line.replace(/^#+\s*/, ''); continue; }
    if (!line || /^#{1,6}\s/.test(line) || /^[-=]{3,}$/.test(line)) { if (current.length) paragraphs.push(current.join(' ')); current = []; continue; }
    if (/^(\[!\[|!\[|<img|<p\s+align|<\/?(div|p|a|br|h\d)[\s>])/i.test(line) || /^\|/.test(line)) continue;
    current.push(line);
  }
  if (current.length) paragraphs.push(current.join(' '));
  const clean = s => s.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '').replace(/[*_`>]/g, '').replace(/\s+/g, ' ').trim();
  const body = paragraphs.map(clean).find(p => p.length >= 30 && !/^(install|usage|license|table of contents)/i.test(p)) || '';
  const out = [clean(title), body].filter(Boolean).join(' — ');
  return out ? out.slice(0, 320) : undefined;
}

const sanitizeRemote = url => url.replace(/^[a-z+]+:\/\/[^@/]*@/i, 'https://').replace(/^git@([^:]+):/, '$1/').replace(/^https?:\/\//, '').replace(/\.git$/, '');
export async function gitInfo(dir) {
  let gitDir = path.join(dir, '.git');
  try {
    const stat = await fs.stat(gitDir);
    if (stat.isFile()) {
      const pointer = (await fs.readFile(gitDir, 'utf8')).match(/gitdir:\s*(.+)/);
      if (!pointer) return null;
      gitDir = path.resolve(dir, pointer[1].trim());
    }
  } catch { return null; }
  const headRef = ((await head(path.join(gitDir, 'HEAD'), 512)) || '').trim();
  const branch = headRef.startsWith('ref: ') ? headRef.slice(5).replace(/^refs\/heads\//, '') : headRef.slice(0, 8) || undefined;
  let common = gitDir;
  const commonDir = (await head(path.join(gitDir, 'commondir'), 512))?.trim();
  if (commonDir) common = path.resolve(gitDir, commonDir);
  const config = (await head(path.join(common, 'config'), 65536)) || '';
  const url = config.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/)?.[1];
  const log = await tail(path.join(gitDir, 'logs', 'HEAD'), 16384);
  let commit;
  for (const line of log.trim().split('\n').reverse()) {
    const m = line.match(/^[0-9a-f]+ ([0-9a-f]+) .*? (\d{9,11}) [+-]\d{4}\t(commit[^:]*|merge[^:]*|pull[^:]*|rebase[^:]*): (.*)$/);
    if (m) { commit = {sha: m[1].slice(0, 7), date: new Date(Number(m[2]) * 1000).toISOString(), msg: m[4].slice(0, 160)}; break; }
  }
  return {branch, remote: url ? sanitizeRemote(url) : undefined, commit};
}
