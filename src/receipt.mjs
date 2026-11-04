// A receipt is one entry, its path to the root, and a signed checkpoint. It is
// self-contained: a verifier needs the public key, nothing else.
import { sign, verify } from 'node:crypto';
import { canonical } from './canonical.mjs';
import { inclusionPath, leafHash, merkleRoot, prefixRoot, verifyInclusion } from './merkle.mjs';

const encode = (buffer) => buffer.toString('base64url');
const decode = (text) => Buffer.from(text, 'base64url');

// The key file and the signer object carry the same three facts under different
// names; map once so a command never spells the clump out again.
export const signerOf = (key) => ({ kid: key.kid, privatePem: key.private, publicPem: key.public });

export function checkpointFor(entries, { kid, privatePem, at = new Date() }) {
  const body = {
    v: 1,
    origin: `attesso.local/${kid}`,
    size: entries.length,
    root: encode(merkleRoot(entries.map(leafHash))),
    at: at.toISOString(),
  };
  const sig = sign(null, Buffer.from(canonical(body)), privatePem).toString('base64url');
  return { ...body, sig };
}

export function verifyCheckpoint(checkpoint, publicPem) {
  if (!checkpoint || typeof checkpoint.sig !== 'string') return false;
  const { sig, ...body } = checkpoint;
  if (
    body.v !== 1 ||
    typeof body.origin !== 'string' ||
    !Number.isInteger(body.size) ||
    typeof body.root !== 'string' ||
    body.root === ''
  ) {
    return false;
  }
  return verify(null, Buffer.from(canonical(body)), publicPem, Buffer.from(sig, 'base64url'));
}

export function receiptFor(entries, index, { kid, privatePem, publicPem }) {
  const entry = entries[index];
  if (!entry) throw new Error(`no entry at index ${index}`);
  const leaves = entries.map(leafHash);
  return {
    v: 1,
    entry,
    leaf_index: index,
    tree_size: entries.length,
    path: inclusionPath(leaves, index).map(encode),
    checkpoint: checkpointFor(entries, { kid, privatePem }),
    key: publicPem,
  };
}

export function verifyReceipt(receipt, publicPem) {
  if (!receipt || receipt.v !== 1 || !receipt.entry || !Array.isArray(receipt.path)) {
    return { ok: false, reason: 'receipt is not version 1' };
  }
  if (!Number.isInteger(receipt.leaf_index) || !Number.isInteger(receipt.tree_size) || receipt.tree_size < 1) {
    return { ok: false, reason: 'receipt has no integer index and tree size' };
  }
  if (!receipt.path.every((hash) => typeof hash === 'string' && hash !== '')) {
    return { ok: false, reason: 'receipt path is not a list of hashes' };
  }
  if (receipt.entry.seq !== receipt.leaf_index + 1) {
    return { ok: false, reason: 'leaf index does not match the entry sequence' };
  }
  const key = publicPem ?? receipt.key;
  if (!verifyCheckpoint(receipt.checkpoint, key)) {
    return { ok: false, reason: 'checkpoint signature does not verify' };
  }
  if (receipt.checkpoint.size !== receipt.tree_size) {
    return { ok: false, reason: 'checkpoint size does not match the receipt' };
  }
  const ok = verifyInclusion(
    leafHash(receipt.entry),
    receipt.leaf_index,
    receipt.tree_size,
    receipt.path.map(decode),
    decode(receipt.checkpoint.root),
  );
  return ok
    ? { ok: true, reason: `entry #${receipt.entry.seq} is in the tree of ${receipt.tree_size}` }
    : { ok: false, reason: 'the entry is not in the tree its proof names' };
}

// The pin is the only thing an attacker with the key cannot re-derive. It is
// checked against the local log, so the log must be present.
export function verifyPinned(entries, checkpoint, publicPem) {
  if (!verifyCheckpoint(checkpoint, publicPem)) {
    return { ok: false, reason: 'pinned checkpoint signature does not verify' };
  }
  if (!Number.isInteger(checkpoint.size) || checkpoint.size < 0) {
    return { ok: false, reason: 'pinned checkpoint has no size' };
  }
  if (entries.length < checkpoint.size) {
    return { ok: false, reason: `the log holds ${entries.length} entries, fewer than the pinned ${checkpoint.size}` };
  }
  if (!prefixRoot(entries, checkpoint.size).equals(decode(checkpoint.root))) {
    return { ok: false, reason: 'the log was rewritten below the pinned head' };
  }
  return { ok: true, reason: `log extends the pinned head at ${checkpoint.size} entries` };
}
