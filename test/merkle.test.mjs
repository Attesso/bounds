import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { inclusionPath, leafHash, merkleRoot, prefixRoot, verifyInclusion } from '../src/merkle.mjs';

const entry = (seq) => ({ seq, action: 'tool.call', subject: `tool-${seq}` });

function referenceRoot(leaves) {
  if (leaves.length === 0) return createHash('sha256').digest();
  if (leaves.length === 1) return leaves[0];
  const split = 2 ** Math.floor(Math.log2(leaves.length - 1));
  const left = referenceRoot(leaves.slice(0, split));
  const right = referenceRoot(leaves.slice(split));
  return createHash('sha256').update(Buffer.from([1])).update(left).update(right).digest();
}

test('the root matches a recursive RFC 6962 reference at every size', () => {
  for (let size = 0; size <= 129; size += 1) {
    const entries = Array.from({ length: size }, (_, index) => entry(index + 1));
    const leaves = entries.map(leafHash);
    assert.equal(merkleRoot(leaves).equals(referenceRoot(leaves)), true, `size ${size}`);
  }
});

test('an index outside the tree is a range error, not an undefined hash', () => {
  assert.throws(() => inclusionPath([], 0), /inside the tree/);
  assert.throws(() => inclusionPath([leafHash(entry(1))], 1), /inside the tree/);
  assert.throws(() => inclusionPath([leafHash(entry(1))], -1), /inside the tree/);
  assert.throws(() => prefixRoot([], 1), /inside the log/);
  assert.equal(verifyInclusion(leafHash(entry(1)), 0, 1, null, leafHash(entry(1))), false);
});

test('a hash that is not 32 bytes is refused before it is combined', () => {
  const leaf = leafHash(entry(1));
  const empty = Buffer.alloc(0);
  assert.equal(verifyInclusion(empty, 0, 1, [], empty), false);
  assert.equal(verifyInclusion(Buffer.alloc(31), 0, 1, [], leaf), false);
  assert.equal(verifyInclusion(Buffer.alloc(33), 0, 1, [], leaf), false);
  assert.equal(verifyInclusion(leaf, 0, 1, [], empty), false);
  assert.equal(verifyInclusion(leaf, 0, 1, [Buffer.alloc(31)], leaf), false);
});

test('a proof with an extra sibling is refused instead of hashed', () => {
  const entries = Array.from({ length: 4 }, (_, index) => entry(index + 1));
  const leaves = entries.map(leafHash);
  const root = merkleRoot(leaves);
  const path = inclusionPath(leaves, 1);
  assert.equal(verifyInclusion(leaves[1], 1, 4, path, root), true);
  assert.equal(verifyInclusion(leaves[1], 1, 4, [...path, leaves[0]], root), false);
});

test('one leaf is its own root, and every index of every size proves', () => {
  for (let size = 1; size <= 64; size += 1) {
    const entries = Array.from({ length: size }, (_, index) => entry(index + 1));
    const leaves = entries.map(leafHash);
    const root = merkleRoot(leaves);
    assert.equal(prefixRoot(entries, size).equals(root), true);
    for (let index = 0; index < size; index += 1) {
      const proof = inclusionPath(leaves, index);
      assert.equal(verifyInclusion(leaves[index], index, size, proof, root), true, `size ${size} index ${index}`);
    }
  }
  for (const size of [65, 127, 128, 129, 256]) {
    const entries = Array.from({ length: size }, (_, index) => entry(index + 1));
    const leaves = entries.map(leafHash);
    const root = merkleRoot(leaves);
    for (let index = 0; index < size; index += 1) {
      assert.equal(
        verifyInclusion(leaves[index], index, size, inclusionPath(leaves, index), root),
        true,
        `size ${size} index ${index}`,
      );
    }
  }
});

test('an empty tree has the RFC 6962 empty root', () => {
  const empty = createHash('sha256').digest();
  assert.equal(merkleRoot([]).equals(empty), true);
  assert.equal(prefixRoot([], 0).equals(empty), true);
  assert.equal(verifyInclusion(leafHash(entry(1)), 0, 0, [], empty), false);
});

test('two identical entries occupy two positions, not one', () => {
  const leaves = [leafHash(entry(1)), leafHash(entry(1))];
  const root = merkleRoot(leaves);
  assert.equal(root.equals(leaves[0]), false);
  for (let index = 0; index < 2; index += 1) {
    assert.equal(verifyInclusion(leaves[index], index, 2, inclusionPath(leaves, index), root), true);
  }
});

test('a tampered leaf fails its own proof and nobody else changes', () => {
  const entries = Array.from({ length: 9 }, (_, index) => entry(index + 1));
  const leaves = entries.map(leafHash);
  const root = merkleRoot(leaves);
  const proof = inclusionPath(leaves, 4);
  const tampered = Buffer.from(leaves[4]);
  tampered[0] ^= 0xff;
  assert.equal(verifyInclusion(tampered, 4, 9, proof, root), false);
  assert.equal(verifyInclusion(leaves[3], 4, 9, proof, root), false);
});

test('a proof does not verify at another index or another size', () => {
  const leaves = Array.from({ length: 8 }, (_, index) => leafHash(entry(index + 1)));
  const root = merkleRoot(leaves);
  const proof = inclusionPath(leaves, 3);
  assert.equal(verifyInclusion(leaves[3], 2, 8, proof, root), false);
  assert.equal(verifyInclusion(leaves[3], 3, 7, inclusionPath(leaves.slice(0, 7), 3), root), false);
});

test('a prefix root of the same entries is stable and size-bound', () => {
  const entries = Array.from({ length: 6 }, (_, index) => entry(index + 1));
  assert.equal(prefixRoot(entries, 3).equals(merkleRoot(entries.slice(0, 3).map(leafHash))), true);
  assert.equal(prefixRoot(entries, 3).equals(prefixRoot(entries, 4)), false);
});
