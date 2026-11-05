#!/usr/bin/env node
// Experimental stdio MCP proxy: the only place that sees both the tool
// definitions a client trusts and the call that follows. It is not a general
// MCP gateway; it records the pinned surface in the same signed ledger as every
// other decision.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { classifyTool, loadTools } from './classify.mjs';
import { argsFingerprint } from './hook.mjs';
import { append, readToolLock } from './store.mjs';
import { comparePin, definitionHash, manifestDigest } from './toolpin.mjs';

const REQUEST_TIMEOUT_MS = Number(process.env.MCP_PROXY_TIMEOUT_MS ?? 30000);
const PROTOCOL = '2026-07-28';
const PROXY_NAME = 'attesso-mcp-proxy';
const PROXY_VERSION = '0.0.0';
const SERVER_PROBE_TIMEOUT_MS = 3000;
const SERVER_REQUESTS = new Set(['sampling/createMessage', 'elicitation/create', 'roots/list']);
const SURFACES = {
  'prompts/list': { key: 'prompts', field: 'prompts' },
  'resources/list': { key: 'resources', field: 'resources' },
  'resources/templates/list': { key: 'resourceTemplates', field: 'resource_templates' },
};

function usage() {
  return [
    'usage: node experimental/mcp-proxy.mjs --dir <ledger> [--task <name>] [--] <server> [args...]',
    '       node experimental/mcp-proxy.mjs --print-manifest [--era auto|modern|legacy] [--] <server> [args...]',
    '',
    'The proxy refuses to expose a tools/list result whose definitions do not match',
    '.attesso/tools.lock.json, and refuses a tools/call before forwarding it when the',
    'tool is changed, unpinned, or the local policy denies it.',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { dir: '.attesso', task: 'mcp', print: false, era: 'auto', command: null, args: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      options.command = argv[index + 1] ?? null;
      options.args = argv.slice(index + 2);
      return options;
    }
    if (token === '--help' || token === '-h') {
      options.help = true;
      return options;
    }
    if (token === '--print-manifest') {
      options.print = true;
      continue;
    }
    if (token === '--dir' || token === '--task' || token === '--era') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${token} needs a value`);
      if (token === '--era' && !['auto', 'modern', 'legacy'].includes(value)) {
        throw new Error('--era takes auto, modern or legacy');
      }
      options[token.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument ${token}; put server arguments after --`);
  }
  return options;
}

function keyOf(id) {
  return `${typeof id}:${JSON.stringify(id)}`;
}

function write(stream, message) {
  try {
    stream.write(`${JSON.stringify(message)}\n`);
  } catch {
    // The peer closed; the child or the client is about to exit.
  }
}

function errorResponse(id, code, detail, data = {}) {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message: `${code}: ${detail}`,
      data: { code, ...data },
    },
  };
}

function valuesOf(result, key, label) {
  if (!result || !Array.isArray(result[key])) {
    throw new Error(`TOOL_LIST_INVALID: ${label} did not return a ${key} array`);
  }
  return result[key];
}

function listOf(result, key = 'tools', label = 'tools/list') {
  const values = valuesOf(result, key, label);
  if (result.nextCursor) {
    throw new Error(`TOOL_LIST_PAGINATED: ${label} returned a paginated list`);
  }
  return values;
}

function modernMeta() {
  return {
    'io.modelcontextprotocol/protocolVersion': PROTOCOL,
    'io.modelcontextprotocol/clientInfo': { name: PROXY_NAME, version: PROXY_VERSION },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
}

function modernParams(params = {}) {
  return { ...params, _meta: { ...(params._meta ?? {}), ...modernMeta() } };
}

function serverSurface(result, era) {
  if (!result || typeof result !== 'object') throw new Error('SERVER_RESPONSE_INVALID');
  const capabilities = result.capabilities && typeof result.capabilities === 'object' ? result.capabilities : {};
  if (era === 'modern') {
    if (!Array.isArray(result.supportedVersions)) throw new Error('SERVER_RESPONSE_INVALID: no supportedVersions');
    return {
      protocol: PROTOCOL,
      supportedVersions: result.supportedVersions,
      capabilities,
      serverInfo: result._meta?.['io.modelcontextprotocol/serverInfo'] ?? null,
      instructions: result.instructions ?? null,
    };
  }
  if (typeof result.protocolVersion !== 'string') throw new Error('SERVER_RESPONSE_INVALID: no protocolVersion');
  return {
    protocolVersion: result.protocolVersion,
    capabilities,
    serverInfo: result.serverInfo ?? null,
    instructions: result.instructions ?? null,
  };
}

async function probeServer(rpc, era = 'auto') {
  let modern = null;
  if (era !== 'legacy') {
    try {
      modern = await rpc.request('server/discover', modernParams({}), { timeout: 3000 });
    } catch {
      modern = null;
    }
    if (modern?.result?.supportedVersions) return { era: 'modern', result: modern.result };
    if (era === 'modern') throw new Error('the server did not answer server/discover as a modern MCP server');
  }
  const legacy = await rpc.request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: PROXY_NAME, version: PROXY_VERSION },
  });
  if (legacy.error) throw new Error(legacy.error.message ?? 'initialize failed');
  return { era: 'legacy', result: legacy.result };
}

async function listAll(rpc, method, key, era, required = true) {
  const values = [];
  let cursor = null;
  let pages = 0;
  for (;;) {
    pages += 1;
    if (pages > 100) throw new Error(`TOOL_LIST_PAGINATED: ${method} exceeded 100 pages`);
    const params = era === 'modern' ? modernParams(cursor ? { cursor } : {}) : cursor ? { cursor } : {};
    const response = await rpc.request(method, params);
    if (response.error) {
      if (!required) return null;
      throw new Error(`${method}: ${response.error.message ?? 'request failed'}`);
    }
    const page = valuesOf(response.result, key, method);
    values.push(...page);
    cursor = response.result.nextCursor ?? null;
    if (!cursor) return values;
  }
}

class Proxy {
  constructor(child, options) {
    this.child = child;
    this.options = options;
    this.pending = new Map();
    this.internal = new Map();
    this.held = [];
    this.tools = new Map();
    this.server = null;
    this.serverEra = null;
    this.toolLock = readToolLock(options.dir);
    this.toolsConfig = loadTools(options.dir);
    this.stale = true;
    this.probing = false;
    this.closed = false;
  }

  attach() {
    this.client = createInterface({ input: process.stdin });
    this.client.on('line', (line) => this.fromClient(line));
    this.server = createInterface({ input: this.child.stdout });
    this.server.on('line', (line) => this.fromServer(line));
    process.stdin.on('end', () => {
      try {
        this.child.stdin.end();
      } catch {
        // The upstream is already gone.
      }
    });
    this.child.on('error', (error) => {
      process.stderr.write(`mcp-proxy: ${error.message}\n`);
      process.exit(1);
    });
    this.child.on('exit', (code, signal) => {
      if (this.closed) return;
      this.closed = true;
      process.stderr.write(`mcp-proxy: upstream exited (${signal ?? code})\n`);
      process.exit(code ?? 1);
    });
  }

  fromClient(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (Array.isArray(message)) {
      process.stderr.write('mcp-proxy: refusing a JSON-RPC batch; it cannot be checked tool by tool\n');
      return;
    }
    this.handleClient(message);
  }

  handleClient(message) {
    if (this.probing) {
      this.held.push(message);
      return;
    }
    if (
      this.toolLock?.server_digest &&
      !this.server &&
      ['tools/list', 'tools/call', 'prompts/list', 'resources/list', 'resources/templates/list'].includes(message.method)
    ) {
      this.held.push(message);
      this.ensureServer();
      return;
    }
    const id = message.id;
    if (message.method === 'tools/call') {
      if (id === undefined) {
        process.stderr.write('mcp-proxy: refusing a tools/call notification\n');
        return;
      }
      if (!this.prepareCall(id, message.params)) return;
    }
    if (id !== undefined) this.pending.set(keyOf(id), { id, method: message.method });
    write(this.child.stdin, message);
  }

  ensureServer() {
    if (this.probing || this.server) return;
    this.probing = true;
    const id = `attesso-discover-${randomUUID()}`;
    this.internal.set(keyOf(id), { id, method: 'server/discover' });
    write(this.child.stdin, { jsonrpc: '2.0', id, method: 'server/discover', params: modernParams({}) });
    this.probeTimer = setTimeout(() => {
      this.probing = false;
      this.probeTimer = null;
      this.failHeld('SERVER_PIN_REQUIRED', 'the server did not answer discovery');
    }, SERVER_PROBE_TIMEOUT_MS);
  }

  failHeld(code, detail = code) {
    const held = this.held;
    this.held = [];
    for (const message of held) {
      if (message.id !== undefined) write(process.stdout, errorResponse(message.id, code, detail));
    }
  }

  prepareCall(id, params) {
    if (this.toolLock?.server_digest && !this.server) {
      write(process.stdout, errorResponse(id, 'SERVER_PIN_REQUIRED', 'discover and pin the server before calling tools'));
      return false;
    }
    if (this.stale || !this.toolLock) {
      write(process.stdout, errorResponse(id, 'TOOL_LIST_REQUIRED', 'list and pin the tools before calling them'));
      return false;
    }
    const name = typeof params?.name === 'string' ? params.name : '';
    if (name === '') {
      write(process.stdout, errorResponse(id, 'TOOL_NAME_MISSING', 'tools/call needs a tool name'));
      return false;
    }
    const tool = this.tools.get(name);
    if (!tool) {
      write(process.stdout, errorResponse(id, 'TOOL_UNPINNED', `${name} is not in the pinned list`, { tool: name }));
      return false;
    }
    const hash = definitionHash(tool);
    if (this.toolLock.tools[name] !== hash) {
      write(process.stdout, errorResponse(id, 'TOOL_CHANGED', `${name} differs from its pin`, { tool: name }));
      return false;
    }
    const classified = classifyTool(name, this.toolsConfig);
    let entry;
    try {
      entry = append(this.options.dir, {
        action: classified.action,
        subject: name,
        task: this.options.task,
        trust: classified.trust,
        capability: classified.capability,
        args_hash: argsFingerprint(params.arguments),
        detail_input: params.arguments ?? {},
        tool_hash: hash,
        mcp_digest: this.toolLock.server_digest ? this.toolLock.manifest_digest : undefined,
      });
    } catch (error) {
      write(process.stdout, errorResponse(id, 'PROXY_ERROR', error.message));
      return false;
    }
    if (entry.decision !== 'ALLOW') {
      write(
        process.stdout,
        errorResponse(id, 'TOOL_CALL_DENIED', `${name} was refused by the local policy`, {
          decision: entry.decision,
          policy_code: entry.code,
          entry: entry.seq,
        }),
      );
      return false;
    }
    return true;
  }

  fromServer(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (Array.isArray(message)) {
      process.stderr.write('mcp-proxy: refusing a JSON-RPC batch from the server\n');
      return;
    }
    // MCP 2026-07-28 forbids server-to-client requests; older servers still
    // send them. Fail closed for both eras.
    if (message.method && message.id !== undefined && SERVER_REQUESTS.has(message.method)) {
      process.stderr.write(`mcp-proxy: refused server request ${message.method}\n`);
      write(this.child.stdin, {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `attesso refused server request ${message.method}` },
      });
      return;
    }
    if (message.method === 'notifications/tools/list_changed') {
      this.stale = true;
      this.tools.clear();
      write(process.stdout, message);
      return;
    }
    if (message.id !== undefined) {
      const id = keyOf(message.id);
      if (this.internal.has(id)) {
        const request = this.internal.get(id);
        this.internal.delete(id);
        clearTimeout(this.probeTimer);
        this.probeTimer = null;
        this.probing = false;
        this.handleServer(message, request.method, false);
        return;
      }
      const request = this.pending.get(id);
      if (request?.method === 'initialize' || request?.method === 'server/discover') {
        this.pending.delete(id);
        this.handleServer(message, request.method, true);
        return;
      }
      if (request?.method === 'tools/list') {
        this.pending.delete(id);
        this.handleList(message);
        return;
      }
      if (request && SURFACES[request.method]) {
        this.pending.delete(id);
        this.handleSurface(message, request.method);
        return;
      }
      if (request) this.pending.delete(id);
    }
    write(process.stdout, message);
  }

  flushHeld() {
    const held = this.held;
    this.held = [];
    for (const message of held) this.handleClient(message);
  }

  handleServer(message, method, forward) {
    const era = method === 'server/discover' ? 'modern' : 'legacy';
    if (message.error) {
      if (forward) {
        write(process.stdout, message);
      } else {
        this.failHeld('SERVER_PIN_REQUIRED', message.error.message ?? 'discovery failed');
      }
      return;
    }
    let surface;
    try {
      surface = serverSurface(message.result, era);
    } catch (error) {
      if (forward) write(process.stdout, errorResponse(message.id, 'SERVER_RESPONSE_INVALID', error.message));
      else this.failHeld('SERVER_RESPONSE_INVALID', error.message);
      return;
    }
    if (this.toolLock?.server_digest && manifestDigest(surface) !== this.toolLock.server_digest) {
      const detail = 'server identity, instructions or capabilities changed; pin the same protocol era as the client';
      if (forward) write(process.stdout, errorResponse(message.id, 'SERVER_CHANGED', detail));
      else this.failHeld('SERVER_CHANGED', detail);
      return;
    }
    this.server = surface;
    this.serverEra = era;
    this.probing = false;
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = null;
    if (forward) write(process.stdout, message);
    this.flushHeld();
  }

  handleSurface(message, method) {
    if (message.error) {
      write(process.stdout, message);
      return;
    }
    const surface = SURFACES[method];
    try {
      const values = listOf(message.result, surface.key, method);
      if (this.toolLock?.server_digest) {
        const field = `${surface.field}_digest`;
        if (this.toolLock[field] === undefined) {
          throw new Error(`${surface.field.toUpperCase()}_NOT_PINNED: ${method} was not pinned`);
        }
        if (manifestDigest(values) !== this.toolLock[field]) {
          throw new Error(`${surface.field.toUpperCase()}_CHANGED: ${method} differs from its pin`);
        }
      }
    } catch (error) {
      const code = /^[A-Z_]+:/.test(error.message) ? error.message.split(':')[0] : 'SURFACE_INVALID';
      const detail = error.message.startsWith(`${code}:`) ? error.message.slice(code.length + 1).trim() : error.message;
      write(process.stdout, errorResponse(message.id, code, detail));
      return;
    }
    write(process.stdout, message);
  }

  handleList(message) {
    if (message.error) {
      write(process.stdout, message);
      return;
    }
    let tools;
    try {
      if (this.toolLock?.server_digest && !this.server) {
        throw new Error('SERVER_PIN_REQUIRED: discover and pin the server before listing tools');
      }
      tools = listOf(message.result);
      if (!this.toolLock) throw new Error('TOOL_PIN_MISSING: run attesso tools pin before starting the proxy');
      const compared = comparePin(this.toolLock, { tools }, this.toolsConfig);
      if (compared.digestChanged || compared.changed.length > 0 || compared.added.length > 0 || compared.removed.length > 0) {
        throw new Error(
          `TOOL_CHANGED: ${[...compared.changed, ...compared.added, ...compared.removed].join(', ') || 'tools digest changed'}`,
        );
      }
      this.tools = new Map(tools.map((tool) => [tool.name, tool]));
      this.stale = false;
    } catch (error) {
      const code = /^TOOL_[A-Z_]+:/.test(error.message) ? error.message.split(':')[0] : 'TOOL_LIST_INVALID';
      const detail = error.message.startsWith(`${code}:`) ? error.message.slice(code.length + 1).trim() : error.message;
      write(process.stdout, errorResponse(message.id, code, detail));
      return;
    }
    write(process.stdout, message);
  }
}

class Rpc {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id !== undefined && this.pending.has(keyOf(message.id))) {
        const pending = this.pending.get(keyOf(message.id));
        this.pending.delete(keyOf(message.id));
        clearTimeout(pending.timer);
        pending.resolve(message);
      }
    });
    child.on('error', (error) => this.rejectAll(error));
    child.on('exit', (code, signal) => {
      if (!this.closed) this.rejectAll(new Error(`upstream exited (${signal ?? code})`));
    });
  }

  request(method, params = {}, { timeout = REQUEST_TIMEOUT_MS } = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(keyOf(id));
        reject(new Error(`upstream did not answer ${method}`));
      }, timeout);
      this.pending.set(keyOf(id), { resolve, timer });
      write(this.child.stdin, { jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params = {}) {
    write(this.child.stdin, { jsonrpc: '2.0', method, params });
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ error: { message: error.message } });
    }
    this.pending.clear();
  }

  close() {
    this.closed = true;
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
    this.lines.close();
    try {
      this.child.stdin.end();
    } catch {
      // Already closed.
    }
    this.child.kill();
  }
}

async function printManifest(command, args, era) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  const rpc = new Rpc(child);
  try {
    const { era: detected, result } = await probeServer(rpc, era);
    if (detected === 'legacy') rpc.notify('notifications/initialized');
    const server = serverSurface(result, detected);
    const capabilities = server.capabilities;
    const tools = await listAll(rpc, 'tools/list', 'tools', detected);
    const manifest = { server, tools };
    if (capabilities.prompts) manifest.prompts = await listAll(rpc, 'prompts/list', 'prompts', detected);
    if (capabilities.resources) {
      manifest.resources = await listAll(rpc, 'resources/list', 'resources', detected);
      const templates = await listAll(rpc, 'resources/templates/list', 'resourceTemplates', detected, false);
      if (templates) manifest.resourceTemplates = templates;
    }
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    rpc.close();
  }
}

function start(command, args) {
  return spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!options.command) throw new Error(`a server command is required\n${usage()}`);
  if (options.print) {
    await printManifest(options.command, options.args, options.era);
    return;
  }
  const child = start(options.command, options.args);
  const proxy = new Proxy(child, options);
  proxy.attach();
}

main().catch((error) => {
  process.stderr.write(`mcp-proxy: ${error.message}\n`);
  process.exitCode = 1;
});
