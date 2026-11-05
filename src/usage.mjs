// Usage is reported by the agent or the recorder, never inferred from a tool
// proposal. The page may show exact call counts without usage; it must not
// convert task totals into a per-call saving.
import { isRunAction } from './ledger.mjs';

const numeric = (value, field) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`usage.${field} must be a non-negative number`);
  return number;
};

export const isMetaAction = (entry) => entry.action === 'llm.session' || isRunAction(entry);

export function normalizeUsage(entry) {
  const meta = entry.meta ?? {};
  const source = meta.usage && typeof meta.usage === 'object' ? meta.usage : meta;
  const hasUsage = entry.action === 'llm.session'
    || source.tokens !== undefined
    || source.input_tokens !== undefined
    || source.output_tokens !== undefined
    || source.cached_tokens !== undefined
    || source.cost_usd !== undefined;
  if (!hasUsage) return null;
  const input = source.input_tokens === undefined ? 0 : numeric(source.input_tokens, 'input_tokens');
  const output = source.output_tokens === undefined ? 0 : numeric(source.output_tokens, 'output_tokens');
  const total = source.tokens === undefined ? input + output : numeric(source.tokens, 'tokens');
  return {
    task: entry.task ?? '(unscoped)',
    seq: entry.action === 'llm.session' ? null : entry.seq,
    tokens: total,
    input_tokens: input,
    output_tokens: output,
    cached_tokens: source.cached_tokens === undefined ? 0 : numeric(source.cached_tokens, 'cached_tokens'),
    cost_usd: source.cost_usd === undefined ? 0 : numeric(source.cost_usd, 'cost_usd'),
    api_calls: source.api_calls === undefined ? 0 : numeric(source.api_calls, 'api_calls'),
    model: typeof source.model === 'string' ? source.model : undefined,
    split: source.input_tokens !== undefined || source.output_tokens !== undefined,
    source: entry.action === 'llm.session' ? 'session' : 'call',
  };
}

export function usageForDay(catalog, { day, timeZone }) {
  const tasks = new Map();
  let invalid = 0;
  catalog.scanDay(day, timeZone, (entry) => {
    if (isRunAction(entry)) return;
    const task = entry.task ?? '(unscoped)';
    const item = tasks.get(task) ?? {
      task, calls: 0, blocked: 0, tokens: 0, cached_tokens: 0,
      cost_usd: 0, api_calls: 0, measured: false, invalid: 0,
    };
    if (entry.action === 'llm.session') {
      try {
        const usage = normalizeUsage(entry);
        if (usage) {
          item.tokens += usage.tokens;
          item.cached_tokens += usage.cached_tokens;
          item.cost_usd += usage.cost_usd;
          item.api_calls += usage.api_calls;
          item.measured = true;
        }
      } catch {
        item.invalid += 1;
        invalid += 1;
      }
      tasks.set(task, item);
      return;
    }
    item.calls += 1;
    if (entry.decision === 'DENY') item.blocked += 1;
    try {
      const usage = normalizeUsage(entry);
      if (usage) {
        item.tokens += usage.tokens;
        item.cached_tokens += usage.cached_tokens;
        item.cost_usd += usage.cost_usd;
        item.api_calls += usage.api_calls;
        item.measured = true;
      }
    } catch {
      item.invalid += 1;
      invalid += 1;
    }
    tasks.set(task, item);
  });
  const list = [...tasks.values()].map((item) => ({ ...item, cost_usd: Number(item.cost_usd.toFixed(6)) }));
  const totals = list.reduce((sum, item) => ({
    calls: sum.calls + item.calls,
    blocked: sum.blocked + item.blocked,
    measured_calls: sum.measured_calls + (item.measured ? item.calls : 0),
    tokens: sum.tokens + item.tokens,
    cached_tokens: sum.cached_tokens + item.cached_tokens,
    cost_usd: Number((sum.cost_usd + item.cost_usd).toFixed(6)),
    api_calls: sum.api_calls + item.api_calls,
  }), { calls: 0, blocked: 0, measured_calls: 0, tokens: 0, cached_tokens: 0, cost_usd: 0, api_calls: 0 });
  return {
    day,
    tasks: list,
    totals,
    coverage: totals.calls ? totals.measured_calls / totals.calls : 0,
    invalid,
    generated_at: new Date().toISOString(),
  };
}

