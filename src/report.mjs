// The overview that answers "what did this actually cost me, and what did it
// stop": per task, how many actions ran, how many were refused and why, and the
// tokens and money the task spent. Costs come from a llm.session entry the
// recorder writes, never from an estimate the report invents.
import { paths, readKey, readState } from './store.mjs';
import { forEachEntry } from './stream.mjs';

const isSpend = (entry) => entry.action === 'llm.session';

const emptyGroup = () => ({
  actions: 0,
  blocked: 0,
  reasons: new Map(),
  tokens: 0,
  cached_tokens: 0,
  cost_usd: 0,
  api_calls: 0,
});

const add = (group, entry) => {
  const meta = entry.meta ?? {};
  group.tokens += Number(meta.tokens) || 0;
  group.cached_tokens += Number(meta.cached_tokens) || 0;
  group.cost_usd += Number(meta.cost_usd) || 0;
  group.api_calls += Number(meta.api_calls) || 0;
  if (isSpend(entry)) return;
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
  };
}

function reportOf(groups, count, kid, all) {
  return {
    key: kid,
    entries: count,
    tasks: [...groups.entries()]
      .map(([task, group]) => ({ task, ...finish(group) }))
      .sort((left, right) => right.actions - left.actions),
    totals: finish(all),
  };
}

export function buildReport(dir) {
  const { entries, key } = readState(dir);
  const groups = new Map();
  const all = emptyGroup();
  for (const entry of entries) {
    add(all, entry);
    const task = entry.task ?? '(unscoped)';
    if (!groups.has(task)) groups.set(task, emptyGroup());
    add(groups.get(task), entry);
  }
  return reportOf(groups, entries.length, key.kid, all);
}

export async function buildReportStream(dir) {
  const key = readKey(dir);
  const groups = new Map();
  const all = emptyGroup();
  let count = 0;
  await forEachEntry(paths(dir).ledger, (entry) => {
    count += 1;
    add(all, entry);
    const task = entry.task ?? '(unscoped)';
    if (!groups.has(task)) groups.set(task, emptyGroup());
    add(groups.get(task), entry);
  });
  return reportOf(groups, count, key.kid, all);
}

const percent = (share) => (share === null ? 'n/a' : `${Math.round(share * 100)}%`);

export function renderReport(report) {
  const lines = [];
  lines.push(
    `${report.entries} entries, key ${report.key}: ${report.totals.actions} actions, ` +
      `${report.totals.blocked} refused (${percent(report.totals.blocked_share)}), ` +
      `${report.totals.tokens.toLocaleString('en-US')} tokens, ${report.totals.cost_usd.toFixed(4)} USD`,
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
