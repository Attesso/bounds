import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { append, init, readDetail } from '../src/store.mjs';
import { captureDetail, detailHash, MAX_DETAIL_BYTES } from '../src/detail.mjs';
import { startUi } from '../src/ui/server.mjs';

function fixture() {
  const dir = join(mkdtempSync(join(tmpdir(), 'attesso-contract-')), 'ledger');
  init(dir);
  return dir;
}

test('the detail timestamp is the entry timestamp', () => {
  const dir = fixture();
  const entry = append(dir, {
    action: 'tool.call',
    subject: 'terminal',
    task: 'contract',
    capability: 'execute',
    detail_input: { command: 'echo at' },
  });
  assert.equal(readDetail(dir, entry.seq).at, entry.at);
});

test('the detail hash is stable across object key order', () => {
  const input = {
    seq: 1,
    at: '2026-11-05T00:00:00.000Z',
    action: 'tool.call',
    tool: 'terminal',
    input: { command: 'echo order' },
  };
  const first = captureDetail(input);
  const second = captureDetail(input);
  assert.equal(first.hash, second.hash);
  const reordered = {
    truncated: { ...first.detail.truncated },
    fields: Object.fromEntries(Object.entries(first.detail.fields).reverse()),
    redactions: first.detail.redactions,
    summary: first.detail.summary,
    tool: first.detail.tool,
    action: first.detail.action,
    at: first.detail.at,
    seq: first.detail.seq,
    version: first.detail.version,
  };
  assert.equal(detailHash(reordered), first.hash);
});

test('twenty concurrent details get twenty distinct hashes', async () => {
  const dir = fixture();
  const entries = await Promise.all(
    Array.from({ length: 20 }, (_, index) => Promise.resolve().then(() => append(dir, {
      action: 'tool.call',
      subject: 'terminal',
      task: 'contract',
      capability: 'execute',
      detail_input: { command: `echo ${index}` },
    }))),
  );
  assert.equal(new Set(entries.map((entry) => entry.detail_hash)).size, 20);
  for (const entry of entries) assert.equal(readDetail(dir, entry.seq).seq, entry.seq);
});

test('one thousand details stay under the cap and average small', () => {
  const sizes = [];
  for (let index = 0; index < 1000; index += 1) {
    const { detail } = captureDetail({
      seq: index + 1,
      at: new Date().toISOString(),
      action: 'tool.call',
      tool: 'terminal',
      input: { command: `echo ${index}` },
    });
    sizes.push(Buffer.byteLength(JSON.stringify(detail, null, 2)));
  }
  const average = sizes.reduce((sum, size) => sum + size, 0) / sizes.length;
  assert.ok(Math.max(...sizes) <= MAX_DETAIL_BYTES);
  assert.ok(average < 1024, `average ${average}`);
});

test('the call list never carries the detail', async () => {
  const dir = fixture();
  append(dir, {
    action: 'tool.call',
    subject: 'terminal',
    task: 'contract',
    capability: 'execute',
    detail_input: { command: 'echo list-secret-marker' },
  });
  const ui = await startUi({ dir, home: dir, port: 0, open: false });
  try {
    const response = await fetch(`${ui.url}api/v1/calls`, { headers: { 'x-bounds-token': ui.token } });
    const text = await response.text();
    assert.equal(text.includes('list-secret-marker'), false);
  } finally {
    await ui.close();
  }
});
