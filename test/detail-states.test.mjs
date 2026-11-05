import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { append, init, paths, readDetail } from '../src/store.mjs';
import { captureDetail, verifyDetail, MAX_DETAIL_BYTES } from '../src/detail.mjs';
import { canonical } from '../src/canonical.mjs';
import { startUi } from '../src/ui/server.mjs';

const bin = join(import.meta.dirname, '..', 'bin', 'attesso.mjs');

function fixture() {
  const dir = join(mkdtempSync(join(tmpdir(), 'attesso-states-')), 'ledger');
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

test('a failed detail capture is recorded as unavailable, not as no detail', async () => {
  const dir = fixture();
  const details = paths(dir).details;
  writeFileSync(details, 'not a directory');
  const entry = append(dir, {
    action: 'tool.call',
    subject: 'terminal',
    task: 'unavailable',
    capability: 'execute',
    detail_input: { command: 'echo cannot-capture' },
  });
  assert.equal(typeof entry.detail_hash, 'undefined');
  assert.equal(entry.meta?.detail, 'unavailable');
  const detail = cli(dir, 'detail', String(entry.seq), '--json');
  assert.equal(detail.status, 2);
  const parsed = JSON.parse(detail.stdout);
  assert.equal(parsed.state, 'unavailable');
  const ui = await startUi({ dir, home: dir, port: 0, open: false });
  try {
    const response = await fetch(`${ui.url}api/v1/detail?seq=${entry.seq}`, { headers: { 'x-bounds-token': ui.token } });
    assert.equal((await response.json()).state, 'unavailable');
  } finally {
    await ui.close();
  }
});

test('a multibyte command at the cap is truncated by bytes, not dropped', () => {
  const result = captureDetail({
    seq: 1,
    at: new Date().toISOString(),
    action: 'tool.call',
    tool: 'terminal',
    input: { command: '漢'.repeat(1200) },
  });
  assert.ok(Buffer.byteLength(canonical(result.detail)) <= MAX_DETAIL_BYTES);
  assert.equal(result.detail.fields.command.length > 0, true);
  assert.equal(result.detail.truncated.fields, true);
  const dir = fixture();
  const entry = append(dir, {
    action: 'tool.call',
    subject: 'terminal',
    task: 'cjk',
    capability: 'execute',
    detail_input: { command: '漢'.repeat(1200) },
  });
  assert.equal(typeof entry.detail_hash, 'string');
  assert.equal(verifyDetail(entry, readDetail(dir, entry.seq)).ok, true);
});

test('verify --details exits 2 when a preview changed', () => {
  const dir = fixture();
  const entry = append(dir, {
    action: 'tool.call',
    subject: 'terminal',
    task: 'changed',
    capability: 'execute',
    detail_input: { command: 'echo changed' },
  });
  const file = join(paths(dir).details, `${entry.seq}.json`);
  const detail = JSON.parse(readFileSync(file, 'utf8'));
  detail.summary = 'tampered';
  writeFileSync(file, JSON.stringify(detail, null, 2));
  const verify = cli(dir, 'verify', '--details');
  assert.equal(verify.status, 2, verify.stderr);
  assert.match(verify.stdout, /1 changed/);
});

test('detail --json names every state', () => {
  const dir = fixture();
  const none = append(dir, { action: 'log', subject: 'none', task: 'states' });
  const noneResult = cli(dir, 'detail', String(none.seq), '--json');
  assert.equal(noneResult.status, 0);
  assert.equal(JSON.parse(noneResult.stdout).state, 'none');

  const verified = append(dir, {
    action: 'tool.call',
    subject: 'terminal',
    task: 'states',
    capability: 'execute',
    detail_input: { command: 'echo verified' },
  });
  const verifiedResult = cli(dir, 'detail', String(verified.seq), '--json');
  assert.equal(verifiedResult.status, 0);
  assert.equal(JSON.parse(verifiedResult.stdout).state, 'verified');

  const missing = append(dir, {
    action: 'tool.call',
    subject: 'terminal',
    task: 'states',
    capability: 'execute',
    detail_input: { command: 'echo missing' },
  });
  unlinkSync(join(paths(dir).details, `${missing.seq}.json`));
  const missingResult = cli(dir, 'detail', String(missing.seq), '--json');
  assert.equal(JSON.parse(missingResult.stdout).state, 'missing');
  assert.equal(missingResult.status, 2);
});
