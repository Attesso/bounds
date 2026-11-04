// RFC 6962 Merkle tree over the canonical entry bytes. The chain already proves
// order; this proves one entry without shipping the whole log.
import { createHash } from 'node:crypto';
import { canonical } from './canonical.mjs';

const LEAF = Buffer.from([0]);
const NODE = Buffer.from([1]);

export function leafHash(entry) {
  return createHash('sha256').update(LEAF).update(canonical(entry)).digest();
}

function nodeHash(left, right) {
  return createHash('sha256').update(NODE).update(left).update(right).digest();
}

function levelsOf(leaves) {
  if (leaves.length === 0) return [];
  const levels = [leaves.map((leaf) => Buffer.from(leaf))];
  while (levels[levels.length - 1].length > 1) {
    const below = levels[levels.length - 1];
    const next = [];
    for (let index = 0; index < below.length; index += 2) {
      next.push(index + 1 < below.length ? nodeHash(below[index], below[index + 1]) : below[index]);
    }
    levels.push(next);
  }
  return levels;
}

export function merkleRoot(leaves) {
  if (leaves.length === 0) return createHash('sha256').digest();
  const levels = levelsOf(leaves);
  return levels[levels.length - 1][0];
}

export function inclusionPath(leaves, index) {
  if (!Array.isArray(leaves) || !Number.isInteger(index) || index < 0 || index >= leaves.length) {
    throw new RangeError('inclusionPath needs an index inside the tree');
  }
  const levels = levelsOf(leaves);
  const path = [];
  let at = index;
  for (let level = 0; level < levels.length - 1; level += 1) {
    const row = levels[level];
    const sibling = at % 2 === 0 ? at + 1 : at - 1;
    if (sibling < row.length) path.push(row[sibling]);
    at = Math.floor(at / 2);
  }
  return path;
}

export function verifyInclusion(leaf, index, size, path, root) {
  if (!Number.isInteger(index) || index < 0 || index >= size || !Array.isArray(path)) return false;
  if (!Buffer.isBuffer(leaf) || leaf.length !== 32) return false;
  if (!Buffer.isBuffer(root) || root.length !== 32) return false;
  if (!path.every((hash) => Buffer.isBuffer(hash) && hash.length === 32)) return false;
  let fn = index;
  let sn = size - 1;
  let hash = leaf;
  for (const sibling of path) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      hash = nodeHash(sibling, hash);
      while (fn % 2 === 0 && fn !== 0) {
        fn = Math.floor(fn / 2);
        sn = Math.floor(sn / 2);
      }
    } else {
      hash = nodeHash(hash, sibling);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && hash.equals(root);
}

export function prefixRoot(entries, size) {
  if (!Array.isArray(entries) || !Number.isInteger(size) || size < 0 || size > entries.length) {
    throw new RangeError('prefixRoot needs a size inside the log');
  }
  return merkleRoot(entries.slice(0, size).map(leafHash));
}
