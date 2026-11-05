import assert from 'node:assert/strict';
import test from 'node:test';
import { captureDetail, verifyDetail, MAX_DETAIL_BYTES } from '../src/detail.mjs';
import { canonical } from '../src/canonical.mjs';
import { redactText } from '../src/redact.mjs';

const C0 = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = [
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,;:/_-[]{}()\'"!?=@#$%&*+<>|\\`~',
  '\n', '\t', '\u0000', '\u0007', '\u001b', '\u007f', '漢', '字', '🙂', 'é', 'Ω',
];

function randomText(rand, max) {
  const length = Math.floor(rand() * max);
  let text = '';
  for (let index = 0; index < length; index += 1) text += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return text;
}

test('captureDetail survives 2,000 seeded random commands', () => {
  const rand = mulberry32(0x5eed);
  for (let index = 0; index < 2000; index += 1) {
    const input = { command: randomText(rand, 3000) };
    if (index % 10 === 0) input.path = randomText(rand, 500);
    if (index % 25 === 0) input.url = `https://user:${randomText(rand, 20)}@example.com/${randomText(rand, 40)}`;
    const result = captureDetail({
      seq: index + 1,
      at: '2026-11-05T00:00:00.000Z',
      action: 'tool.call',
      tool: 'terminal',
      input,
    });
    assert.ok(Buffer.byteLength(canonical(result.detail)) <= MAX_DETAIL_BYTES, `iteration ${index} exceeded the cap`);
    assert.equal(verifyDetail({ seq: index + 1, detail_hash: result.hash }, result.detail).ok, true);
    for (const value of Object.values(result.detail.fields)) {
      if (typeof value === 'string') assert.equal(C0.test(value), false, `control char survived in fields at ${index}`);
    }
    assert.equal(C0.test(result.detail.summary), false, `control char survived in summary at ${index}`);
  }
});

test('captureDetail redacts a provider key inside random noise', () => {
  const rand = mulberry32(0xc0ffee);
  const secret = ['github_pat_', '11', 'A'.repeat(30)].join('');
  assert.equal(redactText(secret).text.includes(secret), false);
  for (let index = 0; index < 200; index += 1) {
    const command = `${randomText(rand, 300)} ${secret} ${randomText(rand, 300)}`;
    const result = captureDetail({
      seq: index + 1,
      at: '2026-11-05T00:00:00.000Z',
      action: 'tool.call',
      tool: 'terminal',
      input: { command },
    });
    assert.equal(canonical(result.detail).includes(secret), false, `secret survived at ${index}`);
  }
});
