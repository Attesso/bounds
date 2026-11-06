// The ledger itself: one signed entry per proposed action, chained so an edit
// breaks every later entry. Ed25519 keys generated on first use; the private key
// stays in the project directory, which is why a local log proves integrity and
// not authority.
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { canonical } from './canonical.mjs';

export const ENTRY_VERSION = 1;
export const RUN_ACTIONS = new Set(['run.start', 'run.end']);
export const isRunAction = (entry) => RUN_ACTIONS.has(entry?.action);

export function newSigningKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    kid: keyId(publicKey.export({ format: 'jwk' })),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

// RFC 7638 style thumbprint: the members that identify an Ed25519 key, sorted.
export function keyId(publicJwk) {
  const thumbprint = canonical({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x });
  return createHash('sha256').update(thumbprint).digest('base64url').slice(0, 16);
}

export function entryHash(entry) {
  return createHash('sha256').update(canonical(entry)).digest('base64url');
}

function signingPayload(entry) {
  const { sig, ...rest } = entry;
  return Buffer.from(canonical(rest));
}

export function signEntry(entry, privatePem) {
  return sign(null, signingPayload(entry), privatePem).toString('base64url');
}

export function verifyEntry(entry, publicPem) {
  if (!entry || typeof entry.sig !== 'string' || entry.sig === '') return false;
  try {
    return verify(null, signingPayload(entry), publicPem, Buffer.from(entry.sig, 'base64url'));
  } catch {
    return false;
  }
}

export function buildEntry({
  seq,
  prev,
  action,
  subject,
  amount,
  meta,
  task,
  runId,
  trust,
  capability,
  decision,
  code,
  rule,
  taintedBy,
  enforce,
  argsHash,
  detailHash,
  policyDigest,
  rulesDigest,
  toolsDigest,
  toolHash,
  toolPin,
  mcpDigest,
  control,
  kid,
  at,
}) {
  const entry = {
    v: ENTRY_VERSION,
    seq,
    at: at ?? new Date().toISOString(),
    action,
    subject: subject ?? null,
    decision,
    code,
    policy_digest: policyDigest,
    kid,
    prev,
  };
  if (amount) entry.amount = amount;
  if (task) entry.task = task;
  if (runId) entry.run_id = runId;
  if (trust) entry.trust = trust;
  if (capability) entry.capability = capability;
  if (rule) entry.rule = rule;
  if (taintedBy !== undefined) entry.tainted_by = taintedBy;
  if (enforce === true) entry.enforce = true;
  if (argsHash) entry.args_hash = argsHash;
  if (detailHash) entry.detail_hash = detailHash;
  if (rulesDigest) entry.rules_digest = rulesDigest;
  if (toolsDigest) entry.tools_digest = toolsDigest;
  if (toolHash) entry.tool_hash = toolHash;
  if (toolPin) entry.tool_pin = toolPin;
  if (mcpDigest) entry.mcp_digest = mcpDigest;
  if (control) entry.control = control;
  if (meta && Object.keys(meta).length > 0) entry.meta = meta;
  return entry;
}

// Returns the first defect rather than a boolean, so a reader learns which entry
// to look at. `head` comes from config, which is what makes truncation visible.
export function verifyHead(count, hash, head) {
  if (!head) return { ok: false, reason: 'no recorded head, so the end of the log cannot be checked' };
  if (head.count !== count) {
    if (head.count < count) {
      const extra = count - head.count;
      const noun = extra === 1 ? 'entry' : 'entries';
      return {
        ok: false,
        reason: `the log holds ${extra} more ${noun} than the recorded head; an interrupted append left them, and the next append repairs the head`,
      };
    }
    return { ok: false, reason: `config records ${head.count} entries, the log holds ${count}` };
  }
  if (head.hash !== hash) {
    return { ok: false, reason: 'the last entry does not match the recorded head' };
  }
  return { ok: true, reason: `chain of ${count} entries verifies` };
}

export function verifyStep(entry, index, previous, publicPem) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, reason: `entry ${index + 1} is not an object` };
  }
  if (entry.seq !== index + 1) {
    return { ok: false, reason: `entry ${index + 1} carries seq ${entry.seq}` };
  }
  if (entry.prev !== previous) {
    return { ok: false, reason: `entry ${entry.seq} does not chain to the entry before it` };
  }
  if (!verifyEntry(entry, publicPem)) {
    return { ok: false, reason: `entry ${entry.seq} signature does not verify` };
  }
  return { ok: true, hash: entryHash(entry) };
}

export function verifyChain(entries, publicPem, head) {
  let previous = 'genesis';
  for (const [index, entry] of entries.entries()) {
    const step = verifyStep(entry, index, previous, publicPem);
    // Report the scope, not just the verdict: the entries before a broken one
    // still verify, and that is the difference between a lost record and a
    // damaged one.
    if (!step.ok) return { ...step, verified: index };
    previous = step.hash;
  }
  return verifyHead(entries.length, previous, head);
}
