import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { append, init, paths } from '../src/store.mjs';
import { captureDetail, MAX_DETAIL_BYTES } from '../src/detail.mjs';
import { Catalog } from '../src/ui/catalog.mjs';
import { startUi } from '../src/ui/server.mjs';

const bin = join(import.meta.dirname, '..', 'bin', 'attesso.mjs');

function fixture() {
  const dir = join(mkdtempSync(join(tmpdir(), 'attesso-edges-')), 'ledger');
  init(dir);
  return dir;
}

function cli(dir, ...args) {
  try {
    const stdout = execFileSync(process.execPath, [bin, '--dir', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

test('scanDay stops as soon as the caller returns false', () => {
  const dir = fixture();
  for (let index = 0; index < 200; index += 1) {
    append(dir, { action: 'log', subject: `row-${index}`, task: 'scan' });
  }
  const catalog = new Catalog(dir);
  let calls = 0;
  const day = new Date().toISOString().slice(0, 10);
  catalog.scanDay(day, 'UTC', () => {
    calls += 1;
    return false;
  });
  assert.equal(calls, 1);
});

test('the preview strips terminal control characters', () => {
  const result = captureDetail({
    seq: 1,
    at: new Date().toISOString(),
    action: 'tool.call',
    tool: 'terminal',
    input: { command: 'echo \u001b[31mred\u001b[0m\u0007\u001b]0;title\u0007 done' },
  });
  assert.equal(result.detail.fields.command.includes('\u001b'), false);
  assert.equal(result.detail.fields.command.includes('\u0007'), false);
  assert.equal(result.detail.summary.includes('\u001b'), false);
});

test('the detail directory is private and an oversized file is refused', async () => {
  const dir = fixture();
  const entry = append(dir, {
    action: 'tool.call',
    subject: 'terminal',
    task: 'mode',
    capability: 'execute',
    detail_input: { command: 'echo mode' },
  });
  const details = paths(dir).details;
  assert.equal(statSync(details).mode & 0o777, 0o700);
  writeFileSync(join(details, `${entry.seq}.json`), 'x'.repeat(MAX_DETAIL_BYTES * 5));
  const ui = await startUi({ dir, home: dir, port: 0, open: false });
  try {
    const response = await fetch(`${ui.url}api/v1/detail?seq=${entry.seq}`, { headers: { 'x-bounds-token': ui.token } });
    const body = await response.json();
    assert.equal(body.state, 'changed');
    assert.match(body.reason, /unreadable|regular file/);
  } finally {
    await ui.close();
  }
});

test('detail rejects aliased numbers and delete without a preview', () => {
  const dir = fixture();
  for (const value of ['1e3', '0x10', '01', '+1', ' 1']) {
    const result = cli(dir, 'detail', value);
    assert.equal(result.status, 2, value);
    assert.match(result.stderr, /usage: attesso detail/);
  }
  const none = append(dir, { action: 'log', subject: 'none', task: 'delete' });
  const deleted = cli(dir, 'detail', String(none.seq), '--delete');
  assert.equal(deleted.status, 2);
  assert.match(deleted.stderr, /has no preview to delete/);
});

test('a symlinked or rewritten preview is refused', () => {
  const dir = fixture();
  const entry = append(dir, {
    action: 'tool.call',
    subject: 'terminal',
    task: 'symlink',
    capability: 'execute',
    detail_input: { command: 'echo symlink' },
  });
  const file = join(paths(dir).details, `${entry.seq}.json`);
  const target = join(dir, 'outside.json');
  writeFileSync(target, readFileSync(file, 'utf8'));
  unlinkSync(file);
  symlinkSync(target, file);
  const linked = cli(dir, 'detail', String(entry.seq));
  assert.equal(linked.status, 2);
  assert.match(linked.stderr, /regular file/);

  unlinkSync(file);
  writeFileSync(file, readFileSync(target, 'utf8').replace('"summary":', '"summary": "duplicate", "summary":'));
  const duplicate = cli(dir, 'detail', String(entry.seq));
  assert.equal(duplicate.status, 2);
  assert.match(duplicate.stderr, /written form/);
});

test('the detail endpoint refuses other methods and sets the page headers', async () => {
  const dir = fixture();
  const ui = await startUi({ dir, home: dir, port: 0, open: false });
  try {
    const refused = await fetch(`${ui.url}api/v1/detail?seq=1`, {
      method: 'POST',
      headers: { 'x-bounds-token': ui.token, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(refused.status, 405);
    const page = await fetch(ui.url, { headers: { 'x-bounds-token': ui.token } });
    assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    await ui.close();
  }
});
