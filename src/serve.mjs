// A long-lived decision daemon: any harness writes one JSON request per line and
// reads one verdict per line. The harness keeps the process for its whole
// session, so a decision costs an IPC round trip instead of a process spawn.
//
// A refusal is recorded either way; `enforced` says whether the caller may
// proceed, which is what makes observe mode trustworthy: the ledger keeps the
// verdict, the agent keeps working.
import { createInterface } from 'node:readline';
import { append } from './store.mjs';
import { setTaskControl } from './control.mjs';
import { remedyFor } from './remedy.mjs';

const parse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

export function serve(dir, { observe = false, input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const request = parse(line);
    if (!request) {
      output.write(`${JSON.stringify({ error: 'request is not JSON' })}\n`);
      return;
    }
    let entry;
    try {
      const { tool_input, ...fields } = request;
      entry = append(dir, { ...fields, detail_input: tool_input });
    } catch (error) {
      // Never answer with a policy verdict when the record could not be written:
      // an unwritable ledger is an outage, not a decision.
      output.write(`${JSON.stringify({ id: request.id ?? null, error: String(error.message ?? error) })}\n`);
      return;
    }
    // Same rule as the hook: a TASK_STOPPED verdict has to be true, or the code
    // names a state nothing recorded.
    if (
      entry.code === 'TASK_STOPPED' &&
      !observe &&
      entry.control === undefined &&
      typeof entry.task === 'string' &&
      entry.task !== ''
    ) {
      setTaskControl(dir, entry.task, 'stop', {
        reason: 'the same call kept returning after a refusal; resume after changing the rule or the task',
      });
    }
    output.write(
      `${JSON.stringify({
        id: request.id ?? null,
        decision: entry.decision,
        code: entry.code,
        reason: entry.rule
          ? entry.tainted_by === undefined
            ? entry.rule
            : `${entry.rule} (tainted by step #${entry.tainted_by})`
          : null,
        enforced: entry.decision !== 'ALLOW' && (!observe || entry.enforce === true),
        ...(entry.decision === 'ALLOW' ? {} : { remedy: remedyFor(entry.code) }),
        seq: entry.seq,
      })}\n`,
    );
  });
  return new Promise((resolve) => rl.on('close', resolve));
}
