// Model Context Protocol server over stdio (newline-delimited JSON-RPC 2.0). Few tools, terse schemas:
// tool definitions are paid in tokens by every session that loads them.
import readline from 'node:readline';
import {VERSION, initState} from './core.mjs';
import * as cmd from './commands.mjs';

const str = (description) => ({type: 'string', description});
const num = (description) => ({type: 'number', description});
export const TOOLS = [
  {name: 'brief', description: 'Workspace digest: project here, last session, active projects, open todos.', inputSchema: {type: 'object', properties: {}}},
  {name: 'find', description: 'Rank indexed projects by keywords.', inputSchema: {type: 'object', properties: {query: str('words')}, required: ['query']}},
  {name: 'pack', description: 'Compact project card: purpose, stack, run/deploy commands, git, notes, recent sessions.', inputSchema: {type: 'object', properties: {project: str('name, path or "." (default)'), budget: num('max tokens, default 500')}}},
  {name: 'map', description: 'Repo map: most-used files and their symbols with line numbers, within a token budget.', inputSchema: {type: 'object', properties: {project: str('name, path or "."'), path: str('subfolder'), budget: num('max tokens, default 1200')}}},
  {name: 'grep', description: 'Code search grouped by file with trimmed lines.', inputSchema: {type: 'object', properties: {pattern: str('regex (smart case)'), project: str('name, path or "."'), glob: str('e.g. *.ts,src/**'), budget: num('max tokens, default 900')}, required: ['pattern']}},
  {name: 'read', description: 'Read a file economically: outline for large files, ranges, or only the diff since your last read in this chat.', inputSchema: {type: 'object', properties: {file: str('path'), project: str('name, path or "."'), range: str('a:b'), chat: str('id you pick once per chat'), full: {type: 'boolean'}}, required: ['file']}},
  {name: 'recall', description: 'Search notes, todos and past agent sessions.', inputSchema: {type: 'object', properties: {query: str('words'), project: str('optional project')}, required: ['query']}},
  {name: 'note', description: 'Save a durable project fact for future sessions (never secrets).', inputSchema: {type: 'object', properties: {project: str('name, path or "."'), text: str('the fact')}, required: ['text']}},
];

async function call(name, a = {}) {
  switch (name) {
    case 'brief': return cmd.brief();
    case 'find': return cmd.find(a.query);
    case 'pack': return cmd.pack(a.project, {budget: a.budget || 500});
    case 'map': return cmd.map(a.project, {path: a.path, budget: a.budget || 1200});
    case 'grep': return cmd.grep(a.pattern, {in: a.project, glob: a.glob, budget: a.budget || 900});
    case 'read': return cmd.read(a.file, {in: a.project, range: a.range, chat: a.chat, full: a.full});
    case 'recall': return cmd.recall(a.query, {in: a.project});
    case 'note': return cmd.note(a.project, a.text);
    default: throw Error('Unknown tool: ' + name);
  }
}

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export async function serveMcp(input = process.stdin, output = process.stdout) {
  await initState();
  const send = msg => output.write(JSON.stringify(msg) + '\n');
  const rl = readline.createInterface({input, crlfDelay: Infinity});
  const pending = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { send({jsonrpc: '2.0', id: null, error: {code: -32700, message: 'Parse error'}}); continue; }
    const reply = (result) => msg.id !== undefined && send({jsonrpc: '2.0', id: msg.id, result});
    const fail = (code, message) => msg.id !== undefined && send({jsonrpc: '2.0', id: msg.id, error: {code, message}});
    if (msg.method === 'initialize') {
      const asked = msg.params?.protocolVersion;
      reply({protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0], capabilities: {tools: {listChanged: false}},
        serverInfo: {name: 'leanbrain', version: VERSION},
        instructions: 'Local project memory and lean context. Start with brief or pack; use map/grep/read instead of reading whole files; save durable facts with note.'});
    } else if (msg.method === 'tools/list') reply({tools: TOOLS});
    else if (msg.method === 'tools/call') {
      const job = call(msg.params?.name, msg.params?.arguments || {})
        .then(text => reply({content: [{type: 'text', text: String(text)}], isError: false}))
        .catch(e => reply({content: [{type: 'text', text: e.message}], isError: true}));
      pending.push(job);
    } else if (msg.method === 'ping') reply({});
    else if (msg.method?.startsWith('notifications/')) continue;
    else fail(-32601, 'Method not found: ' + msg.method);
  }
  await Promise.all(pending);
}
