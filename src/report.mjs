// The overview that answers "what did this actually cost me, and what did it
// stop": per task, how many actions ran, how many were refused and why, and the
// tokens and money the task spent. Costs come from a llm.session entry the
// recorder writes, never from an estimate the report invents.
import { paths, readKey, readState } from './store.mjs';
import { isRunAction } from './ledger.mjs';
import { isMetaAction, normalizeUsage } from './usage.mjs';
import { forEachEntry } from './stream.mjs';

const emptyGroup = () => ({
  actions: 0,
  blocked: 0,
  reasons: new Map(),
  tokens: 0,
  cached_tokens: 0,
  cost_usd: 0,
  api_calls: 0,
  invalid: 0,
});

const add = (group, entry) => {
  let usage = null;
  try {
    usage = normalizeUsage(entry);
  } catch {
    group.invalid += 1;
  }
  if (usage) {
    group.tokens += usage.tokens;
    group.cached_tokens += usage.cached_tokens;
    group.cost_usd += usage.cost_usd;
    group.api_calls += usage.api_calls > 0 ? usage.api_calls : (entry.action === 'llm.session' ? 1 : 0);
  }
  if (isMetaAction(entry)) return;
  group.actions += 1;
  if (entry.decision === 'ALLOW') return;
  group.blocked += 1;
  const code = entry.code ?? 'UNKNOWN';
  group.reasons.set(code, (group.reasons.get(code) ?? 0) + 1);
};

function finish(group) {
  return {
    actions: group.actions,
    allowed: group.actions - group.blocked,
    blocked: group.blocked,
    blocked_share: group.actions === 0 ? null : group.blocked / group.actions,
    reasons: [...group.reasons.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([code, count]) => ({ code, count })),
    tokens: group.tokens,
    cached_tokens: group.cached_tokens,
    cost_usd: Number(group.cost_usd.toFixed(6)),
    api_calls: group.api_calls,
    invalid: group.invalid,
  };
}

// A refusal the agent cannot act on becomes a retry storm: one measured ledger
// has the same call refused 106 times. Counting blocked attempts that were
// followed by the same call again is how the remedy gets measured, and the
// number to watch go to zero.
const retryStats = (entries) => {
  const perCall = new Map();
  for (const entry of entries) {
    if (isRunAction(entry) || entry.args_hash === undefined) continue;
    const key = `${entry.task ?? ''}\u0000${entry.subject ?? ''}\u0000${entry.args_hash}`;
    if (!perCall.has(key)) perCall.set(key, []);
    perCall.get(key).push(entry.decision === 'ALLOW');
  }
  let retried = 0;
  let worst = 0;
  for (const allowed of perCall.values()) {
    let blocked = 0;
    for (let index = 0; index < allowed.length; index += 1) {
      if (allowed[index]) continue;
      blocked += 1;
      // Anything after this attempt is a retry of the same call.
      if (index < allowed.length - 1) retried += 1;
    }
    worst = Math.max(worst, blocked);
  }
  return { refusals_retried: retried, worst_call_blocked: worst };
};

function reportOf(groups, count, kid, all, entries) {

  return {
    key: kid,
    entries: count,
    tasks: [...groups.entries()]
      .map(([task, group]) => ({ task, ...finish(group) }))
      .sort((left, right) => right.actions - left.actions),
    totals: finish(all),
    retries: retryStats(entries),
  };
}

export function buildReport(dir) {
  const { entries, key } = readState(dir);
  const groups = new Map();
  const all = emptyGroup();
  for (const entry of entries) {
    add(all, entry);
    if (isRunAction(entry)) continue;
    const task = entry.task ?? '(unscoped)';
    if (!groups.has(task)) groups.set(task, emptyGroup());
    add(groups.get(task), entry);
  }
  return reportOf(groups, entries.length, key.kid, all, entries);
}

export async function buildReportStream(dir) {
  const key = readKey(dir);
  const groups = new Map();
  const all = emptyGroup();
  let count = 0;
  const entries = [];
  await forEachEntry(paths(dir).ledger, (entry) => {
    count += 1;
    entries.push(entry);
    add(all, entry);
    if (isRunAction(entry)) return;
    const task = entry.task ?? '(unscoped)';
    if (!groups.has(task)) groups.set(task, emptyGroup());
    add(groups.get(task), entry);
  });
  return reportOf(groups, count, key.kid, all, entries);
}

const percent = (share) => (share === null ? 'n/a' : `${Math.round(share * 100)}%`);

export function renderReport(report) {
  const lines = [];
  const invalid = report.totals.invalid > 0 ? `, ${report.totals.invalid} invalid usage` : '';
  const retried =
    report.retries.refusals_retried > 0
      ? `, ${report.retries.refusals_retried} refusals retried (worst call refused ${report.retries.worst_call_blocked}x)`
      : '';
  lines.push(
    `${report.entries} entries, key ${report.key}: ${report.totals.actions} actions, ` +
      `${report.totals.blocked} refused (${percent(report.totals.blocked_share)}), ` +
      `${report.totals.tokens.toLocaleString('en-US')} tokens, ${report.totals.cost_usd.toFixed(4)} USD${invalid}${retried}`,
  );
  lines.push('');
  const rows = report.tasks.map((task) => ({
    task: task.task.length > 34 ? `${task.task.slice(0, 33)}…` : task.task,
    actions: String(task.actions),
    refused: `${task.blocked} (${percent(task.blocked_share)})`,
    top: task.reasons.slice(0, 2).map((reason) => `${reason.code}×${reason.count}`).join(' '),
    tokens: task.tokens.toLocaleString('en-US'),
    cached: task.cached_tokens > 0 ? task.cached_tokens.toLocaleString('en-US') : '',
    cost: task.cost_usd > 0 ? task.cost_usd.toFixed(4) : '',
  }));
  const width = (field) => Math.max(field.length, ...rows.map((row) => String(row[field]).length));
  const columns = ['task', 'actions', 'refused', 'top', 'tokens', 'cached', 'cost'];
  const sizes = Object.fromEntries(columns.map((column) => [column, width(column)]));
  const header = columns.map((column) => column.padEnd(sizes[column])).join('  ');
  lines.push(header);
  lines.push(columns.map((column) => '─'.repeat(sizes[column])).join('  '));
  for (const row of rows) {
    lines.push(columns.map((column) => String(row[column]).padEnd(sizes[column])).join('  '));
  }
  return `${lines.join('\n')}\n`;
}
