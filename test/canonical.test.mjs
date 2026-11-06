import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UnserialisableValue, canonical } from '../src/canonical.mjs';

// The invariant that matters: whatever canonical() signs must be what
// JSON.stringify() writes. If the two disagree on a single shape, the entry
// signs bytes the file cannot hold and becomes unverifiable forever. That is
// exactly what an `undefined` member did, and it cost a 5,415-entry ledger.
const SHAPES = [
  null,
  true,
  false,
  0,
  -0,
  42,
  -1.5,
  1e21,
  Number.MAX_SAFE_INTEGER,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  '',
  'plain',
  'café 日本 🔒',
  'line\nbreak\tand "quotes"',
  [],
  [1, 2, 3],
  [undefined, 1],
  [null, [1, [2]]],
  {},
  { b: 1, a: 2 },
  { nested: { z: 1, a: [{ y: 2, x: [3] }] } },
  { missing: undefined, kept: 1 },
  { deep: { deeper: { deepest: undefined } } },
  { list: [{ gone: undefined, here: true }] },
  { usage: { input_tokens: 1, output_tokens: 2, model: undefined } },
  { ok: new Date('2026-11-05T20:20:56.576Z') },
  { at: new Date(0), nested: [new Date(1)] },
  { f: () => 1 },
  { sym: Symbol('x') },
  { arr: [() => 1, Symbol('y')] },
  { emptyString: '', zero: 0, no: false },
];

describe('canonical agrees with what the ledger stores', () => {
  it('parses to exactly the JSON.stringify round trip for every shape', () => {
    for (const shape of SHAPES) {
      const stored = JSON.stringify(shape);
      const signed = canonical(shape);
      if (stored === undefined) {
        assert.equal(signed, undefined, `expected undefined for ${String(shape)}`);
        continue;
      }
      assert.deepEqual(JSON.parse(signed), JSON.parse(stored), `shape disagreed: ${stored}`);
      // The signed text is itself stable: re-parsing and re-serialising it is a no-op.
      assert.equal(JSON.stringify(JSON.parse(signed)), signed);
    }
  });

  it('never emits a literal undefined, a bare array hole, or an empty object for a Date', () => {
    for (const shape of SHAPES) {
      const signed = canonical(shape);
      if (signed === undefined) continue;
      assert.equal(signed.includes('undefined'), false, `emitted undefined: ${signed}`);
      assert.equal(/\[,|,\]/.test(signed), false, `emitted an array hole: ${signed}`);
      JSON.parse(signed);
    }
    assert.equal(canonical({ d: new Date(0) }), JSON.stringify({ d: new Date(0) }));
  });

  it('sorts keys independent of insertion order', () => {
    assert.equal(canonical({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.equal(canonical({ a: 2, b: 1 }), '{"a":2,"b":1}');
    const first = { z: 1, m: { y: 2, x: 3 } };
    const second = { m: { x: 3, y: 2 }, z: 1 };
    assert.equal(canonical(first), canonical(second));
  });

  it('refuses what JSON cannot carry instead of signing something else', () => {
    assert.throws(() => canonical({ n: 1n }), UnserialisableValue);
    assert.throws(() => canonical({ n: 1n }), /BigInt/);
    const cycle = { a: 1 };
    cycle.self = cycle;
    assert.throws(() => canonical(cycle), UnserialisableValue);
    assert.throws(() => canonical(cycle), /circular/);
  });

  it('keeps a reusable object signable after it appears twice', () => {
    const shared = { k: 1 };
    assert.equal(canonical({ a: shared, b: shared }), '{"a":{"k":1},"b":{"k":1}}');
  });

  it('signs the payload the writers actually build', () => {
    // The shape append() signs, with the optional members a caller may omit.
    const entry = {
      v: 1,
      seq: 7,
      at: '2026-11-06T09:00:00.000Z',
      action: 'llm.session',
      subject: undefined,
      decision: 'ALLOW',
      code: 'ALLOW',
      meta: { usage: { input_tokens: 10, output_tokens: 2, model: undefined } },
    };
    const signed = canonical(entry);
    assert.deepEqual(JSON.parse(signed), JSON.parse(JSON.stringify(entry)));
    assert.equal(signed.includes('subject'), false);
    assert.equal(signed.includes('model'), false);
  });
});
