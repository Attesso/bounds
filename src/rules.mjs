// Policies on paths: an action is judged against the ordered history of the same
// task, not in isolation. A read of something untrusted followed by a send is the
// case no per-step check can catch, and it is the reason this file exists.
import { createHash } from 'node:crypto';
import { canonical } from './canonical.mjs';

export const CAPABILITIES = ['read', 'write', 'send', 'execute', 'spend'];
export const RULE_PROFILES = ['balanced', 'strict'];
export const TRUST_LEVELS = ['internal', 'untrusted', 'unknown'];

// One policy, two postures. Balanced catches the outbound boundary and duplicate
// fetches; strict keeps the old conservative posture for an untrusted
// environment, where a shell command itself can exfiltrate.
export function rulesForProfile(profile = 'balanced') {
  const untrustedRead = { trust: 'untrusted', capability: 'read', within_minutes: 30 };
  const repeatWeb = {
    capability: 'read',
    subject: 'web_extract',
    same_arguments: true,
    within_minutes: 30,
  };
  if (profile === 'balanced') {
    return {
      version: 1,
      rules: [
        { id: 'no-send-after-untrusted-read', deny: { capabilities: ['send'] }, if_path: { ...untrustedRead } },
        { id: 'no-repeat-web-extract', deny: { capabilities: ['read'] }, if_path: { ...repeatWeb } },
      ],
    };
  }
  if (profile === 'strict') {
    return {
      version: 1,
      rules: [
        { id: 'no-send-after-untrusted-read', deny: { capabilities: ['send', 'write', 'execute'] }, if_path: { ...untrustedRead } },
        { id: 'no-repeat-web-extract', deny: { capabilities: ['read'] }, if_path: { ...repeatWeb } },
      ],
    };
  }
  throw new Error(`unknown rule profile ${profile}; choose ${RULE_PROFILES.join(' or ')}`);
}

// Entries written before the argument fingerprint moved out of meta keep it
// there; every reader goes through this helper so both shapes agree.
export const argsHashOf = (value) => value?.args_hash ?? value?.meta?.args_hash;

export function rulesDigest(rules) {
  return createHash('sha256').update(canonical(rules)).digest('base64url');
}

// One reading of a rule's deny block, shared by validation and evaluation.
export function deniedCapabilities(rule) {
  const deny = rule.deny ?? {};
  if (deny.all) return CAPABILITIES;
  return deny.capabilities ?? (deny.capability ? [deny.capability] : []);
}

export function validateRules(rules) {
  const fail = (message) => {
    throw new Error(`rules are invalid: ${message}`);
  };
  if (rules === null || typeof rules !== 'object') fail('not an object');
  if (rules.version !== 1) fail('version must be 1');
  if (!Array.isArray(rules.rules)) fail('rules must be a list');
  for (const rule of rules.rules) {
    if (typeof rule.id !== 'string' || rule.id === '') fail('every rule needs an id');
    const denies = deniedCapabilities(rule);
    if (denies.length === 0) fail(`rule ${rule.id} denies nothing`);
    for (const capability of denies) {
      if (!CAPABILITIES.includes(capability)) fail(`rule ${rule.id} denies unknown capability ${capability}`);
    }
    const trigger = rule.if_path ?? {};
    if (trigger.trust && !TRUST_LEVELS.includes(trigger.trust)) fail(`rule ${rule.id} names unknown trust ${trigger.trust}`);
    if (trigger.capability && !CAPABILITIES.includes(trigger.capability)) {
      fail(`rule ${rule.id} triggers on unknown capability ${trigger.capability}`);
    }
    const counts = rule.max_steps !== undefined || rule.max_repeats !== undefined;
    if (!counts && trigger.trust === undefined && trigger.capability === undefined) {
      fail(`rule ${rule.id} has no path condition`);
    }
    for (const field of ['max_steps', 'max_repeats']) {
      if (rule[field] !== undefined && (!Number.isInteger(rule[field]) || rule[field] < 1)) {
        fail(`rule ${rule.id} needs a whole ${field} of at least 1`);
      }
    }
    if (trigger.within_minutes !== undefined && (!Number.isInteger(trigger.within_minutes) || trigger.within_minutes < 0)) {
      fail(`rule ${rule.id} needs whole minutes for within_minutes`);
    }
  }
  return rules;
}

// The most recent matching step taints the path; naming it is what makes the
// refusal explainable rather than mysterious.
export function evaluatePath(rules, history, proposal, now = new Date()) {
  if (!rules) return null;
  for (const rule of rules.rules ?? []) {
    const denied = deniedCapabilities(rule);
    if (proposal.capability && !denied.includes(proposal.capability)) continue;

    // A ceiling on the task itself. This is the rule that stops a runaway loop,
    // which is where an agent's money actually goes missing.
    if (rule.max_steps !== undefined && history.length >= rule.max_steps) {
      return { decision: 'DENY', code: 'STEP_LIMIT', rule: rule.id, tainted_by: history.length };
    }
    if (rule.max_repeats !== undefined) {
      const proposalHash = argsHashOf(proposal);
      // Without a fingerprint a repeat cannot be identified; counting every call
      // with the same subject would refuse the second unrelated command.
      if (proposalHash !== undefined) {
        const repeats = history.filter(
          (entry) => entry.subject === proposal.subject && argsHashOf(entry) === proposalHash,
        );
        if (repeats.length >= rule.max_repeats) {
          return { decision: 'DENY', code: 'REPEAT_LIMIT', rule: rule.id, tainted_by: repeats[0].seq };
        }
      }
    }
    const trigger = rule.if_path ?? {};
    // Counting rules have no trigger of their own; without this they would fall
    // through to the path matcher and deny the second call for no reason.
    if (trigger.trust === undefined && trigger.capability === undefined) continue;
    const window = (trigger.within_minutes ?? 0) * 60_000;
    const hit = [...history].reverse().find((entry) => {
      if (trigger.trust && entry.trust !== trigger.trust) return false;
      if (trigger.capability && entry.capability !== trigger.capability) return false;
      if (trigger.subject && entry.subject !== trigger.subject) return false;
      if (trigger.same_arguments && argsHashOf(entry) !== argsHashOf(proposal)) return false;
      if (window > 0 && now.getTime() - Date.parse(entry.at) > window) return false;
      return true;
    });
    if (hit) {
      return { decision: 'DENY', code: 'PATH_DENIED', rule: rule.id, tainted_by: hit.seq };
    }
  }
  return null;
}
