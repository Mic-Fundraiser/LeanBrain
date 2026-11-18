// Output compression for noisy commands. Lossy on screen, lossless on disk: the raw output of `run`
// is kept and can be paged with `show`, so the agent never loses information it may need later.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {state, atomic} from './core.mjs';
import {tokens, record} from './tokens.mjs';

const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]/g;
const FAIL = /(✗|✘|×|✖|FAIL\b|FAILED|failed|Failed|ERROR|Error\b|error[:\[]|Exception|Traceback|panicked|AssertionError|assert\w*Error|not ok\b|expected|Expected|received|Received|warning|Warning|WARN|E\s{2,}|>\s+\d+\s*\|)/;
const PASS = /^\s*(✓|✔|√|PASS\b|ok\s+\d|ok\b\s*-|\.\s*$|passed\b|\[\s*PASSED\s*\]|test .* \.\.\. ok$|#\s*Subtest)/;
const SUMMARY = /(Tests?:|Test Suites?:|Snapshots?:|Time:|Ran \d+ tests?|\d+ (passed|failed|skipped|errors?|warnings?)|^# (pass|fail|tests|suites|duration)|short test summary|^=+ .* =+$|test result:|^(FAIL|ok)\s+\S+\s+[\d.]+s|Done in|Compiled|built in|found \d+ (errors?|vulnerabilit)|exit code)/i;
const FRAME = /^\s+at\s|^\s+File ".*", line \d+|^\s+\S+\.(js|ts|py|go|rs|java):\d+/;
const shape = line => line.replace(/0x[0-9a-f]+/gi, '#').replace(/[0-9a-f]{8,}/gi, '#').replace(/\d+(\.\d+)?/g, '#').replace(/(["']).*?\1/g, '$1…$1');

function dedupe(lines) {
  const out = [];
  for (let i = 0; i < lines.length;) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    if (j - i > 1) { out.push(lines[i], `  ↳ ×${j - i} identical lines`); i = j; continue; }
    const s = shape(lines[i]);
    let k = i + 1;
    while (k < lines.length && lines[k].trim() && shape(lines[k]) === s) k++;
    if (k - i >= 4) { out.push(lines[i], lines[i + 1], `  ↳ ×${k - i - 2} more similar lines`, lines[k - 1]); i = k; continue; }
    out.push(lines[i]); i++;
  }
  return out;
}

function stacks(lines) {
  const out = [];
  for (let i = 0; i < lines.length;) {
    if (!FRAME.test(lines[i])) { out.push(lines[i]); i++; continue; }
    let j = i;
    while (j < lines.length && FRAME.test(lines[j])) j++;
    const frames = lines.slice(i, j);
    const own = frames.filter(f => !/node_modules|node:internal|site-packages|<anonymous>|internal\/|\/usr\/lib/.test(f));
    const keep = (own.length ? own : frames).slice(0, 4);
    out.push(...keep);
    if (frames.length > keep.length) out.push(`    … ${frames.length - keep.length} more frames`);
    i = j;
  }
  return out;
}

function testFocus(lines) {
  const keep = new Set();
  lines.forEach((l, i) => {
    if (SUMMARY.test(l)) keep.add(i);
    if (FAIL.test(l) && !PASS.test(l)) for (let k = Math.max(0, i - 2); k <= Math.min(lines.length - 1, i + 8); k++) keep.add(k);
  });
  if (!keep.size) return null;
  const out = [];
  let last = -1, dropped = 0;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i > last + 1) { dropped += i - last - 1; out.push(`  … ${i - last - 1} lines (passing or progress)`); }
    if (PASS.test(lines[i]) && !SUMMARY.test(lines[i])) { dropped++; last = i; continue; }
    out.push(lines[i]); last = i;
  }
  if (last < lines.length - 1) out.push(`  … ${lines.length - 1 - last} lines`);
  return dropped ? out : null;
}

export function compressText(raw, {budget = 1500, id} = {}) {
  let text = raw.replace(ANSI, '').replace(/\r\n/g, '\n');
  text = text.split('\n').map(l => l.includes('\r') ? l.split('\r').filter(Boolean).pop() || '' : l).join('\n');
  let lines = text.split('\n').map(l => l.replace(/\s+$/, ''));
  while (lines.length && !lines.at(-1)) lines.pop();
  lines = stacks(dedupe(lines));
  const looksLikeTests = lines.some(l => SUMMARY.test(l)) && lines.filter(l => PASS.test(l)).length >= 3;
  if (looksLikeTests) lines = testFocus(lines) || lines;
  let out = lines.join('\n');
  if (tokens(out) > budget) {
    const headN = Math.max(8, Math.floor(lines.length * 0.25));
    let head = lines.slice(0, headN), tail = lines.slice(-Math.max(12, Math.floor(lines.length * 0.35)));
    const important = lines.slice(headN, lines.length - tail.length).filter(l => FAIL.test(l) || SUMMARY.test(l)).slice(0, 30);
    const fit = () => [...head, `  … ${lines.length - head.length - tail.length} lines omitted${id ? ` (full log: leanbrain show ${id})` : ''}`, ...important, ...tail].join('\n');
    out = fit();
    while (tokens(out) > budget && (head.length > 4 || tail.length > 6)) {
      if (head.length > 4) head = head.slice(0, Math.ceil(head.length * 0.7));
      if (tail.length > 6) tail = tail.slice(-Math.ceil(tail.length * 0.7));
      out = fit();
    }
    if (tokens(out) > budget) out = out.slice(0, budget * 3) + `\n… truncated${id ? ` (full log: leanbrain show ${id})` : ''}`;
  }
  return out;
}

/** Run a command, print compressed output, keep the raw log, and return the exit code. */
export async function runCommand(argv, {budget = 1500, shell = false} = {}) {
  if (!argv?.length) throw Error('Usage: leanbrain run [--budget N] -- <command> [args]');
  const id = 'r' + randomBytes(3).toString('hex');
  const child = shell || argv.length === 1 && /[|&;<>()$`*?~\s]/.test(argv[0])
    ? spawn(process.env.SHELL || '/bin/sh', ['-c', argv.join(' ')], {stdio: ['inherit', 'pipe', 'pipe']})
    : spawn(argv[0], argv.slice(1), {stdio: ['inherit', 'pipe', 'pipe']});
  const chunks = [];
  child.stdout.on('data', c => chunks.push(c));
  child.stderr.on('data', c => chunks.push(c));
  const code = await new Promise(resolve => {
    child.on('error', e => { chunks.push(Buffer.from(String(e.message) + '\n')); resolve(127); });
    child.on('close', (c, signal) => resolve(c ?? (signal ? 128 : 1)));
  });
  const raw = Buffer.concat(chunks).toString('utf8');
  const dir = state('runs');
  await atomic(path.join(dir, id + '.log'), raw);
  prune(dir).catch(() => {});
  const compact = compressText(raw, {budget, id});
  const full = tokens(raw), short = tokens(compact);
  const body = short < full ? compact : raw.replace(ANSI, '');
  await record('run', full, Math.min(full, short));
  const footer = `[exit ${code}${short < full ? ` · ${full}→${short} tokens · raw: leanbrain show ${id}` : ''}]`;
  return {code, text: (body ? body + '\n' : '') + footer};
}

export async function showRun(id, {range, grep} = {}) {
  if (!/^r[0-9a-f]{6}$/.test(id || '')) throw Error('Usage: leanbrain show <run-id> [--range a:b] [--grep regex]');
  const raw = (await fs.readFile(state('runs/' + id + '.log'), 'utf8')).replace(ANSI, '');
  const lines = raw.split('\n');
  if (grep) {
    const re = new RegExp(grep, 'i');
    const hits = lines.map((l, i) => [i, l]).filter(([, l]) => re.test(l)).slice(0, 80);
    return `${hits.length} lines match /${grep}/ in ${id}\n` + hits.map(([i, l]) => `${i + 1}| ${l}`).join('\n');
  }
  const [a, b] = range ? String(range).split(/[:-]/).map(Number) : [1, 120];
  return `${id} lines ${a}-${Math.min(b || a + 120, lines.length)} of ${lines.length}\n` + lines.slice(a - 1, b || a + 120).map((l, i) => `${a + i}| ${l}`).join('\n');
}

async function prune(dir) {
  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.log'));
  if (files.length <= 60) return;
  const stats = await Promise.all(files.map(async f => [f, (await fs.stat(path.join(dir, f))).mtimeMs]));
  for (const [f] of stats.sort((a, b) => a[1] - b[1]).slice(0, files.length - 60)) await fs.rm(path.join(dir, f), {force: true});
}

export async function filterStdin({budget = 1500} = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 16_000_000) throw Error('Input over 16 MB.'); chunks.push(chunk); }
  const raw = Buffer.concat(chunks).toString('utf8');
  const compact = compressText(raw, {budget});
  const full = tokens(raw), short = tokens(compact);
  await record('filter', full, Math.min(full, short));
  return short < full ? compact : raw;
}
