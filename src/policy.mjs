// Deterministic local policy, for any agent action, money or not. Codes match
// the hosted engine so a local refusal reads the same as a server one.
import { createHash } from 'node:crypto';
import { canonical } from './canonical.mjs';

export const ALLOW = 'ALLOW';

const EXPONENTS = { EUR: 2, USD: 2, GBP: 2, CHF: 2, SEK: 2, JPY: 0 };

export function toMinor(amount, currency) {
  const exponent = EXPONENTS[currency];
  if (exponent === undefined) {
    throw new Error(`unsupported currency ${currency}; add its exponent to src/policy.mjs`);
  }
  if (!/^\d+(\.\d+)?$/.test(String(amount))) throw new Error(`amount ${amount} is not a positive decimal`);
  const [whole, fraction = ''] = String(amount).split('.');
  if (fraction.length > exponent) {
    throw new Error(`amount ${amount} has more than ${exponent} decimal places for ${currency}`);
  }
  return Number(whole) * 10 ** exponent + Number(fraction.padEnd(exponent, '0'));
}

export function formatMinor(minor, currency) {
  const exponent = EXPONENTS[currency] ?? 2;
  const scale = 10 ** exponent;
  return `${Math.trunc(minor / scale)}.${String(minor % scale).padStart(exponent, '0')}`;
}

export function policyDigest(policy) {
  return createHash('sha256').update(canonical(policy)).digest('base64url');
}

// A policy is about one action. Money is optional: an action like tool.call or
// repo.write has bounds but no amount, and saying so with max_amount is wrong.
export function validatePolicy(policy) {
  const fail = (message) => {
    const error = new Error(`policy is invalid: ${message}`);
    error.file = 'policy.json';
    throw error;
  };
  if (policy === null || typeof policy !== 'object') fail('not an object');
  if (policy.version !== 1) fail('version must be 1');
  if (typeof policy.action !== 'string' || policy.action === '') fail('action must be a non-empty string');
  if (policy.action !== '*' && policy.action.trim() === '') fail('action must be a non-empty string or *');

  const money = policy.max_amount !== undefined || policy.currency !== undefined;
  if (money) {
    if (!EXPONENTS[policy.currency]) fail(`currency ${policy.currency} is not supported`);
    if (!Number.isInteger(policy.max_amount) || policy.max_amount < 0) {
      fail('max_amount must be a whole number of minor units, 0 or more');
    }
  }
  if (policy.subjects !== undefined) {
    if (!Array.isArray(policy.subjects) || policy.subjects.some((item) => typeof item !== 'string' || item === '')) {
      fail('subjects must be a list of non-empty strings when present');
    }
  }
  for (const field of ['on_or_after', 'on_or_before']) {
    if (policy[field] !== undefined && Number.isNaN(Date.parse(policy[field]))) {
      fail(`${field} must be an ISO date when present`);
    }
  }
  return policy;
}

// Order matters for the reader: the most specific reason wins, so a refusal
// names one cause rather than a list.
export function evaluate(policy, proposal, now = new Date()) {
  if (policy.action !== '*' && proposal.action !== policy.action) {
    return { decision: 'DENY', code: 'ACTION_MISMATCH', rule: 'policy.action' };
  }
  if (policy.subjects !== undefined) {
    if (typeof proposal.subject !== 'string') {
      return { decision: 'DENY', code: 'REQUIRED_ATTRIBUTE_MISSING', rule: 'policy.subjects' };
    }
    if (!policy.subjects.includes(proposal.subject)) {
      return { decision: 'DENY', code: 'VALUE_NOT_ALLOWED', rule: 'policy.subjects' };
    }
  }
  if (policy.max_amount !== undefined) {
    if (!proposal.amount || !Number.isInteger(proposal.amount.minor)) {
      return { decision: 'DENY', code: 'REQUIRED_ATTRIBUTE_MISSING', rule: 'policy.max_amount' };
    }
    if (proposal.amount.currency !== policy.currency) {
      return { decision: 'DENY', code: 'VALUE_MISMATCH', rule: 'policy.currency' };
    }
    if (proposal.amount.minor > policy.max_amount) {
      return { decision: 'DENY', code: 'ABOVE_MAXIMUM', rule: 'policy.max_amount' };
    }
  }
  const at = now.getTime();
  if (policy.on_or_after && at < Date.parse(policy.on_or_after)) {
    return { decision: 'DENY', code: 'OUTSIDE_DATE_RANGE', rule: 'policy.on_or_after' };
  }
  if (policy.on_or_before && at > Date.parse(policy.on_or_before)) {
    return { decision: 'DENY', code: 'OUTSIDE_DATE_RANGE', rule: 'policy.on_or_before' };
  }
  return { decision: ALLOW, code: ALLOW };
}
