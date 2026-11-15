import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign as signPayload } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { append, init, paths } from '../src/store.mjs';
import { sync } from '../src/sync.mjs';
import { readAttestations, verifyAttestation } from '../src/coverage.mjs';
import { bin, runCli, tempDir } from './helpers.mjs';

const WINDOW_ID = `bcw_${'a1b2c3d4e5f60718293a4b5c6d'.slice(0, 26)}`;

const server = async (coverage) => {
  const instance = createServer((request, response) => {
    request.on('data', () => {});
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ accepted: 1, skipped: 0, metered: 1, usage: 0, coverage }));
    });
  });
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${instance.address().port}`,
    close: () => new Promise((resolve) => instance.close(resolve)),
  };
};

const fixture = () => {
  const root = tempDir('attesso-attestation');
  init(root);
  append(root, { action: 'tool.call', subject: 'read_file', task: 't1', capability: 'read' });
  return root;
};

test('a returned attestation is stored beside the ledger, private and exact', async () => {
  const root = fixture();
  const envelope = {
    format: 'attesso.bounds.coverage.v1',
    protected: 'eyJhbGciOiJFUzI1NiJ9',
    payload: 'eyJzY2hlbWEiOiJhdHRlc3NvLmJvdW5kcy5jb3ZlcmFnZS52MSJ9',
    signature: 'c2lnbmF0dXJl',
  };
  const http = await server({
    window_id: WINDOW_ID,
    from_seq: 1,
    to_seq: 1,
    state: 'attested',
    row_digest: 'sha256:abcd',
    envelope,
  });
  try {
    const result = await sync({ dir: root, url: http.url, key: 'att_test_key' });
    assert.equal(result.attestation, join(paths(root).attestations, `${WINDOW_ID}.jws`));
    const stored = readFileSync(result.attestation, 'utf8');
    assert.deepEqual(JSON.parse(stored), envelope, 'the exact envelope is what gets written');
    const mode = statSync(result.attestation).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.equal(result.attestation_error, undefined);
  } finally {
    await http.close();
  }
});

test('a window id that is not a window id is refused, and nothing is written', async () => {
  const root = fixture();
  const http = await server({
    window_id: '../../../escape',
    from_seq: 1,
    to_seq: 1,
    state: 'attested',
    row_digest: 'sha256:abcd',
    envelope: { format: 'attesso.bounds.coverage.v1', protected: 'p', payload: 'q', signature: 's' },
  });
  try {
    const result = await sync({ dir: root, url: http.url, key: 'att_test_key' });
    assert.equal(result.attestation, null);
    assert.match(result.attestation_error, /invalid window id/);
    assert.equal(existsSync(join(root, 'escape.jws')), false);
    assert.equal(existsSync(join(root, '..', 'escape.jws')), false);
  } finally {
    await http.close();
  }
});

test('a sync without an envelope still succeeds and writes no file', async () => {
  const root = fixture();
  const http = await server({
    window_id: WINDOW_ID,
    from_seq: 1,
    to_seq: 1,
    state: 'unattested',
    row_digest: 'sha256:abcd',
  });
  try {
    const result = await sync({ dir: root, url: http.url, key: 'att_test_key' });
    assert.equal(result.attestation, null);
    assert.equal(result.attestation_error, undefined);
    assert.equal(existsSync(paths(root).attestations), false);
  } finally {
    await http.close();
  }
});

const signedEnvelope = (payload) => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'att-key' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = signPayload('sha256', Buffer.from(`${header}.${body}`), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'att-key', alg: 'ES256', use: 'sig' };
  return {
    envelope: { format: 'attesso.bounds.coverage.v1', protected: header, payload: body, signature },
    jwks: { keys: [jwk] },
  };
};

const attestationPayload = {
  schema: 'attesso.bounds.coverage.v1',
  window_id: WINDOW_ID,
  from_seq: 1,
  to_seq: 2,
  state: 'attested',
  mode: 'enforce',
  rules_digest: 'sha256:rules',
  row_digest: 'sha256:rows',
  received_at: '2026-11-14T00:00:00Z',
};

test('a stored attestation verifies against the published keys, and a tampered one does not', () => {
  const { envelope, jwks } = signedEnvelope(attestationPayload);
  const verified = verifyAttestation(envelope, jwks);
  assert.equal(verified.kid, 'att-key');
  assert.equal(verified.payload.window_id, WINDOW_ID);

  const tampered = { ...envelope, payload: Buffer.from(JSON.stringify({ ...attestationPayload, to_seq: 3 })).toString('base64url') };
  assert.throws(() => verifyAttestation(tampered, jwks), /did not verify/);
  assert.throws(() => verifyAttestation(envelope, { keys: [] }), /no ES256 verification key/);
});

test('attesso coverage reports each stored window and refuses one that does not verify', () => {
  const root = fixture();
  const { envelope, jwks } = signedEnvelope(attestationPayload);
  const folder = paths(root).attestations;
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(join(folder, `${WINDOW_ID}.jws`), `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  const jwksFile = join(root, 'jwks.json');
  writeFileSync(jwksFile, JSON.stringify(jwks));

  assert.equal(readAttestations(root).length, 1);
  const good = runCli(root, 'coverage', '--jwks', jwksFile);
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, new RegExp(`${WINDOW_ID} 1-2 attested verified att-key`));

  writeFileSync(join(folder, `${WINDOW_ID}.jws`), `${JSON.stringify({ ...envelope, signature: 'AAAA' })}\n`);
  const bad = runCli(root, 'coverage', '--jwks', jwksFile);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /REFUSED: attestation signature did not verify/);
});
