import assert from 'node:assert/strict';
import { realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalOut, flags, parseMeta } from '../src/cli-io.mjs';
import { initWorkspace, tempDir } from './helpers.mjs';

test('flags collect scalars, booleans and repeated meta pairs', () => {
  assert.deepEqual(flags(['--action', 'tool.call', '--json', '--meta', 'tokens=12', '--meta', 'model=deepseek']), {
    action: 'tool.call',
    json: true,
    meta: ['tokens=12', 'model=deepseek'],
  });
});

test('meta parsing keeps strings and converts numbers', () => {
  assert.deepEqual(parseMeta(['tokens=12', 'model=deepseek', 'empty=']), {
    tokens: 12,
    model: 'deepseek',
    empty: '',
  });
  assert.throws(() => parseMeta(['broken']), /key=value/);
});

test('canonicalOut resolves a real path and refuses a symlink', () => {
  const dir = initWorkspace('attesso-cli-io');
  const plain = join(dir, 'receipt.json');
  assert.equal(canonicalOut(plain), join(realpathSync(dir), 'receipt.json'));

  const link = join(tempDir('attesso-cli-io-link'), 'receipt.json');
  symlinkSync(plain, link);
  assert.equal(canonicalOut(link), null);
});
