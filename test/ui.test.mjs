import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { append, init } from '../src/store.mjs';
import { startUi } from '../src/ui/server.mjs';
import { tempDir } from './helpers.mjs';

const fixture = () => {
  const root = tempDir('attesso-ui');
  const home = tempDir('attesso-ui-home');
  const ledger = join(root, 'ledger');
  mkdirSync(ledger, { recursive: true });
  init(ledger);
  return { ledger, home };
};
const headers = (token) => ({ 'x-bounds-token': token, 'content-type': 'application/json' });
const get = (ui, path) => fetch(`${ui.url}${path}`, { headers: headers(ui.token) });
const post = (ui, path, body) => fetch(`${ui.url}${path}`, {
  method: 'POST',
  headers: headers(ui.token),
  body: JSON.stringify(body),
});

test('ui refuses to start without a ledger', () => {
  const root = tempDir('attesso-ui-no-ledger');
  const home = tempDir('attesso-ui-no-ledger-home');
  const result = spawnSync(process.execPath, [join(process.cwd(), 'bin/attesso.mjs'), 'ui', '--no-open', '--port', '0'], {
    cwd: root,
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no ledger at .*; run attesso init first/);
});

test('the packaged UI serves the page, status, calls and paths over loopback', async () => {
  const { ledger, home } = fixture();
  append(ledger, { action: 'tool.call', subject: 'read_file', task: 'task-1', trust: 'internal', capability: 'read' });
  const ui = await startUi({ dir: ledger, home, port: 0, open: false });
  try {
    const page = await fetch(ui.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, new RegExp(ui.token));
    assert.match(html, /api\/v1\/days/);
    assert.match(html, /workspace-panel/);
    assert.doesNotMatch(html, /fetch\('\/api\/calls'/);
    assert.equal((await fetch(`${ui.url}api/status`)).status, 401);

    const status = await get(ui, 'api/status');
    assert.equal(status.status, 200);
    assert.equal((await status.json()).initialized, true);

    const calls = await get(ui, 'api/calls');
    const body = await calls.json();
    assert.equal(sizeof(body.days), 1);
    const day = Object.keys(body.days)[0];
    assert.equal(body.days[day][0][2], 'read_file');
    assert.ok(body.head >= 1);

    const summary = await get(ui, `api/v1/summary?day=${day}&tz=UTC`);
    assert.equal(summary.status, 200);
    assert.equal((await summary.json()).calls, 1);
    const pageResponse = await get(ui, `api/v1/calls?day=${day}&tz=UTC&limit=1`);
    const pageBody = await pageResponse.json();
    assert.equal(pageBody.rows.length, 1);
    assert.equal(pageBody.rows[0][2], 'read_file');
    assert.match(pageBody.next_cursor, /^v1:1:UTC$/);
    assert.equal((await get(ui, 'api/v1/calls?day=2026-02-31&tz=UTC')).status, 400);
    assert.equal((await get(ui, 'api/v1/calls?tz=No/Such_Zone')).status, 400);

    const paths = await get(ui, 'api/paths');
    assert.deepEqual(await paths.json(), { version: 1, allowed_roots: [], exclusions: [] });
    const next = { version: 1, allowed_roots: [{ path: home, access: ['read'] }], exclusions: ['**/.env'] };
    assert.equal((await post(ui, 'api/paths', next)).status, 200);
    assert.deepEqual(await (await get(ui, 'api/paths')).json(), next);

    assert.deepEqual(await (await get(ui, 'api/workspace')).json(), { connected: false });
    assert.equal((await post(ui, 'api/sync', {})).status, 400);
    const saved = await post(ui, 'api/workspace', {
      sync_url: 'https://api.attesso.com',
      api_key: 'att_test_abcdefghijkl',
      workspace: 'Attesso',
    });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    assert.equal(savedBody.connected, true);
    assert.equal(JSON.stringify(savedBody).includes('att_test_'), false);
    const workspaceFile = join(home, '.config', 'attesso', 'config.json');
    assert.equal((await import('node:fs')).statSync(workspaceFile).mode & 0o777, 0o600);
    assert.deepEqual(await (await get(ui, 'api/workspace')).json(), {
      connected: true,
      sync_url: 'https://api.attesso.com',
      workspace: 'Attesso',
    });
    assert.equal((await post(ui, 'api/workspace', { sync_url: 'http://remote.example', api_key: 'att_test_abcdefghijkl' })).status, 400);
    assert.equal((await fetch(`${ui.url}api/workspace`, { method: 'DELETE', headers: headers(ui.token) })).status, 200);
    assert.deepEqual(await (await get(ui, 'api/workspace')).json(), { connected: false });
  } finally {
    await ui.close();
  }
});

test('the UI stream appends a new decision once', async () => {
  const { ledger, home } = fixture();
  const ui = await startUi({ dir: ledger, home, port: 0, open: false });
  try {
    const initial = await (await get(ui, 'api/calls')).json();
    const controller = new AbortController();
    const stream = await fetch(`${ui.url}api/events?after=${initial.head}`, {
      headers: { 'x-bounds-token': ui.token },
      signal: controller.signal,
    });
    const reader = stream.body.getReader();
    append(ledger, { action: 'tool.call', subject: 'write_file', task: 'task-2', trust: 'internal', capability: 'write' });
    const decoder = new TextDecoder();
    let text = '';
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && !text.includes('write_file')) {
      const result = await reader.read();
      if (result.done) break;
      text += decoder.decode(result.value, { stream: true });
    }
    controller.abort();
    assert.match(text, /event: decision/);
    assert.match(text, /write_file/);
    assert.match(text, /"seq":1/);
  } finally {
    await ui.close();
  }
});

test('the UI mode endpoint is scoped to a temporary home', async () => {
  const { ledger, home } = fixture();
  writeFileSync(join(home, 'config.yaml'), 'approvals:\n  mode: "off"\n');
  const ui = await startUi({ dir: ledger, home, port: 0, open: false });
  try {
    const response = await post(ui, 'api/mode', { mode: 'observe' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status.mode, 'observe');
    assert.equal((await get(ui, 'api/status')).status, 200);
  } finally {
    await ui.close();
  }
});

const sizeof = (value) => Object.keys(value).length;


test('the v1 query sees an append made after the catalog was built', async () => {
  const { ledger, home } = fixture();
  const day = new Date().toISOString().slice(0, 10);
  append(ledger, { action: 'tool.call', subject: 'read_file', task: 'task-1', trust: 'internal', capability: 'read' });
  const ui = await startUi({ dir: ledger, home, port: 0, open: false });
  try {
    const before = await (await get(ui, `api/v1/summary?day=${day}&tz=UTC`)).json();
    append(ledger, { action: 'tool.call', subject: 'write_file', task: 'task-2', trust: 'internal', capability: 'write' });
    const after = await (await get(ui, `api/v1/summary?day=${day}&tz=UTC`)).json();
    assert.equal(after.calls, before.calls + 1);
  } finally {
    await ui.close();
  }
});


test('the v1 usage endpoint reports measured session totals', async () => {
  const { ledger, home } = fixture();
  const day = new Date().toISOString().slice(0, 10);
  append(ledger, { action: 'tool.call', subject: 'read_file', task: 'task-1', trust: 'internal', capability: 'read' });
  append(ledger, { action: 'llm.session', subject: 'deepseek', task: 'task-1', meta: { tokens: 900, cost_usd: 0.01 } });
  const ui = await startUi({ dir: ledger, home, port: 0, open: false });
  try {
    const response = await get(ui, `api/v1/usage?day=${day}&tz=UTC`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.totals.tokens, 900);
    assert.equal(body.totals.calls, 1);
    assert.equal(body.coverage, 1);
  } finally {
    await ui.close();
  }
});
