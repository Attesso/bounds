// Setup, explain and suggest: the three commands that make the loop feel like it
// configures itself.
//
//   setup    detect a harness, wire the hook, leave a short block the agent reads
//   explain  one ledger entry in full, including what tainted the path
//   suggest  rules the ledger's own counts justify, ready to accept
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { argsHashOf } from './rules.mjs';

const AGENT_BLOCK = `<!-- attesso:start -->
Bounds evaluates your tool calls locally and records every decision. In observe mode
a refusal is recorded but not blocked; in enforce mode it blocks. When a call is
refused you get a tool error naming the rule and the step that tainted the task.
Do not retry a refused call unchanged: read \`attesso explain <seq>\`, take another
path, or ask the user whether the rule is wrong. To see rules the ledger supports,
run \`attesso suggest\`.
<!-- attesso:end -->`;

function stripAgentBlock(text) {
  return text.replace(/<!-- attesso:start -->[\s\S]*?<!-- attesso:end -->\n?/g, '');
}

export function writeAgentContext(dir, { dryRun = false } = {}) {
  const path = join(resolve(dir), 'AGENTS.md');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const next = `${stripAgentBlock(existing).trimEnd()}\n\n${AGENT_BLOCK}\n`;
  if (dryRun) return { path, changed: next !== existing, preview: AGENT_BLOCK };
  if (next !== existing) writeFileSync(path, next.startsWith('\n') ? next.slice(1) : next);
  return { path, changed: next !== existing };
}

export function detectHarnesses({ home = homedir(), cwd = process.cwd() } = {}) {
  const found = [];
  const hermes = join(home, '.hermes', 'config.yaml');
  if (existsSync(hermes)) found.push({ key: 'hermes', path: hermes });
  const claude = join(home, '.claude', 'settings.json');
  if (existsSync(claude)) found.push({ key: 'claude-code', path: claude });
  const projectClaude = join(cwd, '.claude', 'settings.json');
  if (existsSync(projectClaude) && projectClaude !== claude) found.push({ key: 'claude-code-project', path: projectClaude });
  const codex = join(home, '.codex', 'hooks.json');
  if (existsSync(codex)) found.push({ key: 'codex', path: codex });
  const gemini = join(home, '.gemini', 'settings.json');
  if (existsSync(gemini)) found.push({ key: 'gemini', path: gemini });
  const cline = join(home, '.cline');
  if (existsSync(cline)) found.push({ key: 'cline', path: join(home, 'Documents', 'Cline', 'Hooks') });
  const cursor = join(home, '.cursor', 'hooks.json');
  if (existsSync(cursor)) found.push({ key: 'cursor', path: cursor });
  const projectCursor = join(cwd, '.cursor', 'hooks.json');
  if (existsSync(projectCursor) && projectCursor !== cursor) found.push({ key: 'cursor-project', path: projectCursor });
  return found;
}

export function explain(dir, seq, { entries }) {
  const entry = entries.find((candidate) => candidate.seq === Number(seq));
  if (!entry) return { found: false, seq };
  const taintedBy = entry.tainted_by ?? entry.meta?.tainted_by;
  const rule = entry.rule ?? entry.meta?.rule ?? null;
  const source = taintedBy ? entries.find((candidate) => candidate.seq === taintedBy) : null;
  const advice =
    entry.decision === 'ALLOW'
      ? 'Nothing to fix: this call was allowed.'
      : entry.code === 'PATH_DENIED'
        ? `The task read ${source?.subject ?? 'untrusted content'} at step #${taintedBy}. Take another path, or narrow ${rule}.`
        : entry.code === 'STEP_LIMIT'
          ? `The task reached the step ceiling in ${rule}. Split the task or raise the ceiling.`
          : entry.code === 'REPEAT_LIMIT'
            ? `The task repeated the same call past ${rule}. Change the call or raise the ceiling.`
            : rule
              ? `The call broke ${rule}. Check the field it names.`
              : 'The call broke the policy, not a path rule. Check the amount, payee or window.';
  return {
    found: true,
    seq: entry.seq,
    action: entry.action,
    subject: entry.subject,
    capability: entry.capability,
    trust: entry.trust,
    verdict: entry.decision,
    code: entry.code,
    rule,
    task: entry.task ?? null,
    tainted_by: source ? { seq: source.seq, action: source.action, subject: source.subject, trust: source.trust } : null,
    advice,
  };
}

const signature = (entry) => `${entry.action}\u0000${entry.subject ?? ''}\u0000${argsHashOf(entry) ?? ''}`;

export function suggest(dir, { entries, minRepeats = 3 }) {
  const within = entries.filter((entry) => entry.decision === 'ALLOW' && argsHashOf(entry) !== undefined);
  const counts = new Map();
  for (const entry of within) {
    const key = `${entry.task ?? ''}\u0000${signature(entry)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const repeats = [...counts.entries()]
    .filter(([, count]) => count >= minRepeats)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([key, count]) => {
      const [task, action, subject] = key.split('\u0000');
      const id = `no-repeat-${subject || action}`.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
      const capability = capabilityOf(entries, action, subject);
      return {
        id,
        count,
        task: task || null,
        rule: {
          id,
          deny: { capabilities: [capability] },
          if_path: { capability, subject, same_arguments: true, within_minutes: 30 },
        },
        why: `${count} identical ${action} calls with the same arguments in one task`,
      };
    });
  return { repeats, refusals: refusalSummary(entries) };
}

function capabilityOf(entries, action, subject) {
  const match = [...entries].reverse().find((entry) => entry.action === action && (entry.subject ?? '') === subject);
  return match?.capability ?? 'read';
}

function refusalSummary(entries) {
  const counts = new Map();
  for (const entry of entries) {
    if (entry.decision === 'ALLOW') continue;
    counts.set(entry.code, (counts.get(entry.code) ?? 0) + 1);
  }
  return [...counts.entries()].map(([code, count]) => ({ code, count })).sort((left, right) => right.count - left.count);
}
