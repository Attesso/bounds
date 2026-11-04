// One decision path, shared by the live gate and by replay. The order matters:
// a policy refusal wins, and a path rule is only consulted when the policy allows.
import { evaluate } from './policy.mjs';
import { evaluatePath } from './rules.mjs';

export function decide({ policy, rules, history, proposal, now }) {
  const policyVerdict = evaluate(policy, proposal, now);
  if (policyVerdict.decision !== 'ALLOW') return policyVerdict;
  return evaluatePath(rules, history, proposal, now) ?? policyVerdict;
}
