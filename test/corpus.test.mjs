import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { verifyInclusion } from '../src/merkle.mjs';

const corpus = JSON.parse(readFileSync(new URL('../testdata/merkle-inclusion.json', import.meta.url), 'utf8'));

test('the transparency-dev inclusion corpus matches every case', () => {
  for (const item of corpus.cases) {
    const got = verifyInclusion(
      Buffer.from(item.leafHash ?? '', 'base64'),
      item.leafIdx,
      item.treeSize,
      (item.proof ?? []).map((hash) => Buffer.from(hash, 'base64')),
      Buffer.from(item.root ?? '', 'base64'),
    );
    assert.equal(got, !item.wantErr, item.name);
  }
});
