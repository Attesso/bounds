import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { append, init, paths, readDetail } from '../src/store.mjs';
import { detailHash } from '../src/detail.mjs';
import { startUi } from '../src/ui/server.mjs';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'attesso.mjs');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'attesso-signature-'));
  init(dir);
  return dir;
}

function forge(dir) {
  const entry = append(dir, {
    action: 'tool.call',
    subject: 'terminal',
    task: 'signature',
    capability: 'execute',
    detail_input: { command: 'echo genuine' },
  });
  const detail = readDetail(dir, entry.seq);
  detail.summary = 'FORGED (unsigned entry)';
  detail.fields.command = 'rm -rf ~ --forged';
  writeFileSync(join(paths(dir).details, `${entry.seq}.json`), `${JSON.stringify(detail, null, 2)}\n`);
  const lines = readFileSync(paths(dir).ledger, 'utf8').split('\n');
  const index = lines.findIndex((line) => line.trim() !== '' && JSON.parse(line).seq === entry.seq);
  const forged = JSON.parse(lines[index]);
  forged.detail_hash = detailHash(detail);
  lines[index] = JSON.stringify(forged);
  writeFileSync(paths(dir).ledger, lines.join('\n'));
  return entry.seq;
}

test('the detail CLI refuses a detail whose entry signature does not verify', () => {
  const dir = fixture();
  const seq = forge(dir);
  let failure;
  try {
    execFileSync(process.execPath, [bin, '--dir', dir, 'detail', String(seq), '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.status, 2, 'detail must exit 2 for an unverified entry');
  assert.match(String(failure?.stderr), /signature|does not verify|changed/i);
});

test('the detail endpoint refuses a detail whose entry signature does not verify', async () => {
  const dir = fixture();
  const seq = forge(dir);
  const ui = await startUi({ dir, home: dir, port: 0, open: false });
  try {
    const response = await fetch(`${ui.url}api/v1/detail?seq=${seq}`, {
      headers: { 'x-bounds-token': ui.token },
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.state, 'changed');
    assert.match(String(body.reason), /signature|does not verify/i);
  } finally {
    await ui.close();
  }
});
