import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { init } from '../src/store.mjs';
import { tempDir } from './helpers.mjs';

const controlBin = fileURLToPath(new URL('../bin/attesso-control-mcp.mjs', import.meta.url));
const fixture = () => {
  const root = tempDir('attesso-mcp');
  const dir = join(root, 'ledger');
  const home = join(root, 'home');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  init(dir);
  return { dir, home };
};
const run = (dir, home, messages) => {
  const input = messages.map((message) => JSON.stringify(message)).join('\n') + '\n';
  return spawnSync('node', [controlBin, '--dir', dir, '--home', home], { input, encoding: 'utf8' });
};
const message = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
const replies = (result) => result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

test('the control server supports legacy initialization and direct modern calls', () => {
  const { dir, home } = fixture();
  const result = run(dir, home, [
    message(1, 'initialize', { protocolVersion: '2025-11-25' }),
    message(2, 'tools/list'),
  ]);
  assert.equal(result.status, 0, result.stderr);
  const output = replies(result);
  assert.equal(output[0].result.serverInfo.name, 'attesso-control');
  assert.ok(output[1].result.tools.some((tool) => tool.name === 'bounds_status'));
  assert.ok(output[1].result.tools.some((tool) => tool.name === 'bounds_connect'));

  const direct = run(dir, home, [message(1, 'tools/list')]);
  assert.equal(direct.status, 0, direct.stderr);
  assert.ok(replies(direct)[0].result.tools.length >= 5);
});

test('the control server refuses enforcement and path widening', () => {
  const { dir, home } = fixture();
  const result = run(dir, home, [
    message(1, 'tools/call', { name: 'bounds_mode', arguments: { mode: 'observe' } }),
    message(2, 'tools/call', { name: 'bounds_mode', arguments: { mode: 'enforce' } }),
    message(3, 'tools/call', { name: 'bounds_paths_get', arguments: {} }),
    message(4, 'tools/call', { name: 'bounds_paths_set', arguments: { allowed_roots: [{ path: '/tmp', access: ['read'] }], exclusions: [] } }),
    message(5, 'nope'),
  ]);
  assert.equal(result.status, 0, result.stderr);
  const output = replies(result);
  assert.equal(output[0].result.isError, undefined);
  assert.match(output[1].result.content[0].text, /enforce is a human CLI action/);
  assert.equal(output[2].result.isError, undefined);
  assert.match(output[3].result.content[0].text, /widening requires the human CLI/);
  assert.equal(output[4].error.code, -32601);
});

test('a malformed line is a JSON-RPC parse error, not a crash', () => {
  const { dir, home } = fixture();
  const result = spawnSync('node', [controlBin, '--dir', dir, '--home', home], {
    input: '{not json\n' + JSON.stringify(message(1, 'ping')) + '\n',
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const output = replies(result);
  assert.equal(output[0].error.code, -32700);
  assert.deepEqual(output[1].result, {});
});

