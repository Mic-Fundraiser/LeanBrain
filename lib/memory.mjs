// Durable memory written by agents: notes (facts worth keeping) and todos (open threads).
import fs from 'node:fs/promises';
import {state, readJSONL, readJSON, atomic, appendJSONL} from './core.mjs';

const SECRET = /(sk-[a-z0-9-]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY|password\s*[:=]\s*\S{4,}|passwd\s*[:=]|api[_-]?key\s*[:=]\s*\S{8,}|bearer\s+[a-z0-9._-]{20,})/i;
export function assertClean(text) {
  if (SECRET.test(text)) throw Error('This looks like a secret (key, token or password). Store only where secrets live, never the secret itself.');
}

export const notes = () => readJSONL(state('notes.jsonl'));
export async function addNote(project, text) {
  text = String(text || '').trim();
  if (!text || text.length > 600) throw Error('A note needs 1 to 600 characters.');
  assertClean(text);
  const row = {id: project.id, date: new Date().toISOString(), text};
  await appendJSONL(state('notes.jsonl'), row);
  return row;
}

export const todos = async () => (await readJSON(state('todos.json'), [])).filter(t => t && t.n);
export async function addTodo(project, text) {
  text = String(text || '').trim();
  if (!text || text.length > 300) throw Error('A todo needs 1 to 300 characters.');
  assertClean(text);
  const list = await todos();
  const row = {n: list.reduce((m, t) => Math.max(m, t.n), 0) + 1, id: project.id, text, date: new Date().toISOString()};
  list.push(row);
  await atomic(state('todos.json'), JSON.stringify(list));
  return row;
}
export async function closeTodo(n) {
  const list = await todos();
  const row = list.find(t => t.n === Number(n));
  if (!row) throw Error('No todo #' + n);
  row.done = new Date().toISOString();
  await atomic(state('todos.json'), JSON.stringify(list));
  return row;
}
export const openTodos = async id => (await todos()).filter(t => !t.done && (!id || t.id === id));

/** Remove notes of a project whose text contains `match` (used to correct mistakes). */
export async function forget(project, match) {
  const all = await notes();
  const keep = all.filter(n => !(n.id === project.id && n.text.toLowerCase().includes(String(match).toLowerCase())));
  const removed = all.length - keep.length;
  if (removed) await atomic(state('notes.jsonl'), keep.map(n => JSON.stringify(n)).join('\n') + (keep.length ? '\n' : ''));
  return removed;
}
export const notesFileExists = () => fs.access(state('notes.jsonl')).then(() => true, () => false);
