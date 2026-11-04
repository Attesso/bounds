import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { bin } from './helpers.mjs';
import { init } from '../src/store.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = publicKey.export({ format: 'jwk' });

function signedPolicy(rules, version = 3) {
  const protectedValue = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'policy-key' })).toString('base64url');
  const payloadValue = Buffer.from(JSON.stringify({
    schema: 'attesso.bounds.policy.v1',
    version,
    issued_at: '2026-11-03T00:00:00Z',
    rules,
  })).toString('base64url');
  const signature = sign('sha256', Buffer.from(`${protectedValue}.${payloadValue}`), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return {
    format: 'attesso.bounds.policy.v1',
    version,
    rules,
    issued_at: '2026-11-03T00:00:00Z',
    envelope: { format: 'attesso.bounds.policy.v1', protected: protectedValue, payload: payloadValue, signature },
  };
}

test('the policy pull command verifies and applies a hosted bundle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'attesso-policy-cli-'));
  init(dir);
  const rules = { version: 1, rules: [{ id: 'limit', deny: { all: true }, max_steps: 20 }] };
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/.well-known/jwks.json') {
      response.end(JSON.stringify({ keys: [{
        kty: 'EC', crv: 'P-256', use: 'sig', alg: 'ES256', kid: 'policy-key', x: jwk.x, y: jwk.y,
      }] }));
      return;
    }
    if (request.url === '/v1/bounds/policy') {
      response.end(JSON.stringify(signedPolicy(rules)));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const { port } = server.address();
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        bin, '--dir', dir, 'policy', 'pull', '--url', `http://127.0.0.1:${port}`, '--apply', '--json',
      ], {
        env: { ...process.env, ATTESSO_API_KEY: 'att_test_policy' },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.version, 3);
    assert.equal(output.applied, true);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'rules.json'), 'utf8')), rules);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
