import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { append, deleteDetail, init, paths, readDetail, setRunBudget } from '../src/store.mjs';
import { endRun, startRun } from '../src/run.mjs';
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

test('run markers do not appear as calls', async () => {
  const { ledger, home } = fixture();
  append(ledger, { action: 'tool.call', subject: 'read_file', task: 'task-1', trust: 'internal', capability: 'read' });
  append(ledger, { action: 'run.start', subject: 'run' });
  append(ledger, { action: 'run.end', subject: 'run' });
  const ui = await startUi({ dir: ledger, home, port: 0, open: false });
  try {
    const body = await (await get(ui, 'api/calls')).json();
    assert.equal(sizeof(body.days), 1);
    const day = Object.keys(body.days)[0];
    assert.deepEqual(body.days[day].map((row) => row[2]), ['read_file']);
  } finally {
    await ui.close();
  }
});

test('the detail endpoint verifies, and names missing and changed previews', async () => {
  const { ledger, home } = fixture();
  const entry = append(ledger, {
    action: 'tool.call',
    subject: 'terminal',
    task: 'task-1',
    capability: 'execute',
    detail_input: { command: 'echo hi' },
  });
  const ui = await startUi({ dir: ledger, home, port: 0, open: false });
  try {
    const verified = await (await get(ui, `api/v1/detail?seq=${entry.seq}`)).json();
    assert.equal(verified.state, 'verified');
    assert.equal(verified.detail.summary, 'echo hi');

    const none = append(ledger, { action: 'tool.call', subject: 'terminal', task: 'task-2', capability: 'execute' });
    assert.equal((await (await get(ui, `api/v1/detail?seq=${none.seq}`)).json()).state, 'none');

    deleteDetail(ledger, entry.seq);
    assert.equal((await (await get(ui, `api/v1/detail?seq=${entry.seq}`)).json()).state, 'missing');

    const second = append(ledger, {
      action: 'tool.call',
      subject: 'terminal',
      task: 'task-3',
      capability: 'execute',
      detail_input: { command: 'echo changed' },
    });
    const detail = readDetail(ledger, second.seq);
    writeFileSync(join(paths(ledger).details, `${second.seq}.json`), JSON.stringify({ ...detail, summary: 'tampered' }));
    assert.equal((await (await get(ui, `api/v1/detail?seq=${second.seq}`)).json()).state, 'changed');

    assert.equal((await get(ui, 'api/v1/detail?seq=0')).status, 400);
    assert.equal((await get(ui, 'api/v1/detail?seq=999999')).status, 404);
    assert.equal((await fetch(`${ui.url}api/v1/detail?seq=${entry.seq}`)).status, 401);
  } finally {
    await ui.close();
  }
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
    const statusBody = await status.json();
    assert.equal(statusBody.initialized, true);
    assert.equal(statusBody.budget, null);
    assert.equal(statusBody.run, null);
    assert.equal(statusBody.last, null);

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

test('the status endpoint reports the run budget', async () => {
  const { ledger, home } = fixture();
  setRunBudget(ledger, { tokens: '1000', usd: '0.5', enforce: true });
  const run = startRun(ledger, { goal: 'dogfood' });
  const ui = await startUi({ dir: ledger, home, port: 0, open: false });
  try {
    const body = await (await get(ui, 'api/status')).json();
    assert.deepEqual(body.budget, { tokens: 1000, usd: 0.5, enforce: true });
    assert.equal(body.run.id, run.id);
    assert.equal(body.run.goal, 'dogfood');
    assert.equal(body.last, null);

    endRun(ledger, { outcome: 'success', note: 'done' });
    const after = await (await get(ui, 'api/status')).json();
    assert.equal(after.run, null);
    assert.equal(after.last.outcome, 'success');
    assert.equal(after.last.goal, 'dogfood');
    assert.equal(after.last.note, 'done');
  } finally {
    await ui.close();
  }
});

test('the status endpoint names unreadable rules instead of hiding them', async () => {
  const { ledger, home } = fixture();
  writeFileSync(paths(ledger).rules, JSON.stringify({
    version: 1,
    rules: [{ id: 'run-budget', max_tokens: -1, deny: { capabilities: ['execute'] } }],
  }));
  const ui = await startUi({ dir: ledger, home, port: 0, open: false });
  try {
    const body = await (await get(ui, 'api/status')).json();
    assert.deepEqual(body.budget, { error: 'rules unreadable' });
  } finally {
    await ui.close();
  }
});

test('the v1 export returns every call for the day, not just the loaded page', async () => {
  const { ledger, home } = fixture();
  const base = Date.UTC(2026, 10, 2);
  const entries = [];
  for (let index = 1; index <= 250; index += 1) {
    const write = index % 5 === 0;
    entries.push(JSON.stringify({
      seq: index,
      at: new Date(base + index * 1000).toISOString(),
      action: 'tool.call',
      subject: write ? 'write_file' : 'read_file',
      task: 'export-task',
      trust: 'internal',
      capability: write ? 'write' : 'read',
      decision: 'ALLOW',
      code: 'ALLOW',
    }));
  }
  writeFileSync(paths(ledger).ledger, entries.join('\n') + '\n');
  writeFileSync(paths(ledger).config, JSON.stringify({ version: 1, head: { count: 250, hash: 'export-fixture' } }));
  const ui = await startUi({ dir: ledger, home, port: 0, open: false });
  try {
    const response = await get(ui, 'api/v1/calls/export?day=2026-11-02&tz=UTC&limit=10');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/csv/);
    const lines = (await response.text()).trimEnd().split('\n');
    assert.equal(lines[0], 'day,time,tool,capability,decision,rule,task');
    assert.equal(lines.length, 251);
    assert.equal(lines[1], '"2026-11-02","00:00","read_file","read","ALLOW","ALLOW","export-task"');
    assert.equal(lines[250], '"2026-11-02","00:04","write_file","write","ALLOW","ALLOW","export-task"');
    const filtered = await get(ui, 'api/v1/calls/export?day=2026-11-02&tz=UTC&tool=write_file');
    assert.equal((await filtered.text()).trimEnd().split('\n').length, 51);
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
