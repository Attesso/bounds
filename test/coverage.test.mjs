import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { append, appendUsage, init, paths, readKey } from '../src/store.mjs';
import { rowDigest, gapsBetween, readLedgerHead } from '../src/coverage.mjs';
import { endRun, startRun } from '../src/run.mjs';
import { sync } from '../src/sync.mjs';
import { tempDir } from './helpers.mjs';

const respond = async (handler) => {
  const requests = [];
  const { createServer } = await import('node:http');
  const instance = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push(JSON.parse(body));
      response.setHeader('content-type', 'application/json');
      handler(response);
    });
  });
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${instance.address().port}`,
    requests,
    close: () => new Promise((resolve) => instance.close(resolve)),
  };
};

const okResponse = (response) => response.end(JSON.stringify({ accepted: 1, skipped: 0, metered: 1 }));

const checkSignature = (root, statement) => {
  const key = readKey(root);
  const publicKey = createPublicKey(key.public);
  assert.equal(
    verify(null, Buffer.from(statement.signed), publicKey, Buffer.from(statement.sig, 'base64url')),
    true,
    'the statement must verify against the ledger key',
  );
  // The fields are what the signature covers: nothing may be changed after signing.
  assert.deepEqual(JSON.parse(statement.signed), {
    schema: statement.schema,
    from_seq: statement.from_seq,
    to_seq: statement.to_seq,
    ledger_head: statement.ledger_head,
    mode: statement.mode,
    rules_digest: statement.rules_digest,
    hook_present: statement.hook_present,
    cli_version: statement.cli_version,
    mirrored: statement.mirrored,
    excluded_run: statement.excluded_run,
    excluded_usage: statement.excluded_usage,
    digest: statement.digest,
    declared_gaps: statement.declared_gaps,
  });
};

test('sync states the window it mirrored and signs it', async () => {
  const root = tempDir('attesso-coverage');
  init(root);
  append(root, { action: 'tool.call', subject: 'read_file', task: 't1', capability: 'read' });
  append(root, { action: 'tool.call', subject: 'write_file', task: 't1', capability: 'write' });
  const http = await respond(okResponse);
  try {
    await sync({ dir: root, url: http.url, key: 'att_test_key' });
    const { coverage, entries } = http.requests[0];
    assert.equal(coverage.schema, 'attesso.bounds.coverage.v1');
    assert.equal(coverage.from_seq, 1);
    assert.equal(coverage.to_seq, 2);
    assert.equal(coverage.ledger_head, 2);
    assert.equal(coverage.mirrored, entries.length);
    assert.equal(coverage.digest, rowDigest(entries));
    assert.deepEqual(coverage.declared_gaps, []);
    assert.equal(coverage.mode, 'off');
    assert.equal(typeof coverage.hook_present, 'boolean');
    assert.match(coverage.cli_version, /^\d+\.\d+\.\d+$/);
    checkSignature(root, coverage);
  } finally {
    await http.close();
  }
});

test('run markers and usage rows are counted as excluded, not as holes', async () => {
  const root = tempDir('attesso-coverage-exclusions');
  init(root);
  startRun(root, { goal: 'nightly' });
  append(root, { action: 'tool.call', subject: 'read_file', task: 't1', capability: 'read' });
  appendUsage(root, { task: 't1', inputTokens: 10, outputTokens: 5 });
  endRun(root, { outcome: 'success' });
  const http = await respond(okResponse);
  try {
    await sync({ dir: root, url: http.url, key: 'att_test_key' });
    const { coverage, entries } = http.requests[0];
    assert.equal(coverage.mirrored, entries.length);
    assert.equal(coverage.excluded_run, 2);
    assert.equal(coverage.excluded_usage, 1);
    assert.deepEqual(coverage.declared_gaps, []);
    assert.equal(
      coverage.mirrored + coverage.excluded_run + coverage.excluded_usage,
      coverage.to_seq - coverage.from_seq + 1,
    );
    checkSignature(root, coverage);
  } finally {
    await http.close();
  }
});

test('a missing local row is declared instead of quietly vanishing', async () => {
  const root = tempDir('attesso-coverage-hole');
  init(root);
  append(root, { action: 'tool.call', subject: 'one', task: 't1', capability: 'read' });
  append(root, { action: 'tool.call', subject: 'two', task: 't1', capability: 'read' });
  append(root, { action: 'tool.call', subject: 'three', task: 't1', capability: 'read' });
  // Drop the middle entry the way a manual edit or a bad restore would.
  const ledgerPath = paths(root).ledger;
  const lines = readFileSync(ledgerPath, 'utf8').trim().split('\n');
  writeFileSync(ledgerPath, `${lines[0]}\n${lines[2]}\n`);
  const http = await respond(okResponse);
  try {
    await sync({ dir: root, url: http.url, key: 'att_test_key' });
    const { coverage } = http.requests[0];
    assert.deepEqual(coverage.declared_gaps, [{ from: 2, to: 2, reason: 'ledger_gap' }]);
    assert.equal(readLedgerHead(root), 3);
    assert.equal(coverage.ledger_head, 3);
    checkSignature(root, coverage);
  } finally {
    await http.close();
  }
});

test('gapsBetween coalesces runs of missing sequences', () => {
  assert.deepEqual(gapsBetween(1, 5, [1, 4, 5]), [{ from: 2, to: 3, reason: 'ledger_gap' }]);
  assert.deepEqual(gapsBetween(1, 3, [1, 2, 3]), []);
  assert.deepEqual(gapsBetween(1, 4, [2]), [
    { from: 1, to: 1, reason: 'ledger_gap' },
    { from: 3, to: 4, reason: 'ledger_gap' },
  ]);
});
