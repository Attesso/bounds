// Hosted policy distribution: fetch a signed rule bundle, verify it against the
// published Attesso JWKS, and only then let the local engine write rules.json.
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { paths } from './store.mjs';
import { validateRules } from './rules.mjs';

export const POLICY_FORMAT = 'attesso.bounds.policy.v1';

const fromB64url = (value) => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized + '='.repeat((4 - (normalized.length % 4)) % 4), 'base64');
};

export function policyEndpoint(base) {
  const parsed = new URL(base);
  if (parsed.protocol !== 'https:' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('policy url must use HTTPS, except on localhost');
  }
  const path = parsed.pathname.replace(/\/+$/, '').replace(/\/v1\/bounds\/(sync|policy)$/, '');
  parsed.pathname = `${path}/v1/bounds/policy`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

export function jwksEndpoint(base) {
  return new URL('/.well-known/jwks.json', new URL(base)).toString();
}

export async function pullPolicy({
  dir,
  url,
  key,
  apply = false,
  fetchImpl = fetch,
} = {}) {
  if (!url) throw new Error('policy url is required');
  if (!key) throw new Error('policy API key is required');
  const response = await fetchImpl(policyEndpoint(url), {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404) throw new Error('no hosted policy is published');
  if (!response.ok) throw new Error(`policy fetch failed with status ${response.status}`);
  let bundle;
  try {
    bundle = await response.json();
  } catch {
    throw new Error('policy response is invalid');
  }
  if (!bundle || typeof bundle !== 'object' || !bundle.envelope || typeof bundle.envelope !== 'object') {
    throw new Error('policy response is missing its signature');
  }
  if (bundle.envelope.format !== POLICY_FORMAT) {
    throw new Error('policy response has an unexpected format');
  }

  const jwksResponse = await fetchImpl(jwksEndpoint(url), { signal: AbortSignal.timeout(20_000) });
  if (!jwksResponse.ok) throw new Error(`policy key fetch failed with status ${jwksResponse.status}`);
  let jwks;
  try {
    jwks = await jwksResponse.json();
  } catch {
    throw new Error('policy key response is invalid');
  }

  const verified = verifyPolicyEnvelope(bundle.envelope, jwks);
  const changed = !existsSync(paths(dir).rules) ||
    JSON.stringify(JSON.parse(readFileSync(paths(dir).rules, 'utf8'))) !== JSON.stringify(verified.rules);
  if (apply) writeRules(dir, verified.rules);
  return {
    version: verified.version,
    kid: verified.kid,
    digest: verified.digest,
    applied: apply,
    changed,
    rules: verified.rules,
  };
}

export function verifyPolicyEnvelope(envelope, jwks) {
  if (!envelope || typeof envelope !== 'object') throw new Error('policy envelope is invalid');
  if (envelope.format !== POLICY_FORMAT) throw new Error('policy envelope has an unexpected format');
  for (const field of ['protected', 'payload', 'signature']) {
    if (typeof envelope[field] !== 'string' || envelope[field] === '') {
      throw new Error('policy envelope is incomplete');
    }
  }
  let header;
  try {
    header = JSON.parse(fromB64url(envelope.protected).toString('utf8'));
  } catch {
    throw new Error('policy envelope header is invalid');
  }
  if (header.alg !== 'ES256' || typeof header.kid !== 'string') {
    throw new Error('policy envelope must use an ES256 key');
  }
  const key = Array.isArray(jwks?.keys) ? jwks.keys.find((item) => item.kid === header.kid) : undefined;
  if (!key || key.kty !== 'EC' || key.crv !== 'P-256' || key.alg !== 'ES256') {
    throw new Error(`no ES256 verification key for ${header.kid}`);
  }
  let publicKey;
  try {
    publicKey = createPublicKey({ key: { kty: key.kty, crv: key.crv, x: key.x, y: key.y }, format: 'jwk' });
  } catch {
    throw new Error(`verification key ${header.kid} is invalid`);
  }
  const valid = verifySignature(
    'sha256',
    Buffer.from(`${envelope.protected}.${envelope.payload}`, 'utf8'),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    fromB64url(envelope.signature),
  );
  if (!valid) throw new Error('policy signature did not verify');

  let payload;
  try {
    payload = JSON.parse(fromB64url(envelope.payload).toString('utf8'));
  } catch {
    throw new Error('policy payload is invalid');
  }
  if (payload.schema !== POLICY_FORMAT ||
      !Number.isSafeInteger(payload.version) || payload.version < 1 ||
      typeof payload.rules !== 'object' || payload.rules === null) {
    throw new Error('policy payload is invalid');
  }
  const rules = validateRules(payload.rules);
  return {
    version: payload.version,
    rules,
    kid: header.kid,
    digest: `sha256:${createHash('sha256').update(envelope.payload).digest('hex')}`,
  };
}

function writeRules(dir, rules) {
  const file = paths(dir).rules;
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(rules, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}
