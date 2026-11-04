import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate, formatMinor, toMinor, validatePolicy } from '../src/policy.mjs';

const money = validatePolicy({
  version: 1,
  action: 'purchase.execute',
  currency: 'EUR',
  max_amount: 25000,
  subjects: ['shop.example'],
  on_or_after: '2026-01-01T00:00:00Z',
  on_or_before: '2026-12-31T23:59:59Z',
});

const tools = validatePolicy({ version: 1, action: 'tool.call', subjects: ['read_file', 'search_files'] });

const now = new Date('2026-10-31T12:00:00Z');
const purchase = (overrides = {}) => ({
  action: 'purchase.execute',
  subject: 'shop.example',
  amount: { minor: 1250, currency: 'EUR' },
  ...overrides,
});

test('amounts convert to minor units and back', () => {
  assert.equal(toMinor('12.50', 'EUR'), 1250);
  assert.equal(toMinor('500', 'JPY'), 500);
  assert.equal(formatMinor(1250, 'EUR'), '12.50');
  assert.throws(() => toMinor('1.234', 'EUR'), /more than 2 decimal places/);
  assert.throws(() => toMinor('10', 'XYZ'), /unsupported currency/);
});

test('a policy without money is valid, and money needs both fields', () => {
  assert.equal(tools.action, 'tool.call');
  assert.throws(() => validatePolicy({ version: 1, action: 'a', currency: 'EUR' }), /max_amount/);
  assert.throws(() => validatePolicy({ version: 1, action: 'a', max_amount: 100 }), /currency/);
  assert.throws(() => validatePolicy({ version: 1, action: 'a', subjects: [''] }), /subjects/);
  assert.throws(() => validatePolicy({ version: 2 }), /version must be 1/);
});

test('an action inside the bounds is allowed', () => {
  assert.deepEqual(evaluate(money, purchase(), now), { decision: 'ALLOW', code: 'ALLOW' });
});

test('a non-money action is judged on its subject alone', () => {
  assert.equal(evaluate(tools, { action: 'tool.call', subject: 'read_file' }, now).decision, 'ALLOW');
  assert.equal(evaluate(tools, { action: 'tool.call', subject: 'terminal' }, now).code, 'VALUE_NOT_ALLOWED');
  assert.equal(evaluate(tools, { action: 'tool.call' }, now).code, 'REQUIRED_ATTRIBUTE_MISSING');
});

test('a wildcard policy covers every action, still bounded by subject and money', () => {
  const any = validatePolicy({ version: 1, action: '*', subjects: ['read_file'] });
  assert.equal(evaluate(any, { action: 'tool.call', subject: 'read_file' }, now).decision, 'ALLOW');
  assert.equal(evaluate(any, { action: 'llm.turn', subject: 'read_file' }, now).decision, 'ALLOW');
  assert.equal(evaluate(any, { action: 'tool.call', subject: 'terminal' }, now).code, 'VALUE_NOT_ALLOWED');
});

test('each breach names one cause', () => {
  assert.equal(evaluate(money, purchase({ action: 'refund.execute' }), now).code, 'ACTION_MISMATCH');
  assert.equal(evaluate(money, purchase({ amount: undefined }), now).code, 'REQUIRED_ATTRIBUTE_MISSING');
  assert.equal(evaluate(money, purchase({ amount: { minor: 1250, currency: 'USD' } }), now).code, 'VALUE_MISMATCH');
  assert.equal(evaluate(money, purchase({ subject: 'elsewhere.example' }), now).code, 'VALUE_NOT_ALLOWED');
  assert.equal(evaluate(money, purchase({ amount: { minor: 25001, currency: 'EUR' } }), now).code, 'ABOVE_MAXIMUM');
  assert.equal(evaluate(money, purchase(), new Date('2027-01-01T00:00:00Z')).code, 'OUTSIDE_DATE_RANGE');
});
