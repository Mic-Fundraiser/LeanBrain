// Token accounting: exact o200k_base counts (sampled for very large texts) and the savings ledger.
import {countTokens} from 'gpt-tokenizer/encoding/o200k_base';
import {appendJSONL, readJSONL, state, compact, fmt, day} from './core.mjs';

export function tokens(text) {
  if (!text) return 0;
  text = String(text);
  if (text.length <= 300_000) return countTokens(text);
  const sample = text.slice(0, 120_000);
  return Math.round(countTokens(sample) * text.length / sample.length);
}

/** Price used to turn saved input tokens into dollars (USD per million input tokens). */
export const PRICE = Number(process.env.LEANBRAIN_USD_PER_MTOK) || 3;

/**
 * Log one operation: `full` is what the agent would have read without LeanBrain,
 * `returned` is what LeanBrain actually printed. Only measurements, never content.
 */
export async function record(kind, full, returned, project) {
  if (!(full > 0)) return;
  const row = {kind, full: Math.round(full), compact: Math.round(Math.min(full, returned)), day: day(), at: Date.now()};
  if (project) row.project = project;
  await appendJSONL(state('token-use.jsonl'), row).catch(() => {});
}

/** Print the compact form when it is actually smaller, otherwise the raw text. */
export async function emitCompact(kind, raw, candidate, project) {
  const full = tokens(raw), short = tokens(candidate);
  await record(kind, full, Math.min(full, short), project);
  return short < full ? candidate : raw;
}

export async function ledger() {
  const total = {uses: 0, full: 0, compact: 0, days: {}, kinds: {}, projects: {}};
  for (const row of await readJSONL(state('token-use.jsonl'))) {
    const saved = (row.full || 0) - (row.compact || 0);
    const kind = row.kind || 'pack';
    total.uses++; total.full += row.full || 0; total.compact += row.compact || 0;
    if (row.day) total.days[row.day] = (total.days[row.day] || 0) + saved;
    const k = total.kinds[kind] ||= {uses: 0, saved: 0, full: 0};
    k.uses++; k.saved += saved; k.full += row.full || 0;
    if (row.project) total.projects[row.project] = (total.projects[row.project] || 0) + saved;
  }
  total.saved = total.full - total.compact;
  total.usd = total.saved / 1e6 * PRICE;
  return total;
}

const LABELS = {pack: 'project cards', focus: 'focus lookups', map: 'repo maps', grep: 'code search', read: 'smart reads',
  reuse: 'avoided re-reads', 'guard-reread': 'guard: blocked re-reads', 'guard-outline': 'guard: outlines of big files', 'guard-diff': 'guard: diffs instead of re-reads', immunity: 'immunity: failing commands prevented', excerpt: 'excerpts', filter: 'output filters', run: 'compressed commands', recall: 'memory recall', sym: 'symbol lookups'};
export const kindLabel = k => LABELS[k] || k;

const BARS = ' ▁▂▃▄▅▆▇█';
export function spark(values) {
  const peak = Math.max(...values, 1);
  return values.map(v => BARS[Math.round(8 * v / peak)]).join('');
}

export async function gainReport({days = 14} = {}) {
  const t = await ledger();
  if (!t.uses) return 'No savings recorded yet. They appear after the first pack, map, grep, read or run.';
  const pct = t.full ? Math.round(1000 * t.saved / t.full) / 10 : 0;
  const series = Array.from({length: days}, (_, i) => t.days[day(Date.now() - (days - 1 - i) * 86400e3)] || 0);
  const kinds = Object.entries(t.kinds).sort((a, b) => b[1].saved - a[1].saved);
  const lines = [
    `LeanBrain savings · ${fmt(t.uses)} operations`,
    `Tokens: ${compact(t.full)} would have been read → ${compact(t.compact)} returned · ${compact(t.saved)} saved (−${pct}%)`,
    `Value: ≈ $${t.usd.toFixed(2)} of input tokens at $${PRICE}/M (set LEANBRAIN_USD_PER_MTOK)`,
    `Last ${days} days: ${spark(series)}  (${compact(series.reduce((a, b) => a + b, 0))} saved)`,
    'By operation:',
    ...kinds.map(([k, v]) => `  ${kindLabel(k).padEnd(22)} ${String(v.uses).padStart(5)} ops  ${compact(v.saved).padStart(7)} saved  ${v.full ? Math.round(100 * v.saved / v.full) : 0}%`),
  ];
  return lines.join('\n');
}
