# Bounds

Installed as `attesso`: a local, signed ledger of what your AI agents attempted, what was allowed, and what was refused. Free and unlimited on your own machine; $0.00085 per synced decision when the record has to travel. Any action, not only payments. No account for local use, no runtime dependencies; hosted sync is the paid tier.

```sh
npx attesso init
npx attesso log --action tool.call --subject read_file --meta tokens=1200 --meta cost_usd=0.0004
npx attesso log --action purchase.execute --subject shop.example --amount 12.50 --currency EUR
npx attesso verify
npx attesso prove 2 --out receipt.json
npx attesso verify-receipt receipt.json
npx attesso packet 2 --out packet.json
npx attesso verify-packet packet.json --replay
npx attesso report
```

`init` writes `.attesso/` with an Ed25519 key, a policy, a tools allowlist and an empty ledger. `log` evaluates one proposed action against the policy, records the decision and its reason, and exits 1 when it refuses. `verify` recomputes the hash chain and every signature. `prove` writes a receipt for one entry; `verify-receipt` checks it with the public key alone, in an empty directory. `show` prints what was allowed, what was refused, which subjects dominate, and any tokens or cost you passed in `--meta`. `--dir PATH` points any command at a different ledger.

## The local UI

`attesso ui` starts a loopback-only control surface for the ledger. It shows the
day's observed flow and the exact calls behind it, reads new decisions as they
are appended, and writes mode and path changes to the same files the hook reads:

```sh
npx attesso ui
npx attesso ui --no-open
```

The server binds `127.0.0.1:8197`, mints a per-process token, and serves the page from
the installed package. It has no account, no hosted data, and no dependency on a
snapshot file. `Ctrl-C` stops it.

## Hosted sync

Hosted sync is the paid tier: it mirrors the next decisions into the Attesso
workspace so the hosted view can follow them from any machine. The local ledger
stays the source of truth. The command sends at most 50 rows per run, advances a
cursor under `.attesso/sync.json` only after the server confirms, and never sends
arguments or credentials:

```sh
npx attesso ui
# Workspace > Connect workspace, then:
npx attesso sync --dry-run
npx attesso sync
npx attesso sync --watch
```

The local UI writes the URL and key to `~/.config/attesso/config.json` with mode
0600; `sync` and `policy pull` read that file. Explicit `--url` / `--key` win,
then `ATTESSO_SYNC_URL` / `ATTESSO_API_KEY`, then the workspace config. The UI
never returns the key, and the free local tier needs no connection. **Sync now**
in the workspace panel runs the same batch as `attesso sync`.

## Hosted policy

A hosted workspace can publish its portable rule set from the dashboard. The
local engine fetches the signed bundle, verifies it against Attesso's published
JWKS and only then writes `.attesso/rules.json`; path scope stays local.

```sh
export ATTESSO_SYNC_URL=https://api.attesso.com
export ATTESSO_API_KEY=att_live_...
npx attesso policy pull --apply
```

Without `--apply` the command verifies and previews the version and digest. A
tampered signature, an unknown key or an invalid rule set writes nothing.

The API key must belong to an entitled live workspace. A retry after a failed
request is safe: the server deduplicates by device and sequence, and the local
cursor does not move until the batch is accepted. `--watch` repeats every five
seconds, so the hosted view follows a running agent without another command.

## The overview

`attesso report` is the view that answers what the thing cost and what it stopped, per task:

```
2059 entries, key 1qTU-tGyjuQwt3kI: 2058 actions, 455 refused (22%), 3,922,488 tokens, 3.1932 USD

task                                actions  refused    top              tokens     cached       cost
──────────────────────────────────  ───────  ─────────  ───────────────  ─────────  ───────────  ──────
hermes-local-9552aa28437e88c0610a…  2058     455 (22%)  PATH_DENIED×455  3,922,488  645,785,088  3.1932
```

Actions are tool calls; refusals carry the reason; tokens are input plus output, with cache reads shown separately because they bill at a different rate and dwarf the rest. Cost comes from a `llm.session` entry the recorder writes from the agent's own usage record, never from a number the report invents. `--json` gives the same data for a dashboard.

## Watch and steer

`attesso watch` follows new decisions in one terminal; `--from-seq 0` starts from
the beginning of the ledger. `pause` and `stop` refuse the next calls of one
task, while `resume` releases it. These commands work from a second terminal, so
the agent process does not need to be restarted:

```sh
npx attesso rules set-profile balanced   # migrate an existing ledger, keep rules.json.bak
npx attesso watch --from-seq 0
npx attesso pause <task> --reason "inspect the diff"
npx attesso stop <task> --reason "leave it stopped"
npx attesso control
npx attesso resume <task>
```

A pause is an explicit operator action, so it blocks even when the hook was
started with `--observe`. The ledger records a signed control entry with
`TASK_PAUSED` or `TASK_STOPPED` and the task id. The local control file is
`control.json` beside the ledger; it is steering state, not a proof of human
authority.

## Setup, explain, suggest

```sh
npx attesso setup          # detects the installed harnesses; wires Hermes
npx attesso setup --write  # also merges the observe hook into Claude Code,
                           # Codex, Gemini and Cline, preserving existing hooks
npx attesso setup --write --enforce  # same, but a refusal blocks
npx attesso setup --dry-run
npx attesso explain 42     # entry #42: rule, the step that tainted the task, what to do
npx attesso suggest        # rules the ledger's own counts justify
```

`setup` also writes an `AGENTS.md` block so the agent knows a veto is active, that a
refusal is not retryable unchanged, and how to ask about a rule that looks wrong.
`suggest` is how rules get discovered instead of configured: it counts identical
calls (same tool, same arguments) and prints a rule with the count that justifies it.

## Wire it into an agent

`attesso hook` auto-detects the caller from its event name and payload shape, then
answers in that harness's native decision shape:

| Caller | Event | Refusal |
|---|---|---|
| Hermes | `pre_tool_call` | exit 2 with a message |
| Claude Code, Codex | `PreToolUse` | `hookSpecificOutput.permissionDecision: deny` |
| Cursor | `preToolUse` | `permission: deny` with both messages |
| Cline | nested `preToolUse` | `{ cancel: true, errorMessage }` |
| Gemini | `BeforeTool` | `{ decision: deny, reason }` |

Start in observe mode so the ledger records what the rules would have refused and
nothing is blocked. In observe mode, and on an ALLOW, a native harness gets no
decision from us, so its own approval prompt still runs:

```sh
node bin/attesso.mjs --dir ~/.hermes/attesso-veto/ledger hook --observe
```

`setup --write` installs the same command in each detected harness. The Hermes
config (`~/.hermes/config.yaml`) looks like this:

```yaml
hooks:
  pre_tool_call:
    - command: npx attesso --dir ~/.attesso hook
      timeout: 10
```

Codex requires one manual trust step: run `/hooks` in Codex, review the installed
command and trust it. A changed hook definition is untrusted again. The other
harnesses load the written config on their next start.

Remove `--observe` (or run `setup --write --enforce`) when the refusal rate on your
own work looks right. Hermes then exits 2; the native harnesses get their own deny
object and the step never runs. Claude Code also gets `onFailure: block` in enforce
mode; Codex, Gemini and Cline have no equivalent field, so their own sandbox and
approval rules remain the backstop.

For a long-lived harness, `attesso serve` answers the same questions over one
process: write one JSON request per line, read one verdict per line. A decision
costs an IPC round trip instead of a process spawn.

## What it records

One signed line per proposed action:

```json
{"v":1,"seq":1,"at":"2026-10-31T12:00:00.000Z","action":"tool.call",
 "subject":"read_file","decision":"ALLOW","code":"ALLOW",
 "policy_digest":"…","rules_digest":"…","args_hash":"…",
 "kid":"…","prev":"genesis","meta":{"tokens":1200,"cost_usd":0.0004},"sig":"…"}
```

`subject` is the thing acted on: a tool name, a payee, a repo, a recipient. `rule` names the policy field or path rule behind a refusal. `args_hash` is a digest of the arguments, never the payload. `amount` appears only for money actions. Refusal codes match the hosted engine: `ACTION_MISMATCH`, `ABOVE_MAXIMUM`, `VALUE_NOT_ALLOWED`, `VALUE_MISMATCH`, `OUTSIDE_DATE_RANGE`, `REQUIRED_ATTRIBUTE_MISSING`.

In-process embedders can subscribe to the `bounds.decision` diagnostics channel. The event carries the verdict, the rule, the entry hash and the digests, never the subject, task, amount, arguments or your `meta`.

## The policy

`.attesso/policy.json` starts with `"action": "*"`, so a fresh ledger records every action; tighten it once you know what to allow. A policy governs one action; `"action": "*"` covers every action and is what a recording-only ledger uses.

```json
{ "version": 1, "action": "tool.call", "subjects": ["read_file", "search_files", "grep_repo"] }
```

```json
{
  "version": 1,
  "action": "purchase.execute",
  "currency": "EUR",
  "max_amount": 25000,
  "subjects": ["shop.example"],
  "on_or_after": "2026-11-01T00:00:00Z",
  "on_or_before": "2026-12-01T00:00:00Z"
}
```

Money is optional: without `max_amount` and `currency` the policy is judged on action, subject and window alone. Amounts in the policy are whole minor units (25000 = 250.00 EUR); `log --amount` takes the decimal form.

## Policies on paths

A single step can look fine and the sequence still be wrong: reading an untrusted page and then sending it somewhere is an exfiltration no per-step check can see. `attesso` judges an action against the path of its task, not in isolation. Three flags give it the shape of the step, and `.attesso/rules.json` says what a path may not do.

```sh
npx attesso log --action web.read   --subject docs.example         --task job-1 --trust untrusted --capability read
npx attesso log --action mail.send  --subject partner@example.com  --task job-1 --capability send
# #2 DENY mail.send partner@example.com (PATH_DENIED by step #1 under no-send-after-untrusted-read)

npx attesso log --action file.read  --subject src/app.ts           --task job-2 --trust internal  --capability read
npx attesso log --action mail.send  --subject partner@example.com  --task job-2 --capability send
# #4 ALLOW mail.send partner@example.com (ALLOW)
```

`init` ships the balanced profile:

```json
{ "version": 1,
  "rules": [
    { "id": "no-send-after-untrusted-read",
      "deny": { "capabilities": ["send"] },
      "if_path": { "trust": "untrusted", "capability": "read", "within_minutes": 30 } },
    { "id": "no-repeat-web-extract",
      "deny": { "capabilities": ["read"] },
      "if_path": { "capability": "read", "subject": "web_extract",
                   "same_arguments": true, "within_minutes": 30 } }
  ] }
```

Balanced blocks the outbound boundary and duplicate fetches; it leaves local edits and commands alone. For an untrusted environment where a shell command itself can exfiltrate, `init --profile strict` adds `write` and `execute` to the deny list. An existing ledger can adopt either shipped profile with `attesso rules set-profile balanced|strict`; the previous file is kept as `rules.json.bak`.

File tools can also be scoped by `paths.json`. Shell and execute tools remain
unscoped by default. A deployment that wants the hook to refuse every execute
capability can set `"shell_scope": "deny"` in `paths.json`; that is a denial,
not a command sandbox.

`--task` scopes the history, so one job cannot taint another. `within_minutes` limits how long a read stays relevant; without it a taint lasts for the whole task. `--capability` is one of `read`, `write`, `send`, `execute`, `spend`. The refusal names the rule and the step that tainted the path, so a reader can see the sequence rather than a verdict.

Rules are ordinary files you own and version. Run them in observe mode first: `node scripts/hermes-ledger.mjs --observe` records what the rules would have refused without touching the agent, which is how you learn where a rule is too broad before it costs you a day.

## Pin the MCP surface

A tool call is judged by name unless you pin the definitions you reviewed. `tools pin` hashes each supplied tool's full definition and the current `.attesso/tools.json`:

```sh
npx attesso tools pin --manifest tools.manifest.json
npx attesso tools verify --manifest tools.manifest.json
```

The manifest is the harness's own `{ "tools": [ { "name", "description", "inputSchema", "outputSchema", "annotations" } ] }` list. A caller that knows the definition can send `tool_definition_hash` with the call; a matching pin is recorded as `tool_pin: verified`, a changed one is refused as `TOOL_CHANGED`, and a call without a hash is recorded as `unverified`.

For an MCP server, use the bundled stdio adapter instead of wiring the manifest by hand:

```sh
# 1. Ask the server for its identity, instructions, tools, prompts and resources.
npx attesso-mcp --print-manifest -- npx -y @modelcontextprotocol/server-everything > mcp.manifest.json

# 2. Review it, then pin the whole surface.
npx attesso tools pin --manifest mcp.manifest.json

# 3. Put the adapter in front of the same server.
npx attesso-mcp --dir .attesso -- npx -y @modelcontextprotocol/server-everything
```

The adapter speaks both stdio protocol eras: the 2026-07-28 stateless discovery shape and the older `initialize` handshake. Pin the era your client uses; `--era legacy` forces the handshake when a dual-era server would otherwise be discovered as modern. It refuses a changed server identity, instructions, tool, prompt, resource or resource template before the client sees it, refuses a changed or unpinned tool before the call reaches the server, and refuses server-initiated sampling, elicitation and roots requests. Every allowed call is recorded in the signed ledger; `export` carries the pinned manifest and the tool lock, so `verify-bundle` can check the evidence in an empty directory. It is stdio only; remote HTTP servers and generic MCP gateway features are out of scope.

Before tightening a policy, replay the ledger against the candidate file:

```sh
npx attesso replay --policy next-policy.json --max-newly-denied 0
```

Every recorded proposal is re-judged with the history that preceded it. The summary names how many decisions would flip, and `--max-newly-denied` turns a budget into an exit code, so a pull request can refuse a rule that would have blocked real work. Replay is a diagnostic: it uses the history the ledger holds and does not prove that history is complete.

## Control the local configuration over MCP

The bundled `attesso-control-mcp` is a control surface, not a second proxy:

```sh
npx attesso-control-mcp --dir .attesso
```

It speaks stdio only and answers both the legacy `initialize` handshake and the
2026-07-28 direct request shape. It exposes `bounds_status`,
`bounds_connect`, `bounds_mode`, `bounds_paths_get` and `bounds_paths_set`.
Connect and mode are limited to `observe` and `off`; enforcement and path
widening require the human CLI (`npx attesso mode enforce`,
`npx attesso paths --set`). It has no HTTP listener and no network access.
`attesso-mcp` remains the upstream tool proxy.

## Recording a real agent

`attesso` is a CLI, so anything that can run a command can record an action. To see what a Hermes session actually did, the repo ships `scripts/hermes-ledger.mjs`, which reads a session from `state.db` read-only and appends one entry per tool call.

```sh
node scripts/hermes-ledger.mjs --dir .hermes/tmp/attesso-dogfood --observe
npx attesso --dir .hermes/tmp/attesso-dogfood show
```

`--observe` labels every verdict the rules produced and prints how many steps they would have refused; nothing in the agent is blocked. Tool calls are classified on the way in by `.attesso/tools.json`: allowlisted names are internal, anything else is an untrusted read. Add your own tools there; an unlisted tool taints the task rather than being trusted.

## Portable evidence

```sh
npx attesso prove 2 --out receipt.json          # one entry, its path, a signed head
npx attesso verify-receipt receipt.json         # public key only, no ledger
npx attesso packet 2 --out packet.json          # named envelope around the bundle
npx attesso verify-packet packet.json --replay  # verify and replay in an empty dir
npx attesso checkpoint --out head.json          # keep this off the machine
npx attesso verify --pin head.json              # refuse a rewrite below the pin
npx attesso export 2 --out bundle.json          # receipt plus policy and rules
npx attesso verify-bundle bundle.json --replay  # re-run the recorded verdict
```

A receipt is about 1.5 KB at ten thousand entries. A bundle adds the exact policy and rules bytes, so `--replay` recomputes the verdict instead of trusting the log; it replays against the history it carries, and does not prove that history is complete. The pin is what an attacker holding the key cannot re-derive. Store `head.json` on another device, or in a repository the agent cannot write; a pin stored beside the ledger is not independent. A packet is a named envelope around one bundle with a title, a digest and a summary of the task; it is the artifact to hand to another person. The receipt still proves integrity, not authority; see below.

## What this proves, and what it does not

The signature proves the ledger was not edited after the fact: change one byte and `verify` names the entry, reorder two and the chain breaks, delete the last one and the recorded head no longer matches.

Each append is fsynced and the head is written after its line. On Linux that is a local-disk guarantee. On macOS Node cannot issue F_FULLFSYNC, so a power cut can still lose the last write even on APFS; a network filesystem has the same limit. The recorded head then refuses the next append instead of guessing.

A receipt proves one entry sits in the tree whose head this key signed, and a pin proves the log was not rewritten below a head you kept elsewhere. Neither proves a human authorized anything. The signing key lives in `.attesso/key.json`, in the same directory as the log, so anything that can write the log can also write a new one. It cannot see absence either: a process that deletes the whole directory leaves nothing to verify.

Hosted Attesso is where authority lives: a passkey approval binds a named human to exact terms, the decision and the refusal are recorded server-side, and the result is evidence a third party verifies offline against a published key. The local ledger uses the same event and code vocabulary, so it can be submitted there later.

## Exit codes

`0` allowed or verified, `1` refused or a failed verification, `2` usage error.

## License

Apache-2.0.
