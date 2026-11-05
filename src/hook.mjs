import { createHash } from 'node:crypto';
import { canonical } from './canonical.mjs';
import { classifyTool, loadTools } from './classify.mjs';
import { taskControl } from './control.mjs';

// One decision for a harness hook. Reads the shell-hook payload on stdin
// ({hook_event_name, tool_name, tool_input, session_id, ...}, the shape Claude
// Code, Cursor and Hermes all use) and answers in the same contract: exit 2 with
// a message refuses, exit 0 lets the call run.

// A repeat is the same tool with the same arguments, so the fingerprint of the
// arguments is what the rule compares. Storing the digest, never the payload: an
// argument can hold a secret, and the ledger is meant to be shareable.
export function argsFingerprint(toolInput) {
  return createHash('sha256').update(canonical(toolInput ?? {})).digest('base64url').slice(0, 16);
}

const PATH_FIELDS = ['path', 'file_path', 'target_file', 'notebook_path', 'directory', 'cwd'];

function pathFromPayload(payload) {
  const input = payload.tool_input;
  if (!input || typeof input !== 'object') return undefined;
  for (const field of PATH_FIELDS) {
    if (typeof input[field] === 'string' && input[field] !== '') return input[field];
  }
  return undefined;
}

export function requestFromPayload(payload, tools) {
  const { action, capability, trust } = classifyTool(payload.tool_name, tools);
  const toolHash =
    typeof payload.tool_definition_hash === 'string' && payload.tool_definition_hash !== ''
      ? payload.tool_definition_hash
      : undefined;
  return {
    action,
    subject: payload.tool_name ?? null,
    task: payload.session_id ?? 'unknown',
    trust,
    capability,
    args_hash: argsFingerprint(payload.tool_input),
    detail_input: payload.tool_input ?? {},
    tool_hash: toolHash,
    path: pathFromPayload(payload),
  };
}

export function createHookDecider({ append, dir, observe }) {
  return (payload) => {
    const proposal = requestFromPayload(payload, loadTools(dir));
    let control;
    try {
      control = taskControl(dir, proposal.task);
    } catch (error) {
      return {
        exitCode: observe ? 0 : 2,
        body: {
          decision: observe ? 'allow' : 'block',
          code: 'CONTROL_UNAVAILABLE',
          enforced: !observe,
          message: `Attesso could not read the task control: ${error.message}`,
        },
      };
    }
    const entry = append(
      dir,
      proposal,
      control ? { control: { mode: control.mode, at: control.at, reason: control.reason } } : undefined,
    );
    const refused = entry.decision !== 'ALLOW';
    const enforced = refused && (!observe || entry.control !== undefined || entry.enforce === true);
    return {
      exitCode: enforced ? 2 : 0,
      body: {
        // The harness obeys `decision`, so observe mode must answer allow even
        // when the verdict is DENY. An explicit pause or stop is the exception:
        // it is the operator's steering act, not an observation.
        decision: enforced ? 'block' : 'allow',
        verdict: entry.decision,
        code: entry.code,
        enforced,
        seq: entry.seq,
        message: refusalMessage(entry, payload.tool_name),
      },
    };
  };
}

function refusalMessage(entry, toolName) {
  if (entry.control) {
    const verb = entry.control.mode === 'stop' ? 'stopped' : 'paused';
    return `Attesso ${verb} task ${entry.task}: ${entry.code}. Run attesso resume ${entry.task} when ready.`;
  }
  if (entry.code === 'BUDGET_EXCEEDED') {
    return `Attesso stopped this run: the budget in ${entry.rule} is exhausted. Summarize and stop, or raise the budget. Entry #${entry.seq}.`;
  }
  if (entry.rule && entry.tainted_by !== undefined) {
    return `Attesso refused ${toolName}: ${entry.code} by ${entry.rule} (step #${entry.tainted_by} tainted this task). Entry #${entry.seq} in the signed ledger.`;
  }
  if (entry.rule) {
    return `Attesso refused ${toolName}: ${entry.code} by ${entry.rule}. Entry #${entry.seq} in the signed ledger.`;
  }
  return `Attesso refused ${toolName}: ${entry.code}. Entry #${entry.seq} in the signed ledger.`;
}
