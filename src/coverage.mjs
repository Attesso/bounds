// A coverage statement is the device's own account of one sync window: the
// range it mirrored, what it never uploads by design, the mode and rules it ran
// under, and a digest over the exact rows. It is signed with the ledger key, so
// the server can check the claim against rows the device signed too.
import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { canonical } from './canonical.mjs';
import { readMode, status } from './connect.mjs';
import { rulesDigest } from './rules.mjs';
import { paths, readKey } from './store.mjs';
import { ENGINE_VERSION } from './version.mjs';

export const COVERAGE_SCHEMA = 'attesso.bounds.coverage.v1';
export const LEDGER_GAP = 'ledger_gap';
const TAIL_BYTES = 64 * 1024;

export const rowDigest = (entries) => {
  const hash = createHash('sha256');
  for (const entry of [...entries].sort((left, right) => left.seq - right.seq)) {
    hash.update(`${entry.seq}:${entry.entry_hash}\n`);
  }
  return `sha256:${hash.digest('hex')}`;
};

// readLedgerHead returns the last recorded sequence without reading the whole
// ledger. A partial final line is a writer caught mid-append and is skipped.
export function readLedgerHead(dir) {
  const file = paths(dir).ledger;
  if (!existsSync(file)) return 0;
  const size = statSync(file).size;
  if (size === 0) return 0;
  const start = Math.max(0, size - TAIL_BYTES);
  const buffer = Buffer.alloc(size - start);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    closeSync(fd);
  }
  const lines = buffer.toString('utf8').split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line === '') continue;
    try {
      const entry = JSON.parse(line);
      if (Number.isSafeInteger(entry.seq) && entry.seq > 0) return entry.seq;
    } catch {
      // Not a complete entry; keep walking back.
    }
  }
  return 0;
}

const rulesDigestOf = (dir) => {
  const file = paths(dir).rules;
  if (!existsSync(file)) return `sha256:${createHash('sha256').update('').digest('hex')}`;
  try {
    return rulesDigest(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return 'unreadable';
  }
};

// gapsBetween returns the ranges inside [from, to] that no row occupies. They
// have to be declared: a window may not quietly omit a sequence number.
export function gapsBetween(from, to, seqs) {
  const seen = new Set(seqs);
  const gaps = [];
  let open = null;
  for (let seq = from; seq <= to; seq += 1) {
    if (seen.has(seq)) {
      if (open !== null) {
        gaps.push(open);
        open = null;
      }
      continue;
    }
    if (open === null) open = { from: seq, to: seq, reason: LEDGER_GAP };
    else open.to = seq;
  }
  if (open !== null) gaps.push(open);
  return gaps;
}

// The window id becomes a filename, so it is checked as strictly as a device id.
const WINDOW_ID = /^bcw_[a-f0-9]{26}$/;

export function writeAttestation(dir, receipt) {
  if (typeof receipt?.window_id !== 'string' || !WINDOW_ID.test(receipt.window_id)) {
    throw new Error('the hosted plane returned an invalid window id');
  }
  if (receipt.envelope === undefined || receipt.envelope === null) {
    return null;
  }
  const folder = paths(dir).attestations;
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = join(folder, `${receipt.window_id}.jws`);
  // The exact envelope bytes, so a verifier checks what Attesso signed.
  writeFileSync(file, `${JSON.stringify(receipt.envelope)}\n`, { mode: 0o600 });
  return file;
}

export function coverageStatement({
  dir,
  fromSeq,
  toSeq,
  entries,
  excludedRun,
  excludedUsage,
  seqs,
  key,
}) {
  const head = readLedgerHead(dir);
  const body = {
    schema: COVERAGE_SCHEMA,
    from_seq: fromSeq,
    to_seq: toSeq,
    ledger_head: Math.max(head, toSeq),
    mode: readMode(dir) ?? 'off',
    rules_digest: rulesDigestOf(dir),
    hook_present: status({ dir }).wired.length > 0,
    cli_version: ENGINE_VERSION,
    mirrored: entries.length,
    excluded_run: excludedRun,
    excluded_usage: excludedUsage,
    digest: rowDigest(entries),
    declared_gaps: gapsBetween(fromSeq, toSeq, seqs),
  };
  const signed = canonical(body);
  return {
    ...body,
    sig: sign(null, Buffer.from(signed), readKey(dir).private).toString('base64url'),
    signed,
  };
}

const fromB64url = (value) => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized + '='.repeat((4 - (normalized.length % 4)) % 4), 'base64');
};

// verifyAttestation checks one stored envelope against a published JWKS. The
// signature is raw r||s over "protected.payload", so P-256 verification needs
// ieee-p1363; DER here would reject every genuine attestation.
export function verifyAttestation(envelope, jwks) {
  if (!envelope || typeof envelope !== 'object') throw new Error('attestation is invalid');
  if (envelope.format !== COVERAGE_SCHEMA) throw new Error('attestation has an unexpected format');
  for (const field of ['protected', 'payload', 'signature']) {
    if (typeof envelope[field] !== 'string' || envelope[field] === '') {
      throw new Error('attestation is incomplete');
    }
  }
  let header;
  try {
    header = JSON.parse(fromB64url(envelope.protected).toString('utf8'));
  } catch {
    throw new Error('attestation header is invalid');
  }
  if (header.alg !== 'ES256' || typeof header.kid !== 'string') {
    throw new Error('attestation must use an ES256 key');
  }
  const key = Array.isArray(jwks?.keys) ? jwks.keys.find((item) => item.kid === header.kid) : undefined;
  if (!key || key.kty !== 'EC' || key.crv !== 'P-256' || key.alg !== 'ES256') {
    throw new Error(`no ES256 verification key for ${header.kid}`);
  }
  const valid = verify(
    'sha256',
    Buffer.from(`${envelope.protected}.${envelope.payload}`, 'utf8'),
    { key: createPublicKey({ key: { kty: key.kty, crv: key.crv, x: key.x, y: key.y }, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
    fromB64url(envelope.signature),
  );
  if (!valid) throw new Error('attestation signature did not verify');
  let payload;
  try {
    payload = JSON.parse(fromB64url(envelope.payload).toString('utf8'));
  } catch {
    throw new Error('attestation payload is invalid');
  }
  if (payload.schema !== COVERAGE_SCHEMA) throw new Error('attestation payload has an unexpected schema');
  return { kid: header.kid, payload };
}

export function readAttestations(dir) {
  const folder = paths(dir).attestations;
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => name.endsWith('.jws'))
    .sort()
    .map((name) => {
      const file = join(folder, name);
      try {
        return { file, envelope: JSON.parse(readFileSync(file, 'utf8')) };
      } catch {
        return { file, envelope: null };
      }
    });
}
