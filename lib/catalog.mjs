// Import a project catalogue: dati/progetti.json plus optional dati/cartelle.json and dati/archivi.json
// (the field names follow the original Italian catalogue format: nome, descrizione, stato, aperti, ...).
// Only descriptive fields are read: catalogues of this kind never hold secrets, only where they live.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const text = (v, n = 400) => typeof v === 'string' ? v.slice(0, n) : Array.isArray(v) ? v.filter(x => typeof x === 'string').join(' · ').slice(0, n) : '';
const list = v => Array.isArray(v) ? v.filter(x => typeof x === 'string').map(x => x.slice(0, 200)).slice(0, 6) : typeof v === 'string' && v ? [v.slice(0, 200)] : [];

export async function readCatalog(folder) {
  const source = await fs.realpath(folder);
  async function rows(name, optional = false) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(source, 'dati', name + '.json'), 'utf8'));
      if (!Array.isArray(data)) throw Error('Invalid list: ' + name);
      return data;
    } catch (error) {
      if (optional && error.code === 'ENOENT') return [];
      throw error;
    }
  }
  const paths = new Map();
  async function locate(value) {
    if (typeof value !== 'string') return null;
    const file = value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
    if (!path.isAbsolute(file)) return null;
    if (!paths.has(file)) {
      let location = null;
      try { if ((await fs.stat(file)).isDirectory()) location = await fs.realpath(file); } catch {}
      paths.set(file, location);
    }
    return paths.get(file);
  }
  const records = [];
  for (const row of await rows('progetti')) {
    const brain = {
      area: text(row.ambito, 80), status: text(row.stato, 40), url: list(row.url), server: text(row.server, 60),
      serverPath: text(row.percorso_server, 160), serverPort: text(String(row.porta_server ?? ''), 20),
      deploy: text(row.deploy, 300), repo: text(row.repo, 120), dependsOn: list(row.dipende_da),
      open: list(row.aperti), updated: text(row.aggiornato, 10), port: row.locale?.porta ? String(row.locale.porta) : '',
    };
    for (const [k, v] of Object.entries(brain)) if (!v || (Array.isArray(v) && !v.length)) delete brain[k];
    records.push({key: String(row.id), name: row.nome || String(row.id), description: text(row.descrizione, 700),
      local: await locate(row.locale?.percorso || row.locale), stack: text(row.stack, 160), brain});
  }
  for (const group of ['cartelle', 'archivi']) {
    for (const row of await rows(group, true)) {
      // Some catalogues record the home directory as a placeholder for excluded items.
      if (group === 'archivi' && /esclus[io].*censimento/i.test(String(row.id) + ' ' + String(row.titolo))) continue;
      await locate(row.percorso);
    }
  }
  return {source, records, roots: [...new Set([...paths.values()].filter(Boolean))], unavailable: [...paths.values()].filter(v => !v).length};
}
