// A refusal that does not say what would pass is a retry trap. One measured
// ledger has the same call refused 106 times, and 333 refusals recorded after a
// run budget had already stopped the work: the gate was right and the agent had
// nothing to act on. Every deny therefore carries one word from a closed list,
// so a harness can branch on it without parsing prose.
export const REMEDIES = Object.freeze([
  'change_arguments',
  'raise_budget',
  'resume_task',
  'request_approval',
  'stop',
]);

const BY_CODE = Object.freeze({
  // The call can pass with different arguments or a different target.
  ACTION_MISMATCH: 'change_arguments',
  REQUIRED_ATTRIBUTE_MISSING: 'change_arguments',
  VALUE_NOT_ALLOWED: 'change_arguments',
  VALUE_MISMATCH: 'change_arguments',
  ABOVE_MAXIMUM: 'change_arguments',
  OUTSIDE_DATE_RANGE: 'change_arguments',
  REPEAT_LIMIT: 'change_arguments',
  PATH_SCOPE_DENIED: 'change_arguments',
  PATH_REQUIRED: 'change_arguments',
  SHELL_SCOPE_DENIED: 'change_arguments',
  // The action is not wrong, the situation is: a human has to decide or re-pin.
  PATH_DENIED: 'request_approval',
  TOOL_CHANGED: 'request_approval',
  // Nothing about the call can change this verdict; the run may be widened.
  BUDGET_EXCEEDED: 'raise_budget',
  TASK_PAUSED: 'resume_task',
  TASK_STOPPED: 'resume_task',
  // The verdict is terminal or cannot be answered: stop, and say so.
  STEP_LIMIT: 'stop',
  CONTROL_UNAVAILABLE: 'stop',
  DECISION_UNAVAILABLE: 'stop',
  EXECUTION_WINDOW_ENDED: 'stop',
});

// An unknown code is a code this build cannot reason about, so the safe word is
// the one that stops the loop rather than the one that invites a rewrite.
export function remedyFor(code) {
  return BY_CODE[code] ?? 'stop';
}
