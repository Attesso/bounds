// Re-judge a recorded ledger under a candidate policy. The ledger is a record of
// attempts, so every entry stays in the history even when it was refused: that is
// what makes an observe-mode run replayable.
import { decide } from './decide.mjs';
import { argsHashOf, deniedCapabilities } from './rules.mjs';

export const proposalOf = (entry) => ({
  action: entry.action,
  subject: entry.subject,
  amount: entry.amount,
  task: entry.task,
  trust: entry.trust,
  capability: entry.capability,
  args_hash: argsHashOf(entry),
  meta: entry.meta,
});

// A rule can only be defeated by a field this entry would have needed to match
// it. One web-only same-arguments rule must not make every other tool
// unenforceable, or a replay cannot judge the rows it is meant to compare.
const matchesTrigger = (trigger, entry) => {
  if (trigger.trust && trigger.trust !== entry.trust) return false;
  if (trigger.subject && trigger.subject !== entry.subject) return false;
  if (trigger.capability && entry.capability !== undefined && trigger.capability !== entry.capability) return false;
  return true;
};

function needsArguments(entry, rules) {
  return (rules?.rules ?? []).some((rule) => {
    const trigger = rule.if_path ?? {};
    if (trigger.same_arguments) {
      if (!matchesTrigger(trigger, entry)) return false;
      // Without a capability, the missing-field check below reports the gap.
      return !(trigger.capability && entry.capability === undefined);
    }
    if (rule.max_repeats !== undefined) {
      if (entry.capability !== undefined) {
        const denied = deniedCapabilities(rule);
        if (!denied.includes(entry.capability)) return false;
      }
      return true;
    }
    return false;
  });
}

// A candidate rule may read a field this entry never stored. Say so instead of
// reporting a clean allow the rule could not actually have reached.
function missingFields(entry, rules) {
  const reasons = [];
  const pathRules = (rules?.rules ?? []).filter(
    (rule) => rule.if_path?.trust !== undefined || rule.if_path?.capability !== undefined,
  );
  if (
    pathRules.some(
      (rule) => rule.if_path?.capability && matchesTrigger(rule.if_path, entry) && !entry.capability,
    )
  ) {
    reasons.push('NO_CAPABILITY');
  }
  if (needsArguments(entry, rules) && argsHashOf(entry) === undefined) reasons.push('NO_ARGUMENTS');
  return reasons;
}

export function replay(entries, { policy, rules }) {
  const histories = new Map();
  const summary = {
    total: entries.length,
    original_denials: entries.filter((entry) => entry.decision !== 'ALLOW').length,
    candidate_denials: 0,
    denial_rate: 0,
    unchanged: 0,
    newly_allowed: 0,
    newly_denied: 0,
    unenforceable: 0,
    changed: [],
    unenforceable_rows: [],
  };
  for (const entry of entries) {
    const key = entry.task ?? null;
    const history = histories.get(key) ?? [];
    const from = { decision: entry.decision, code: entry.code };
    if (entry.control) {
      summary.unchanged += 1;
      history.push(entry);
      histories.set(key, history);
      continue;
    }
    const reasons = missingFields(entry, rules);
    if (reasons.length > 0) {
      summary.unenforceable += 1;
      summary.unenforceable_rows.push({ seq: entry.seq, reasons });
    } else {
      const to = decide({ policy, rules, history, proposal: proposalOf(entry), now: new Date(entry.at) });
      if (to.decision === from.decision && to.code === from.code) {
        summary.unchanged += 1;
      } else {
        if (from.decision === 'ALLOW' && to.decision === 'DENY') summary.newly_denied += 1;
        if (from.decision !== 'ALLOW' && to.decision === 'ALLOW') summary.newly_allowed += 1;
        summary.changed.push({
          seq: entry.seq,
          action: entry.action,
          subject: entry.subject,
          task: entry.task ?? null,
          from,
          to: { decision: to.decision, code: to.code, rule: to.rule ?? null },
        });
      }
    }
    history.push(entry);
    histories.set(key, history);
  }
  summary.candidate_denials = summary.original_denials - summary.newly_allowed + summary.newly_denied;
  summary.denial_rate = entries.length === 0 ? 0 : summary.candidate_denials / entries.length;
  return summary;
}

export function renderReplay(summary) {
  const percent = `${Math.round(summary.denial_rate * 100)}%`;
  const lines = [
    `${summary.total} entries: ${summary.candidate_denials} refusals under the candidate (${percent}), ` +
      `${summary.unchanged} unchanged, ${summary.newly_denied} newly denied, ` +
      `${summary.newly_allowed} newly allowed, ${summary.unenforceable} unenforceable`,
  ];
  for (const row of summary.changed.slice(0, 10)) {
    const subject = row.subject ? ` ${row.subject}` : '';
    lines.push(`  #${row.seq} ${row.from.decision}/${row.from.code} -> ${row.to.decision}/${row.to.code} ${row.action}${subject}`);
  }
  for (const row of summary.unenforceable_rows.slice(0, 10)) {
    lines.push(`  #${row.seq} unenforceable (${row.reasons.join(', ')})`);
  }
  return `${lines.join('\n')}\n`;
}
