import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTools } from '../src/classify.mjs';
import { bundleFor, verifyBundle } from '../src/bundle.mjs';
import { pinManifest } from '../src/toolpin.mjs';
import { readDetail, readEntries, writeMcpManifest, writeToolLock } from '../src/store.mjs';
import { verifyDetail } from '../src/detail.mjs';
import { initWorkspace, tempDir } from './helpers.mjs';

const proxy = fileURLToPath(new URL('../src/mcp-proxy.mjs', import.meta.url));
const proxyBin = fileURLToPath(new URL('../bin/attesso-mcp.mjs', import.meta.url));
const server = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};
const modern = (params = {}) => ({ ...params, _meta: { ...(params._meta ?? {}), ...MODERN_META } });

const STABLE = [
  {
    name: 'read_file',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
];
const PROMPTS = [{ name: 'review', description: 'Review a change', arguments: [] }];
const RESOURCES = [{ uri: 'file:///notes.txt', name: 'notes', mimeType: 'text/plain' }];
const MODERN_SERVER = {
  protocol: '2026-07-28',
  supportedVersions: ['2026-07-28'],
  capabilities: {
    tools: { listChanged: true },
    prompts: { listChanged: true },
    resources: { listChanged: true },
  },
  serverInfo: { name: 'fake-modern', version: '1.0.0' },
  instructions: 'Use the fake server.',
};

function pinStable(dir) {
  writeToolLock(dir, pinManifest({ tools: STABLE }, loadTools(dir)));
}

function pinFull(dir) {
  const manifest = { server: MODERN_SERVER, tools: STABLE, prompts: PROMPTS, resources: RESOURCES };
  writeMcpManifest(dir, manifest);
  writeToolLock(dir, pinManifest(manifest, loadTools(dir)));
}

class Client {
  constructor(child) {
    this.child = child;
    this.pending = new Map();
    this.notifications = [];
    this.nextId = 1;
    this.stderr = '';
    child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.resolve(message);
        return;
      }
      this.notifications.push(message);
    });
    child.on('exit', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`proxy exited: ${this.stderr}`));
      }
      this.pending.clear();
    });
  }

  request(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no ${method} response: ${this.stderr}`));
      }, 4000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async notification(method) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const found = this.notifications.find((message) => message.method === method);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no ${method} notification: ${this.stderr}`);
  }

  close() {
    this.lines.close();
    this.child.stdin.end();
    this.child.kill();
  }
}

function startProxy(dir, mode = 'stable', extraEnv = {}) {
  const log = join(tempDir('mcp-calls'), 'calls.log');
  const requestLog = join(tempDir('mcp-requests'), 'requests.log');
  const child = spawn(process.execPath, [proxy, '--dir', dir, '--', process.execPath, server], {
    env: {
      ...process.env,
      FAKE_MCP_MODE: mode,
      FAKE_MCP_CALL_LOG: log,
      FAKE_MCP_SERVER_REQUEST_LOG: requestLog,
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { client: new Client(child), child, log, requestLog };
}

async function initialize(client) {
  const response = await client.request('initialize', {
    protocolVersion: '2026-07-28',
    capabilities: {},
    clientInfo: { name: 'test', version: '0.0.0' },
  });
  assert.equal(response.error, undefined);
  client.notify('notifications/initialized');
}

async function discover(client) {
  const response = await client.request('server/discover', modern());
  assert.equal(response.error, undefined, response.error?.message);
  return response;
}

function pinnedCall(client) {
  return client.request('tools/call', { name: 'read_file', arguments: { path: 'notes.txt' } });
}

test('the attesso-mcp command is wired', () => {
  const output = spawnSync(process.execPath, [proxyBin, '--help'], { encoding: 'utf8' });
  assert.equal(output.status, 0, output.stderr);
  assert.match(output.stdout, /--print-manifest/);
});

test('print-manifest can pin the legacy handshake explicitly', () => {
  const output = spawnSync(
    process.execPath,
    [proxy, '--print-manifest', '--era', 'legacy', '--', process.execPath, server],
    { env: { ...process.env, FAKE_MCP_MODE: 'stable' }, encoding: 'utf8' },
  );
  assert.equal(output.status, 0, output.stderr);
  const manifest = JSON.parse(output.stdout);
  assert.equal(manifest.server.protocolVersion, '2025-11-25');
  assert.equal(manifest.server.serverInfo.name, 'fake-legacy');
});

test('a modern 2026-07-28 client pins the server, tools, prompts and resources', async () => {
  const dir = initWorkspace('attesso-mcp-modern');
  pinFull(dir);
  const { client } = startProxy(dir);
  try {
    const discovered = await discover(client);
    assert.equal(discovered.result.supportedVersions[0], '2026-07-28');
    const listed = await client.request('tools/list', modern());
    assert.equal(listed.result.tools[0].name, 'read_file');
    const prompts = await client.request('prompts/list', modern());
    assert.equal(prompts.result.prompts[0].name, 'review');
    const resources = await client.request('resources/list', modern());
    assert.equal(resources.result.resources[0].uri, 'file:///notes.txt');
    const called = await pinnedCall(client);
    assert.equal(called.result.content[0].text, 'ok');
    const entry = readEntries(dir).at(-1);
    assert.equal(entry.decision, 'ALLOW');
    assert.match(entry.detail_hash, /^[a-f0-9]{64}$/);
    const detail = readDetail(dir, entry.seq);
    assert.equal(detail.summary, 'notes.txt');
    assert.deepEqual(verifyDetail(entry, detail), { ok: true });
  } finally {
    client.close();
  }
});

test('changed server instructions are refused before a tool list', async () => {
  const dir = initWorkspace('attesso-mcp-instructions');
  pinFull(dir);
  const { client } = startProxy(dir, 'instructions-changed');
  try {
    const discovered = await client.request('server/discover', modern());
    assert.equal(discovered.error.data.code, 'SERVER_CHANGED');
    assert.match(discovered.error.message, /server identity/);
  } finally {
    client.close();
  }
});

test('changed prompts are refused when the client asks for them', async () => {
  const dir = initWorkspace('attesso-mcp-prompts');
  pinFull(dir);
  const { client } = startProxy(dir, 'prompt-changed');
  try {
    await discover(client);
    const prompts = await client.request('prompts/list', modern());
    assert.equal(prompts.error.data.code, 'PROMPTS_CHANGED');
  } finally {
    client.close();
  }
});

test('a server-initiated sampling request is refused', async () => {
  const dir = initWorkspace('attesso-mcp-sampling');
  pinFull(dir);
  const { client, requestLog } = startProxy(dir, 'server-request');
  try {
    await discover(client);
    const listed = await client.request('tools/list', modern());
    assert.equal(listed.result.tools.length, 1);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (existsSync(requestLog) && readFileSync(requestLog, 'utf8').trim() === 'refused') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(requestLog), true);
    assert.equal(readFileSync(requestLog, 'utf8').trim(), 'refused');
  } finally {
    client.close();
  }
});

test('print-manifest follows a paginated tool list', () => {
  const output = spawnSync(process.execPath, [proxy, '--print-manifest', '--', process.execPath, server], {
    env: { ...process.env, FAKE_MCP_MODE: 'paginated' },
    encoding: 'utf8',
  });
  assert.equal(output.status, 0, output.stderr);
  const manifest = JSON.parse(output.stdout);
  assert.deepEqual(manifest.tools, STABLE);
  assert.equal(manifest.server.instructions, 'Use the fake server.');
});

test('a bundle carries the pinned MCP manifest and refuses a swapped one', async () => {
  const dir = initWorkspace('attesso-mcp-bundle');
  pinFull(dir);
  const { client } = startProxy(dir);
  try {
    await discover(client);
    await client.request('tools/list', modern());
    await pinnedCall(client);
    const entry = readEntries(dir).at(-1);
    const bundle = bundleFor(dir, entry.seq);
    assert.equal(verifyBundle(bundle).ok, true);
    assert.equal(bundle.mcp.server.serverInfo.name, 'fake-modern');
    assert.equal(bundle.tool_lock.tools.read_file, entry.tool_hash);
    bundle.mcp.tools[0].description = 'swapped';
    const refused = verifyBundle(bundle);
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /mcp_digest/);
    bundle.mcp.tools[0].description = 'Read a file';
    bundle.tool_lock.tools.read_file = 'not-the-hash';
    const lockRefused = verifyBundle(bundle);
    assert.equal(lockRefused.ok, false);
    assert.match(lockRefused.reason, /tool_hash/);
  } finally {
    client.close();
  }
});

test('a modern client may skip discovery and the proxy discovers before listing', async () => {
  const dir = initWorkspace('attesso-mcp-autodiscover');
  pinFull(dir);
  const { client } = startProxy(dir);
  try {
    const listed = await client.request('tools/list', modern());
    assert.equal(listed.result.tools[0].name, 'read_file');
    const called = await pinnedCall(client);
    assert.equal(called.result.content[0].text, 'ok');
  } finally {
    client.close();
  }
});

test('a pinned MCP call is allowed and recorded', async () => {
  const dir = initWorkspace('attesso-mcp-allowed');
  pinStable(dir);
  const { client } = startProxy(dir);
  try {
    await initialize(client);
    const listed = await client.request('tools/list', {});
    assert.equal(listed.result.tools[0].name, 'read_file');
    const called = await pinnedCall(client);
    assert.equal(called.result.content[0].text, 'ok');
    const entry = readEntries(dir).at(-1);
    assert.equal(entry.decision, 'ALLOW');
    assert.equal(entry.subject, 'read_file');
    assert.ok(entry.tool_hash);
    assert.equal(entry.tool_pin, 'verified');
  } finally {
    client.close();
  }
});

test('a changed tool definition is refused before the call', async () => {
  const dir = initWorkspace('attesso-mcp-changed');
  pinStable(dir);
  const { client, log } = startProxy(dir, 'changed');
  try {
    await initialize(client);
    const listed = await client.request('tools/list', {});
    assert.equal(listed.error.data.code, 'TOOL_CHANGED');
    assert.match(listed.error.message, /read_file/);
    assert.equal(existsSync(log), false);
    assert.equal(readEntries(dir).length, 0);
  } finally {
    client.close();
  }
});

test('a list without a pin is refused', async () => {
  const dir = initWorkspace('attesso-mcp-unpinned');
  const { client } = startProxy(dir);
  try {
    await initialize(client);
    const listed = await client.request('tools/list', {});
    assert.equal(listed.error.data.code, 'TOOL_PIN_MISSING');
  } finally {
    client.close();
  }
});

test('list_changed invalidates the pinned list', async () => {
  const dir = initWorkspace('attesso-mcp-stale');
  pinStable(dir);
  const { client, log } = startProxy(dir, 'list-changed');
  try {
    await initialize(client);
    const listed = await client.request('tools/list', {});
    assert.equal(listed.result.tools[0].name, 'read_file');
    await client.notification('notifications/tools/list_changed');
    const called = await pinnedCall(client);
    assert.equal(called.error.data.code, 'TOOL_LIST_REQUIRED');
    assert.equal(existsSync(log), false);
  } finally {
    client.close();
  }
});

test('a paginated tool list is refused', async () => {
  const dir = initWorkspace('attesso-mcp-paginated');
  pinStable(dir);
  const { client } = startProxy(dir, 'paginated');
  try {
    await initialize(client);
    const listed = await client.request('tools/list', {});
    assert.equal(listed.error.data.code, 'TOOL_LIST_PAGINATED');
  } finally {
    client.close();
  }
});

test('a local policy refusal never reaches the upstream server', async () => {
  const dir = initWorkspace('attesso-mcp-denied');
  pinStable(dir);
  writeFileSync(join(dir, 'policy.json'), JSON.stringify({ version: 1, action: '*', subjects: ['other'] }));
  const { client, log } = startProxy(dir);
  try {
    await initialize(client);
    const listed = await client.request('tools/list', {});
    assert.equal(listed.result.tools.length, 1);
    const called = await pinnedCall(client);
    assert.equal(called.error.data.code, 'TOOL_CALL_DENIED');
    assert.equal(existsSync(log), false);
    assert.equal(readEntries(dir).at(-1).decision, 'DENY');
  } finally {
    client.close();
  }
});

test('print-manifest emits the definitions before any pin exists', () => {
  const output = spawnSync(process.execPath, [proxy, '--print-manifest', '--', process.execPath, server], {
    env: { ...process.env, FAKE_MCP_MODE: 'stable' },
    encoding: 'utf8',
  });
  assert.equal(output.status, 0, output.stderr);
  const manifest = JSON.parse(output.stdout);
  assert.deepEqual(manifest.tools, STABLE);
});
