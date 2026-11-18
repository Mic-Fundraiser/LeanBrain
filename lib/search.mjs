// Ranked search (BM25 over weighted fields) with prefix and typo tolerance.
const deaccent = s => String(s ?? '').normalize('NFD').replace(/\p{M}+/gu, '');
export function terms(text) {
  return deaccent(String(text ?? '').replace(/([a-z])([A-Z])/g, '$1 $2')).toLowerCase()
    .split(/[^\p{L}\p{N}]+/u).filter(t => t.length > 1 || /\d/.test(t));
}

function edits1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, diff = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return diff + (a.length - i) + (b.length - j) <= 1;
}

/**
 * docs: [{item, fields: [[text, weight], ...], boost?}] → search(query) → [{item, score, matched}]
 * Every query term must match (exactly, as a prefix, or with one typo) for a document to rank first.
 */
export function createIndex(docs, {k1 = 1.2, b = 0.6} = {}) {
  const prepared = docs.map(doc => {
    const tf = new Map();
    let length = 0;
    for (const [text, weight] of doc.fields) {
      for (const t of terms(text)) { tf.set(t, (tf.get(t) || 0) + weight); length += weight; }
    }
    return {doc, tf, length};
  });
  const df = new Map();
  for (const {tf} of prepared) for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const avg = prepared.reduce((n, d) => n + d.length, 0) / (prepared.length || 1) || 1;
  const N = prepared.length;
  const vocab = [...df.keys()];
  const expand = q => {
    const out = [];
    if (df.has(q)) out.push([q, 1]);
    if (q.length >= 3) for (const v of vocab) if (v !== q && v.startsWith(q)) out.push([v, 0.75]);
    if (q.length >= 4 && out.length < 3) for (const v of vocab) if (v !== q && !v.startsWith(q) && edits1(q, v)) out.push([v, 0.5]);
    return out.slice(0, 40);
  };
  return function search(query, {limit = 20} = {}) {
    const qterms = [...new Set(terms(query))];
    if (!qterms.length) return [];
    const expanded = qterms.map(expand);
    const results = [];
    for (const {doc, tf, length} of prepared) {
      let score = 0, matched = 0;
      for (const variants of expanded) {
        let best = 0;
        for (const [t, w] of variants) {
          const f = tf.get(t);
          if (!f) continue;
          const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
          best = Math.max(best, w * idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * length / avg)));
        }
        if (best) { score += best; matched++; }
      }
      if (!matched) continue;
      const coverage = matched / qterms.length;
      score *= coverage * coverage * (doc.boost || 1);
      results.push({item: doc.item, score, matched, complete: matched === qterms.length});
    }
    return results.sort((a, b) => (b.complete - a.complete) || b.score - a.score).slice(0, limit);
  };
}
