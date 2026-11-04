// Harness I/O belongs here, not in the decision path. Each product sends a
// different event name and reads a different decision object; the payload
// carries enough to detect them, so one hook command can serve them all.
//
// A refusal is rendered in the caller's own shape. Observe mode and an ALLOW
// never answer "allow" on harnesses whose allow bypasses their native approval
// prompt; they stay silent and let the product ask its own question.
const CLAUDE = 'claude-code';
const CURSOR = 'cursor';
const CLINE = 'cline';
const GEMINI = 'gemini';
const HERMES = 'hermes';
const GENERIC = 'generic';

// One descriptor per caller. Detection reads `event`; installation reads the
// same entry, so adding a caller cannot leave the two halves disagreeing.
export const HARNESSES = {
  [HERMES]: { event: 'pre_tool_call', kind: 'yaml' },
  [CLAUDE]: { event: 'PreToolUse', kind: 'json' },
  codex: { event: 'PreToolUse', kind: 'json' },
  [CURSOR]: { event: 'preToolUse', kind: 'json' },
  [GEMINI]: { event: 'BeforeTool', kind: 'json' },
  [CLINE]: { event: 'preToolUse', kind: 'script', script: 'PreToolUse' },
};

export function normalizeHookPayload(payload = {}) {
  if (payload.preToolUse && typeof payload.preToolUse === 'object') {
    return {
      harness: CLINE,
      payload: {
        tool_name: payload.preToolUse.tool,
        tool_input: payload.preToolUse.parameters,
        session_id: payload.taskId ?? 'unknown',
      },
    };
  }

  const harness = harnessOf(payload.hook_event_name);
  return {
    harness,
    payload: {
      tool_name: payload.tool_name,
      tool_input: payload.tool_input,
      session_id: payload.session_id ?? payload.conversation_id ?? 'unknown',
      tool_definition_hash: payload.tool_definition_hash,
    },
  };
}

function harnessOf(event) {
  if (event === HARNESSES[HERMES].event) return HERMES;
  const match = Object.entries(HARNESSES).find(([, spec]) => spec.kind === 'json' && spec.event === event);
  return match?.[0] ?? GENERIC;
}

export function renderHook({ harness, result }) {
  const body = result.body;
  const message = body.message ?? `Attesso refused ${body.code}.`;

  if (!body.enforced) {
    if (harness === HERMES) {
      return { stdout: `${JSON.stringify({ decision: 'allow', code: body.code })}\n`, exitCode: 0 };
    }
    if (harness === CLINE) {
      return { stdout: `${JSON.stringify({ cancel: false })}\n`, exitCode: 0 };
    }
    if (harness === GEMINI) {
      return { stdout: '{}\n', exitCode: 0 };
    }
    return { stdout: '', exitCode: 0 };
  }

  if (harness === HERMES) {
    return {
      stdout: `${JSON.stringify({ decision: 'block', message, code: body.code })}\n`,
      exitCode: 2,
    };
  }

  if (harness === CLAUDE) {
    return {
      stdout: `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: message,
        },
      })}\n`,
      exitCode: 0,
    };
  }

  if (harness === CURSOR) {
    return {
      stdout: `${JSON.stringify({
        permission: 'deny',
        user_message: message,
        agent_message: message,
      })}\n`,
      exitCode: 0,
    };
  }

  if (harness === CLINE) {
    return { stdout: `${JSON.stringify({ cancel: true, errorMessage: message })}\n`, exitCode: 0 };
  }

  if (harness === GEMINI) {
    return {
      stdout: `${JSON.stringify({ decision: 'deny', reason: message, systemMessage: message })}\n`,
      exitCode: 0,
    };
  }

  return {
    stdout: `${JSON.stringify({
      decision: 'block',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: message,
      },
      permission: 'deny',
      cancel: true,
      errorMessage: message,
      reason: message,
    })}\n`,
    exitCode: 2,
  };
}
