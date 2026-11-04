// A control-only MCP server. It can inspect and narrow a local configuration;
// it can never enforce, widen a path scope, or become an enforcement path.
// Stdio only: the host process owns the filesystem trust.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, setModeAll, status } from '../connect.mjs';
import { validatePathsConfig } from '../fs-paths.mjs';
import { paths } from '../store.mjs';

const CLI = fileURLToPath(new URL('../../bin/attesso.mjs', import.meta.url));

const TOOLS = [
  {
    name: 'bounds_status',
    description: 'Read Bounds initialization, mode and wired harnesses.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'bounds_connect',
    description: 'Initialize and wire harnesses in observe or off mode. Never enables enforcement.',
    inputSchema: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['observe', 'off'] } },
      additionalProperties: false,
    },
  },
  {
    name: 'bounds_mode',
    description: 'Set observe or off. Enforce is a human CLI action.',
    inputSchema: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['observe', 'off'] } },
      required: ['mode'],
      additionalProperties: false,
    },
  },
  {
    name: 'bounds_paths_get',
    description: 'Read the validated file-tool path scope.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'bounds_paths_set',
    description: 'Narrow the path scope. Widening requires the human CLI.',
    inputSchema: {
      type: 'object',
      properties: {
        allowed_roots: { type: 'array' },
        exclusions: { type: 'array' },
      },
      required: ['allowed_roots', 'exclusions'],
      additionalProperties: false,
    },
  },
];

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) => {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
};

function readPaths(dir) {
  if (!existsSync(paths(dir).fsPaths)) return { version: 1, allowed_roots: [], exclusions: [] };
  return validatePathsConfig(readJson(paths(dir).fsPaths));
}

const subset = (next, current, field) => next.every((item) => current.some((existing) => {
  if (field === 'allowed_roots') {
    return existing.path === item.path && item.access.every((access) => existing.access.includes(access));
  }
  return existing === item;
}));

export function createControl({ dir = '.attesso', home = homedir(), cwd = process.cwd() } = {}) {
  const ledger = resolve(dir);
  const statusOf = () => status({ dir: ledger, cwd, home });

  const call = async (name, args = {}) => {
    if (name === 'bounds_status') return statusOf();
    if (name === 'bounds_connect') {
      const mode = args.mode ?? 'observe';
      if (!['observe', 'off'].includes(mode)) throw new Error('enforce is a human CLI action');
      return { result: connect({ dir: ledger, cwd, home, write: true, mode, cli: CLI }), status: statusOf() };
    }
    if (name === 'bounds_mode') {
      if (!['observe', 'off'].includes(args.mode)) throw new Error('enforce is a human CLI action');
      setModeAll(ledger, args.mode, { home });
      return { mode: args.mode, status: statusOf() };
    }
    if (name === 'bounds_paths_get') return readPaths(ledger);
    if (name === 'bounds_paths_set') {
      const current = readPaths(ledger);
      const next = validatePathsConfig({
        version: 1,
        allowed_roots: args.allowed_roots,
        exclusions: args.exclusions,
      });
      if (!subset(next.allowed_roots, current.allowed_roots, 'allowed_roots')
        || !subset(next.exclusions, current.exclusions, 'exclusions')) {
        throw new Error('path widening requires the human CLI: npx attesso paths --set');
      }
      writeJson(paths(ledger).fsPaths, next);
      return next;
    }
    throw new Error(`unknown tool: ${name}`);
  };

  return { call, tools: TOOLS, ledger };
}

const result = (id, value) => ({ jsonrpc: '2.0', id, result: value });
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

export function createServer({ input = process.stdin, output = process.stdout, control } = {}) {
  let buffer = '';
  let queue = Promise.resolve();
  const send = (message) => output.write(`${JSON.stringify(message)}\n`);

  const handle = async (message) => {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return send(error(message?.id ?? null, -32600, 'invalid request'));
    }
    if (Array.isArray(message)) return send(error(null, -32600, 'batch requests are not supported'));
    if (message.method === 'notifications/initialized') return undefined;
    if (message.method === 'initialize') {
      return send(result(message.id, {
        protocolVersion: message.params?.protocolVersion ?? '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'attesso-control', version: '0.6.0' },
      }));
    }
    if (message.method === 'ping') return send(result(message.id, {}));
    if (message.method === 'tools/list') return send(result(message.id, { tools: control.tools }));
    if (message.method !== 'tools/call') return send(error(message.id, -32601, `unknown method: ${message.method}`));
    const name = message.params?.name;
    try {
      const value = await control.call(name, message.params?.arguments ?? {});
      return send(result(message.id, text(value)));
    } catch (failure) {
      return send(result(message.id, { content: [{ type: 'text', text: failure.message }], isError: true }));
    }
  };

  input.setEncoding?.('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        send(error(null, -32700, 'parse error'));
        continue;
      }
      queue = queue.then(() => handle(message)).catch((failure) => send(error(null, -32603, failure.message)));
    }
  });
  input.on('end', () => { if (buffer.trim()) queue = queue.then(() => send(error(null, -32700, 'parse error'))); });
  return { handle };
}

export { TOOLS };
