import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { init } from '../src/store.mjs';
import {
  POLICY_FORMAT,
  policyEndpoint,
  pullPolicy,
  verifyPolicyEnvelope,
} from '../src/remote-policy.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = publicKey.export({ format: 'jwk' });

function bundle({ kid = 'policy-key', rules, version = 3, tamper = false } = {}) {
  const protectedValue = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid })).toString('base64url');
  const payloadValue = Buffer.from(JSON.stringify({
    schema: POLICY_FORMAT,
    version,
    issued_at: '2026-11-03T00:00:00Z',
    rules,
  })).toString('base64url');
  const signature = sign('sha256', Buffer.from(`${protectedValue}.${payloadValue}`), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return {
    format: POLICY_FORMAT,
    version,
    rules,
    issued_at: '2026-11-03T00:00:00Z',
    envelope: {
      format: POLICY_FORMAT,
      protected: protectedValue,
      payload: payloadValue,
      signature: tamper ? `${signature.slice(0, -2)}AA` : signature,
    },
  };
}

const jwks = {
  keys: [{
    kty: 'EC',
    crv: 'P-256',
    use: 'sig',
    alg: 'ES256',
    kid: 'policy-key',
    x: jwk.x,
    y: jwk.y,
  }],
};

const rules = {
  version: 1,
  rules: [{ id: 'strict', deny: { all: true }, max_steps: 20 }],
};

function fakeFetch({ policy = bundle({ rules }), keys = jwks, policyStatus = 200, jwksStatus = 200 } = {}) {
  return async (url) => {
    if (url.endsWith('/.well-known/jwks.json')) {
      return new Response(JSON.stringify(keys), { status: jwksStatus, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/v1/bounds/policy')) {
      return new Response(JSON.stringify(policy), { status: policyStatus, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`unexpected URL ${url}`);
  };
}

test('the policy endpoint normalizes a base URL', () => {
  assert.equal(policyEndpoint('https://api.attesso.com'), 'https://api.attesso.com/v1/bounds/policy');
  assert.equal(policyEndpoint('https://api.attesso.com/v1/bounds/sync'), 'https://api.attesso.com/v1/bounds/policy');
  assert.throws(() => policyEndpoint('http://api.example.com'), /HTTPS/);
});

test('a signed bundle previews without writing rules', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'attesso-policy-preview-'));
  init(dir);
  const before = readFileSync(join(dir, 'rules.json'), 'utf8');
  const result = await pullPolicy({
    dir,
    url: 'https://api.attesso.com',
    key: 'att_test',
    fetchImpl: fakeFetch(),
  });
  assert.equal(result.version, 3);
  assert.equal(result.changed, true);
  assert.equal(result.applied, false);
  assert.equal(result.digest, `sha256:${createHash('sha256').update(bundle({ rules }).envelope.payload).digest('hex')}`);
  assert.equal(readFileSync(join(dir, 'rules.json'), 'utf8'), before);
});

test('--apply writes the verified rules atomically', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'attesso-policy-apply-'));
  init(dir);
  const result = await pullPolicy({
    dir,
    url: 'https://api.attesso.com',
    key: 'att_test',
    apply: true,
    fetchImpl: fakeFetch(),
  });
  assert.equal(result.applied, true);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'rules.json'), 'utf8')), rules);
});

test('a tampered signature is refused before anything is written', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'attesso-policy-tamper-'));
  init(dir);
  const before = readFileSync(join(dir, 'rules.json'), 'utf8');
  await assert.rejects(
    pullPolicy({
      dir,
      url: 'https://api.attesso.com',
      key: 'att_test',
      apply: true,
      fetchImpl: fakeFetch({ policy: bundle({ rules, tamper: true }) }),
    }),
    /signature did not verify/,
  );
  assert.equal(readFileSync(join(dir, 'rules.json'), 'utf8'), before);
});

test('a missing hosted policy is a clear refusal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'attesso-policy-missing-'));
  init(dir);
  await assert.rejects(
    pullPolicy({
      dir,
      url: 'https://api.attesso.com',
      key: 'att_test',
      fetchImpl: fakeFetch({ policyStatus: 404 }),
    }),
    /no hosted policy is published/,
  );
});

test('an unknown signing key is refused', () => {
  assert.throws(
    () => verifyPolicyEnvelope(bundle({ rules }).envelope, { keys: [] }),
    /no ES256 verification key/,
  );
});
