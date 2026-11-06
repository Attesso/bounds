# Changelog

The record of what shipped. Dates are the npm publish day. The public update log
on attesso.com/bounds renders the same history from
`apps/www/src/content/bounds-releases.ts`; this file is the copy that travels
with the package.

## 0.13.3 - 6 November 2026

- Every refusal now carries a `remedy` from a closed list: `change_arguments`,
  `raise_budget`, `resume_task`, `request_approval` or `stop`. It rides in the
  hook and `serve` answer for every harness, so an agent can act on the verdict
  instead of repeating the call. One measured ledger has the same call refused
  106 times; a refusal with no next step is why.
- A sparse array now serialises as `null`, never as an empty slot. `map` kept
  holes, so `{a:[,1]}` signed `{"a":[,1]}`, which is not JSON; a payload built
  that way could never be verified.
- A broken file is named in the refusal: `Attesso could not read policy.json`
  where it used to blame the ledger for every parse failure.
- Control bytes are dropped when a recorded subject is printed. The ledger still
  stores the bytes the agent sent; `show`, `log` and the JSON report can no
  longer be made to repaint a terminal.
- A call refused at its repeat ceiling three times stops the task instead of
  being refused forever. The verdict is `TASK_STOPPED`, the control file records
  why, and the remedy is `resume_task`, so the human who changes the rule or the
  task is the one who restarts it. Observe mode records the verdict without
  steering the task.

## 0.13.2

- `canonical()` now serialises exactly what the writer stores. It drops an
  `undefined` member, turns an array hole and a non-finite number into `null`,
  honours `toJSON`, and throws on a BigInt or a cycle instead of signing
  something else. The old form signed a payload the file could not hold, which
  is what made the ledger of 4 November 2026 unverifiable from entry 4752 on.
- `verify` reports scope: how many entries before a broken one still verify, so
  a single damaged row no longer reads as a lost record.
- A torn final line is announced instead of passing as a clean chain.
- Usage rows and run markers write `ALLOW`, the same code as every other allow.
- `status` names the mode file it read and warns when a second one disagrees
  with it, with the command that realigns both.
- `attesso --version` (also `-v`, `-V`, `version`) prints the installed version
  instead of dumping the help and exiting 2.
- The ledger config records the engine version that wrote it, so a record can
  name the build that judged it. Existing ledgers are stamped on the next write
  and keep the first engine they recorded.
- `engines` requires Node 22, the floor the code already used.

## 0.13.1

- A read-only release check runs before a publish.
- The ledger is read by byte range, and a preview read fails closed.
- Preview capture is fuzzed over 2,000 seeded inputs.

## 0.13.0

- Run boundaries: a signed run start and end, with an outcome.
- A per-run budget in tokens or dollars, enforced on the next call.
- A local redacted preview per tool call, read with `attesso detail`.
- A rule can block while the rest of the file keeps observing.

## Earlier

- **0.12.3** a rule stops firing on fields the entry never had; the 24-hour
  decision summary is documented.
- **0.12.2** a usage entry signs without a phantom model field.
- **0.12.1** two writers can no longer reclaim the same dead lock at once.
- **0.12.0** hosted review and decision views; measured token usage from the
  hook payload; a whole day can be exported.
- **0.11.1** the source repository and its test workflow are published.
- **0.11.0** packets and workspace setup from the local control surface.
- **0.10.0** rule drafts stay scoped to their day; export waits for a draft.
- **0.9.0** hosted policy bundles are pulled and verified before they apply.
- **0.8.0** `sync --watch` keeps the hosted mirror current.
- **0.7.1** the sync cursor restarts when the ledger key changes.
- **0.7.0** a cursor, batches and a device id: the ledger mirrors to a workspace.
- **0.6.1** the first-run setup hint stops repeating.
- **0.6.0** bounded day and cursor queries, strict shell scope, a stdio control
  server.
- **0.4.1** `setup`, `explain` and `suggest`; ceilings on a task; the package is
  named Bounds.
- **0.4.0** veto a tool call before it runs, from any harness.
- **0.3.1** republish; no package change recorded.
- **0.3.0** rules judge the path of a task; any action can be logged; the
  overview.
- **0.0.1** a local signed ledger people can install and verify.
