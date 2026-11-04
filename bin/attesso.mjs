#!/usr/bin/env node
// attesso: a local, signed ledger of what your agents attempted.
//
//   attesso init
//   attesso log --action tool.call --subject read_file --meta tokens=1200 --meta cost_usd=0.0004
//   attesso log --action purchase.execute --subject shop.example --amount 12.50 --currency EUR
//   attesso verify
//   attesso show
import { verifyChain } from './../src/ledger.mjs';
import { bundleFor, verifyBundle } from './../src/bundle.mjs';
import { packetFor, verifyPacket } from './../src/packet.mjs';
import { resolveWorkspace } from './../src/workspace.mjs';
import { formatMinor, toMinor, validatePolicy } from './../src/policy.mjs';
import { checkpointFor, receiptFor, signerOf, verifyPinned, verifyReceipt } from './../src/receipt.mjs';
import { append, appendUsage, init, isInitialised, paths, readState, readToolLock, setRulesProfile, verifyLedger, withLedgerLock, writeMcpManifest, writeToolLock } from './../src/store.mjs';
import { buildReportStream, renderReport } from './../src/report.mjs';
import { replay, renderReplay } from './../src/replay.mjs';
import { watchEntries } from './../src/watch.mjs';
import { serve } from './../src/serve.mjs';
import { createHookDecider } from './../src/hook.mjs';
import { HARNESSES, normalizeHookPayload, renderHook } from './../src/harness.mjs';
import { clearTaskControl, listControl, setTaskControl } from './../src/control.mjs';
import { detectHarnesses, explain, suggest, writeAgentContext } from './../src/setup.mjs';
import { CONNECT_MODES, connect as connectAgent, readMode, setModeAll, status as agentStatus } from './../src/connect.mjs';
import { wireHarness } from './../src/install.mjs';
import { loadTools } from './../src/classify.mjs';
import { comparePin, pinManifest } from './../src/toolpin.mjs';
import { flags, parseMeta, publicKey, readJsonFile, writeJsonOut } from './../src/cli-io.mjs';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CAPABILITIES, TRUST_LEVELS, validateRules } from './../src/rules.mjs';
import { validatePathsConfig } from './../src/fs-paths.mjs';
import { startUi } from './../src/ui/server.mjs';
import { sync, watchSync } from './../src/sync.mjs';
import { pullPolicy } from './../src/remote-policy.mjs';

const argv = process.argv.slice(2);
const dirAt = argv.indexOf('--dir');
const DIR = dirAt === -1 ? '.attesso' : argv[dirAt + 1];
if (dirAt !== -1) argv.splice(dirAt, 2);

const USAGE = `attesso: a local, signed ledger of what your agents attempted

  attesso init [--dir PATH] [--profile balanced|strict]
                                     create .attesso with a key and a policy
  attesso log --action A [--subject S] [--amount 12.50 --currency EUR]
              [--task T] [--trust internal|untrusted] [--capability read|write|send|execute|spend]
              [--meta k=v ...] [--json]
                                     evaluate one proposed action against the policy
                                     and the path of its task, then record it
  attesso verify                     recompute the chain and report the first defect
  attesso verify --pin PATH          also check the log extends a pinned checkpoint
  attesso rules set-profile balanced|strict
                                     adopt a shipped rule profile, keeping the old file as .bak
  attesso pause <task> [--reason TEXT]  refuse the next actions of one task
  attesso stop <task> [--reason TEXT]   refuse one task until it is resumed
  attesso resume <task>                 release a paused or stopped task
  attesso control [--json]              list paused and stopped tasks
  attesso watch [--from-seq N] [--task ID] [--json]
                                     follow new decisions in one terminal
  attesso prove <seq> [--out PATH]   a portable receipt for one entry
  attesso verify-receipt PATH [--key PATH]
                                     verify a receipt offline; no ledger needed
  attesso checkpoint [--out PATH]    a signed head you can keep off this machine
  attesso export <seq> [--out PATH]  entry, receipt, policy and rules in one bundle
  attesso verify-bundle PATH [--replay]
                                     verify a bundle offline, and re-run the verdict
  attesso packet <seq> [--out PATH] [--title TEXT]
                                     a named packet around the bundle, ready to share
  attesso verify-packet PATH [--replay]
                                     verify a packet in an empty directory
  attesso show                       what was allowed, what was refused, and why
  attesso report [--json]            per task: actions, refusals with reasons, tokens and cost
  attesso replay [--policy PATH] [--rules PATH] [--json]
              [--max-newly-denied N] re-judge the whole ledger under a candidate policy;
                                     exit 1 when the gate is exceeded
  attesso serve [--observe]          long-lived: one JSON request per line in, one verdict out
  attesso hook [--observe]           harness hook: one tool call on stdin, native refusal on stdout
  attesso setup [--write] [--enforce] [--dry-run]
                                     detect a harness, wire the hook, write the agent block
  attesso connect [--write] [--mode observe|enforce|off] [--harness KEY] [--json]
                                     self-service: init, mode, hook and AGENTS.md
  attesso status [--json]           connection, mode and wired harnesses
  attesso mode [observe|enforce|off]  read or set the active hook mode
  attesso paths [--json|--set FILE]   read or replace the filesystem scope
  attesso ui [--port N] [--no-open]    local control surface for the signed ledger
                                     (default 127.0.0.1:8197)
  attesso policy pull [--url URL] [--apply] [--json]
                                     verify the hosted rule bundle and optionally
                                     write rules.json (workspace config or ATTESSO_API_KEY)
  attesso sync [--url URL] [--limit N] [--json] [--dry-run] [--watch]
                                     sync decisions and usage to the hosted mirror
                                     --watch keeps it current every 5 seconds
                                     (workspace config or ATTESSO_API_KEY; never printed)
  attesso usage [--stdin] [--task T] [--input N] [--output N] [--cached N]
                 [--cost USD] [--model M] [--json]
                                     record measured token usage for a task; --stdin
                                     reads a harness hook payload
  attesso explain <seq>              one entry in full: rule, tainting step, what to do
  attesso suggest [--json]           rules the ledger's own counts justify
  attesso tools pin --manifest PATH  pin the tool definitions a decision was made under
  attesso tools verify --manifest PATH
                                     compare the pinned definitions with the manifest

Any action can be logged, not only payments. --subject is the thing acted on (a
tool name, a payee, a repo). --task scopes the path, --trust marks where the
content came from, and --capability says what the step does; with those three, a
rule in .attesso/rules.json can refuse a send that follows an untrusted read,
which no per-step check can see. --meta carries whatever you want counted later
(tokens, cost_usd, duration_ms, model).

The log is signed with a key that lives in .attesso/key.json. That proves the
ledger was not edited; it does not prove a human authorized anything. Hosted
Attesso adds passkey approval and evidence a third party verifies offline.`;

function requireLedger() {
  if (!isInitialised(DIR)) {
    console.error(`no ledger at ${paths(DIR).dir}; run attesso init first`);
    process.exit(2);
  }
}

function describe(entry) {
  const subject = entry.subject ? ` ${entry.subject}` : '';
  const amount = entry.amount ? ` ${formatMinor(entry.amount.minor, entry.amount.currency)} ${entry.amount.currency}` : '';
  return `${entry.action}${subject}${amount}`;
}

function renderWatchEntry(entry) {
  const at = typeof entry.at === 'string' ? entry.at.slice(11, 19) : '--:--:--';
  const rule = entry.rule ? ` ${entry.rule}` : '';
  const control = entry.control ? ` control=${entry.control.mode}` : '';
  const task = entry.task ? ` task=${String(entry.task).slice(0, 12)}` : '';
  return `#${entry.seq} ${at} ${String(entry.decision).padEnd(5)} ${entry.subject ?? '(none)'} ${entry.capability ?? ''} ${entry.code}${rule}${task}${control}`;
}

function toolsCommand(rest) {
  requireLedger();
  const [subcommand, ...args] = rest;
  const options = flags(args);
  if ((subcommand !== 'pin' && subcommand !== 'verify') || typeof options.manifest !== 'string') {
    console.error('usage: attesso tools pin|verify --manifest PATH');
    process.exit(2);
  }
  const manifest = readJsonFile(options.manifest, 'tools');
  try {
    const tools = loadTools(DIR);
    if (subcommand === 'pin') {
      const pin = pinManifest(manifest, tools);
      writeMcpManifest(DIR, manifest);
      writeToolLock(DIR, pin);
      const surfaces = ['server', 'prompts', 'resources', 'resource_templates'].filter((field) => pin[`${field}_digest`]);
      console.log(`pinned ${Object.keys(pin.tools).length} tools${surfaces.length ? ` and ${surfaces.join(', ')}` : ''}; tools digest ${pin.tools_digest}`);
      return;
    }
    const lock = readToolLock(DIR);
    if (!lock) {
      console.error('no tool pin at .attesso/tools.lock.json; run attesso tools pin first');
      process.exit(1);
    }
    const result = comparePin(lock, manifest, tools);
    if (!result.ok) {
      if (result.digestChanged) console.error('tools.json changed since the pin');
      for (const name of result.changed) console.error(`changed tool: ${name}`);
      for (const name of result.added) console.error(`added tool: ${name}`);
      for (const name of result.removed) console.error(`removed tool: ${name}`);
      for (const surface of result.surfaces) console.error(`changed ${surface} surface`);
      process.exit(1);
    }
    console.log(`tool pin verifies: ${Object.keys(lock.tools).length} tools`);
  } catch (error) {
    console.error(`tools: ${error.message}`);
    process.exit(1);
  }
}

function log(argv) {
  requireLedger();
  const options = flags(argv);
  if (typeof options.action !== 'string') {
    console.error('attesso log needs --action');
    process.exit(2);
  }
  if ((options.amount === undefined) !== (options.currency === undefined)) {
    console.error('--amount and --currency go together');
    process.exit(2);
  }
  let amount;
  if (options.amount !== undefined) {
    try {
      amount = { minor: toMinor(options.amount, options.currency), currency: options.currency };
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  }
  let meta;
  try {
    meta = parseMeta(options.meta);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  if (options.trust !== undefined && !TRUST_LEVELS.includes(options.trust)) {
    console.error(`--trust takes ${TRUST_LEVELS.join(', ')}`);
    process.exit(2);
  }
  if (options.capability !== undefined && !CAPABILITIES.includes(options.capability)) {
    console.error(`--capability takes ${CAPABILITIES.join(', ')}`);
    process.exit(2);
  }
  const entry = append(DIR, {
    action: options.action,
    subject: options.subject,
    amount,
    meta,
    task: typeof options.task === 'string' ? options.task : undefined,
    trust: options.trust,
    capability: options.capability,
  });
  if (options.json) {
    console.log(JSON.stringify(entry));
    return;
  }
  const taint = entry.tainted_by === undefined ? '' : ` by step #${entry.tainted_by} under ${entry.rule}`;
  console.log(`#${entry.seq} ${entry.decision} ${describe(entry)} (${entry.code}${taint})`);
  process.exitCode = entry.decision === 'ALLOW' ? 0 : 1;
}

function verify(rest = []) {
  requireLedger();
  const options = flags(rest);
  if (options.pin !== undefined) {
    let state;
    let result;
    try {
      // Verify a snapshot, not a writer's in-flight line: the lock makes the
      // line and the head it belongs to visible together.
      state = withLedgerLock(DIR, () => readState(DIR));
      result = verifyChain(state.entries, state.key.public, state.config.head);
    } catch {
      // A read-only archive cannot take the lock; there is no writer to race.
      state = readState(DIR);
      result = verifyChain(state.entries, state.key.public, state.config.head);
    }
    if (!result.ok) {
      console.error(`ledger does not verify: ${result.reason}`);
      process.exit(1);
    }
    console.log(`ledger verifies: ${result.reason}, key ${state.key.kid}`);
    const pinned = readJsonFile(options.pin, 'verify --pin');
    const check = verifyPinned(state.entries, pinned, state.key.public);
    if (!check.ok) {
      console.error(`pinned head does not verify: ${check.reason}`);
      process.exit(1);
    }
    console.log(`pinned head: ${check.reason}`);
    return;
  }
  return (async () => {
    let result;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      result = await verifyLedger(DIR);
      if (result.ok) break;
      // A writer can be between its signed line and the head update. The lock
      // used to hide that window; a streamed read waits it out instead.
      if (!/more .* than the recorded head|last entry does not match|Unexpected end of JSON input|Unexpected token|Expected property name/.test(result.reason)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!result.ok) {
      console.error(`ledger does not verify: ${result.reason}`);
      process.exit(1);
    }
    console.log(`ledger verifies: ${result.reason}, key ${result.kid}`);
  })();
}

function prove(rest) {
  requireLedger();
  const options = flags(rest);
  const seq = Number(rest[0]);
  const state = readState(DIR);
  const index = state.entries.findIndex((entry) => entry.seq === seq);
  if (index === -1) {
    console.error(`no entry #${seq} in this ledger`);
    process.exit(1);
  }
  writeJsonOut(DIR, receiptFor(state.entries, index, signerOf(state.key)), options.out);
}

function checkpoint(rest) {
  requireLedger();
  const options = flags(rest);
  const state = readState(DIR);
  writeJsonOut(DIR, checkpointFor(state.entries, signerOf(state.key)), options.out);
}

function verifyReceiptCommand(rest) {
  const options = flags(rest);
  const file = rest[0];
  if (!file) {
    console.error('attesso verify-receipt <file>');
    process.exit(2);
  }
  const receipt = readJsonFile(file, 'verify-receipt');
  const result = verifyReceipt(receipt, options.key ? publicKey(options.key) : receipt.key);
  if (!result.ok) {
    console.error(`receipt does not verify: ${result.reason}`);
    process.exit(1);
  }
  const trust = options.key ? '' : ' (against the key embedded in the receipt; pass --key to pin a trusted one)';
  console.log(`receipt verifies: ${result.reason}${trust}`);
}

function totals(entries) {
  const sum = (field) =>
    entries.reduce((total, entry) => total + (Number(entry.meta?.[field]) || 0), 0);
  const tokens = sum('tokens');
  const cost = sum('cost_usd');
  const parts = [];
  if (tokens > 0) parts.push(`${tokens.toLocaleString('en-US')} tokens`);
  if (cost > 0) parts.push(`${cost.toFixed(4)} USD`);
  return parts.length > 0 ? `, ${parts.join(', ')}` : '';
}

function show() {
  requireLedger();
  const { entries, key } = readState(DIR);
  if (entries.length === 0) {
    console.log('no decisions yet');
    return;
  }
  const counts = new Map();
  for (const entry of entries) {
    const label = `${entry.decision} ${entry.code}`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const allowed = entries.filter((entry) => entry.decision === 'ALLOW').length;
  console.log(
    `${entries.length} decisions: ${allowed} allowed, ${entries.length - allowed} refused${totals(entries)} (key ${key.kid})`,
  );
  for (const [label, count] of [...counts.entries()].sort()) {
    console.log(`  ${String(count).padStart(4)}  ${label}`);
  }
  const bySubject = new Map();
  for (const entry of entries) {
    const label = entry.subject ?? '(none)';
    bySubject.set(label, (bySubject.get(label) ?? 0) + 1);
  }
  if (bySubject.size > 0 && [...bySubject.keys()].some((label) => label !== '(none)')) {
    console.log('subjects:');
    for (const [label, count] of [...bySubject.entries()].sort((left, right) => right[1] - left[1])) {
      console.log(`  ${String(count).padStart(4)}  ${label}`);
    }
  }
  console.log('latest:');
  for (const entry of entries.slice(-5)) {
    console.log(`  #${entry.seq} ${entry.at} ${entry.decision} ${describe(entry)} (${entry.code})`);
  }
}

const [command, ...rest] = argv;

process.on('uncaughtException', (error) => {
  if (process.env.ATTESSO_DEBUG) throw error;
  console.error(`attesso: ${error.message}`);
  process.exit(1);
});

switch (command) {
  case 'init': {
    try {
      const options = flags(rest);
      const result = init(DIR, { profile: typeof options.profile === 'string' ? options.profile : 'balanced' });
      console.log(`created ${result.dir} with key ${result.kid} (${result.profile} rules)`);
      console.log(`review ${paths(DIR).policy}, ${paths(DIR).rules} and ${paths(DIR).tools} before enforcing`);
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
    break;
  }
  case 'log':
    log(rest);
    break;
  case 'verify':
    await verify(rest);
    break;
  case 'rules': {
    requireLedger();
    const [subcommand, ...args] = rest;
    const options = flags(args);
    const profile = typeof options.profile === 'string' ? options.profile : args.find((arg) => !arg.startsWith('--'));
    if (subcommand !== 'set-profile' || typeof profile !== 'string') {
      console.error('usage: attesso rules set-profile balanced|strict');
      process.exit(2);
    }
    try {
      const result = setRulesProfile(DIR, profile);
      const state = result.changed ? 'updated' : 'already current';
      console.log(`rules ${result.profile}: ${state}; digest ${result.digest}`);
    } catch (error) {
      console.error(`rules: ${error.message}`);
      process.exit(2);
    }
    break;
  }
  case 'checkpoint':
    checkpoint(rest);
    break;
  case 'pause':
  case 'stop': {
    requireLedger();
    const options = flags(rest);
    const task = rest.find((arg) => !arg.startsWith('--'));
    if (!task) {
      console.error(`usage: attesso ${command} <task> [--reason TEXT]`);
      process.exit(2);
    }
    try {
      const result = setTaskControl(DIR, task, command, { reason: options.reason });
      console.log(`${command} ${result.task}: ${result.mode} at ${result.at}`);
    } catch (error) {
      console.error(`${command}: ${error.message}`);
      process.exit(2);
    }
    break;
  }
  case 'resume': {
    requireLedger();
    const task = rest.find((arg) => !arg.startsWith('--'));
    if (!task) {
      console.error('usage: attesso resume <task>');
      process.exit(2);
    }
    try {
      const changed = clearTaskControl(DIR, task);
      console.log(changed ? `resumed ${task}` : `${task} was not paused or stopped`);
    } catch (error) {
      console.error(`resume: ${error.message}`);
      process.exit(2);
    }
    break;
  }
  case 'control': {
    requireLedger();
    const options = flags(rest);
    try {
      const tasks = listControl(DIR);
      if (options.json) {
        console.log(JSON.stringify(tasks));
        break;
      }
      if (tasks.length === 0) {
        console.log('no paused or stopped tasks');
        break;
      }
      for (const item of tasks) {
        console.log(`${item.task}\t${item.mode}\t${item.at}${item.reason ? `\t${item.reason}` : ''}`);
      }
    } catch (error) {
      console.error(`control: ${error.message}`);
      process.exit(2);
    }
    break;
  }
  case 'prove':
    prove(rest);
    break;
  case 'verify-receipt':
    verifyReceiptCommand(rest);
    break;
  case 'export': {
    requireLedger();
    const options = flags(rest);
    try {
      writeJsonOut(DIR, bundleFor(DIR, rest[0]), options.out);
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
    break;
  }
  case 'packet': {
    requireLedger();
    const options = flags(rest);
    const seq = Number(rest.find((arg) => !arg.startsWith('--')));
    if (!Number.isInteger(seq) || seq <= 0) {
      console.error('usage: attesso packet <seq> [--out PATH] [--title TEXT]');
      process.exit(2);
    }
    try {
      writeJsonOut(DIR, packetFor(DIR, seq, { title: options.title }), options.out);
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
    break;
  }
  case 'verify-packet': {
    const options = flags(rest);
    const file = rest.find((arg) => !arg.startsWith('--'));
    if (!file) {
      console.error('usage: attesso verify-packet <file> [--key PATH] [--replay]');
      process.exit(2);
    }
    try {
      const packet = readJsonFile(file, 'verify-packet');
      const result = verifyPacket(packet, {
        replay: options.replay === true,
        publicPem: options.key ? publicKey(options.key) : undefined,
      });
      if (!result.ok) {
        console.error(`packet does not verify: ${result.reason}`);
        process.exit(1);
      }
      console.log(`packet verifies: ${result.reason}`);
    } catch (error) {
      console.error(`verify-packet: ${error.message}`);
      process.exit(2);
    }
    break;
  }
  case 'verify-bundle': {
    const options = flags(rest);
    const file = rest[0];
    if (!file) {
      console.error('attesso verify-bundle <file>');
      process.exit(2);
    }
    const bundle = readJsonFile(file, 'verify-bundle');
    const result = verifyBundle(bundle, {
      replay: options.replay === true,
      publicPem: options.key ? publicKey(options.key) : undefined,
    });
    if (!result.ok) {
      console.error(`bundle does not verify: ${result.reason}`);
      process.exit(1);
    }
    const note = result.historical ? ' (historical entry: no rules digest)' : '';
    console.log(`bundle verifies: ${result.reason}${note}`);
    break;
  }
  case 'show':
    show();
    break;
  case 'watch': {
    requireLedger();
    const options = flags(rest);
    const raw = options['from-seq'];
    const fromSeq = raw === undefined ? Number.MAX_SAFE_INTEGER : Number(raw);
    if (!Number.isInteger(fromSeq) || fromSeq < 0) {
      console.error('--from-seq takes a whole sequence number');
      process.exit(2);
    }
    if (options.task !== undefined && typeof options.task !== 'string') {
      console.error('--task takes a task id');
      process.exit(2);
    }
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    try {
      for await (const entry of watchEntries(DIR, {
        fromSeq,
        task: options.task,
        signal: controller.signal,
      })) {
        console.log(options.json ? JSON.stringify(entry) : renderWatchEntry(entry));
      }
    } catch (error) {
      console.error(`watch: ${error.message}`);
      process.exitCode = 1;
    } finally {
      process.removeListener('SIGINT', stop);
    }
    break;
  }
  case 'connect': {
    try {
      const options = flags(rest);
      const mode = typeof options.mode === 'string'
        ? options.mode
        : options.off ? 'off' : options.enforce ? 'enforce' : options.observe ? 'observe' : 'observe';
      const result = connectAgent({
        dir: DIR,
        cwd: process.cwd(),
        cli: resolve(process.argv[1]),
        write: rest.includes('--write'),
        mode,
        harness: typeof options.harness === 'string' ? options.harness : null,
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`mode: ${result.mode ?? 'unset'}`);
        console.log(`ledger: ${result.initialized ? result.ledger : 'not initialized'}`);
        for (const harness of result.harnesses) {
          const state = harness.applied ? 'wired' : harness.dryRun ? 'would wire' : harness.wired || harness.reason === 'already wired' ? 'already wired' : harness.error || harness.reason || 'manual';
          console.log(`${harness.key}: ${state}`);
          for (const warning of harness.warnings ?? []) console.log(`  note: ${warning}`);
        }
        if (result.manual.length) console.log(`manual: ${result.manual.join(', ')}`);
        for (const line of result.next) console.log(`next: ${line}`);
      }
      if (!result.initialized && rest.includes('--write')) process.exitCode = 1;
    } catch (error) {
      console.error(`connect: ${error.message}`);
      process.exit(2);
    }
    break;
  }
  case 'status': {
    try {
      const options = flags(rest);
      const result = agentStatus({ dir: DIR, cwd: process.cwd() });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`connected: ${result.connected ? 'yes' : 'no'}`);
        console.log(`mode: ${result.mode ?? 'unset'}`);
        console.log(`ledger: ${result.ledger ?? 'not initialized'}`);
        for (const harness of result.harnesses) console.log(`${harness.key}: ${harness.wired ? 'wired' : 'not wired'}`);
      }
    } catch (error) {
      console.error(`status: ${error.message}`);
      process.exit(2);
    }
    break;
  }
  case 'mode': {
    try {
      const options = flags(rest);
      const desired = typeof options.mode === 'string' ? options.mode : rest.find((value) => !value.startsWith('--'));
      if (desired === undefined) {
        const current = readMode(DIR);
        if (options.json) console.log(JSON.stringify({ mode: current }));
        else console.log(`mode: ${current ?? 'unset'}`);
        break;
      }
      if (!CONNECT_MODES.includes(desired)) {
        console.error(`mode takes ${CONNECT_MODES.join(', ')}`);
        process.exit(2);
      }
      const result = setModeAll(DIR, desired);
      if (options.json) console.log(JSON.stringify({ mode: result }));
      else console.log(`mode: ${result}`);
    } catch (error) {
      console.error(`mode: ${error.message}`);
      process.exit(2);
    }
    break;
  }
  case 'paths': {
    try {
    const options = flags(rest);
    const file = paths(DIR).fsPaths;
    if (options.set) {
      const value = validatePathsConfig(readJsonFile(options.set, 'paths'));
      mkdirSync(DIR, { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, file);
      if (options.json) console.log(JSON.stringify({ ok: true, paths: value }, null, 2));
      else console.log(`paths: ${value.allowed_roots.length} roots, ${value.exclusions.length} exclusions`);
      break;
    }
    if (!existsSync(file)) {
      if (options.json) console.log(JSON.stringify({ configured: false, paths: null }));
      else console.log('paths: not configured');
      break;
    }
    const value = validatePathsConfig(readJsonFile(file, 'paths'));
    if (options.json) console.log(JSON.stringify({ configured: true, paths: value }, null, 2));
    else console.log(`paths: ${value.allowed_roots.length} roots, ${value.exclusions.length} exclusions`);
    } catch (error) {
      console.error(`paths: ${error.message}`);
      process.exit(2);
    }
    break;
  }
  case 'policy': {
    try {
      const options = flags(rest);
      const subcommand = rest.find((value) => !value.startsWith('--'));
      if (subcommand !== 'pull') throw new Error('policy takes pull');
      requireLedger();
      const { url, key } = resolveWorkspace({ url: options.url, key: options.key });
      const result = await pullPolicy({
        dir: DIR,
        url,
        key,
        apply: rest.includes('--apply'),
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`policy: v${result.version} verified with ${result.kid}`);
        console.log(`digest: ${result.digest}`);
        if (result.applied) console.log(`rules: ${result.changed ? 'written' : 'already current'} (${paths(DIR).rules})`);
        else console.log('preview only; re-run with --apply to write rules.json');
      }
    } catch (error) {
      console.error(`policy: ${error.message}`);
      process.exit(2);
    }
    break;
  }
  case 'usage': {
    try {
      requireLedger();
      const options = flags(rest);
      let payload = {};
      if (rest.includes('--stdin')) {
        const raw = readFileSync(0, 'utf8').trim();
        if (raw !== '') payload = JSON.parse(raw);
      }
      const extra = payload.extra && typeof payload.extra === 'object' ? payload.extra : {};
      const reported = payload.usage && typeof payload.usage === 'object'
        ? payload.usage
        : extra.usage && typeof extra.usage === 'object' ? extra.usage : {};
      const task = options.task ?? payload.session_id ?? payload.task_id ?? extra.task_id;
      if (typeof task !== 'string' || task === '') {
        throw new Error('a task is required (--task or a hook payload with session_id)');
      }
      const number = (value, fallback) => (value === undefined ? fallback : Number(value));
      const inputTokens = number(options.input, Number(reported.input_tokens ?? 0));
      const outputTokens = number(options.output, Number(reported.output_tokens ?? 0));
      const cachedTokens = number(options.cached, Number(reported.cached_tokens ?? 0));
      const costUsd = number(options.cost, Number(reported.cost_usd ?? 0));
      const model = options.model ?? payload.model ?? extra.model;
      const entry = appendUsage(DIR, { task, model, inputTokens, outputTokens, cachedTokens, costUsd });
      if (options.json) console.log(JSON.stringify({ seq: entry.seq, task, tokens: inputTokens + outputTokens }, null, 2));
      else console.log(`usage: ${inputTokens + outputTokens} tokens recorded for ${task} (#${entry.seq})`);
    } catch (error) {
      console.error(`usage: ${error.message}`);
      process.exit(2);
    }
    break;
  }
  case 'sync': {
    try {
      const options = flags(rest);
      const requested = options.limit === undefined ? 50 : Number(options.limit);
      const { url, key } = resolveWorkspace({ url: options.url, key: options.key });
      if (rest.includes('--watch')) {
        if (rest.includes('--dry-run')) throw new Error('--watch cannot be combined with --dry-run');
        const controller = new AbortController();
        process.on('SIGINT', () => controller.abort());
        process.on('SIGTERM', () => controller.abort());
        console.log('sync: watching the ledger; Ctrl-C stops');
        await watchSync({
          dir: DIR,
          url,
          key,
          limit: requested,
          intervalMs: options.interval === undefined ? 5000 : Number(options.interval),
          signal: controller.signal,
          onResult: (result) => {
            if (result instanceof Error) console.error(`sync: ${result.message}`);
            else if (options.json) console.log(JSON.stringify(result, null, 2));
            else console.log(`sync: ${result.accepted} accepted, ${result.skipped} already present, ${result.metered} metered, ${result.usage ?? 0} usage; last #${result.last_seq}`);
          },
        });
        break;
      }
      const result = await sync({ dir: DIR, url, key, limit: requested, dryRun: rest.includes('--dry-run') });
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else if (result.dry_run) console.log(`sync dry run: ${result.entries} decision(s) and ${result.usage_rows} usage row(s) ready`);
      else console.log(`sync: ${result.accepted} accepted, ${result.skipped} already present, ${result.metered} metered, ${result.usage ?? 0} usage; last #${result.last_seq}`);
    } catch (error) {
      console.error(`sync: ${error.message}`);
      process.exit(2);
    }
    break;
  }
  case 'ui': {
    try {
      const options = flags(rest);
      const requested = options.port === undefined ? 8197 : Number(options.port);
      if (!Number.isInteger(requested) || requested < 0 || requested > 65535) {
        console.error('ui: --port must be an integer from 0 to 65535');
        process.exit(2);
      }
      requireLedger();
      const ui = await startUi({
        dir: DIR,
        cwd: process.cwd(),
        port: requested,
        open: !rest.includes('--no-open'),
      });
      console.log(`bounds ui: ${ui.url}`);
      console.log('press Ctrl-C to stop');
      const stop = () => { ui.close().then(() => process.exit(0), () => process.exit(1)); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    } catch (error) {
      console.error(`ui: ${error.message}`);
      process.exit(2);
    }
    break;
  }
  case 'setup': {
    const dryRun = rest.includes('--dry-run');
    const write = rest.includes('--write');
    const enforce = rest.includes('--enforce');
    const harnesses = detectHarnesses();
    const cli = resolve(process.argv[1]);
    const ledgerDir = resolve(DIR);
    const agent = writeAgentContext(process.cwd(), { dryRun });
    console.log(`agent context: ${agent.changed ? (dryRun ? 'would update' : 'updated') : 'already current'} ${agent.path}`);
    if (harnesses.length === 0) {
      console.log('no harness config found in this directory or ~/.hermes');
      console.log('wire any harness with this contract: run `attesso hook` as a pre_tool_call hook; exit 2 refuses.');
    }
    for (const harness of harnesses) {
      if (!HARNESSES[harness.key]) {
        console.log(`${harness.key}: found ${harness.path}; wire it with \`${cli} --dir ${ledgerDir} hook\` as its pre-tool hook`);
        continue;
      }
      if (harness.key !== 'hermes' && !write) {
        console.log(`${harness.key}: found ${harness.path}; run setup --write to install the ${enforce ? 'enforce' : 'observe'} hook`);
        continue;
      }
      try {
        const result = wireHarness(harness.key, cli, ledgerDir, {
          dryRun,
          enforce,
          path: harness.path,
        });
        const state = result.applied ? 'wired' : result.dryRun ? 'would wire' : result.reason;
        console.log(`${harness.key}: ${state}`);
        if (result.snippet && !result.applied) console.log(result.snippet);
      } catch (error) {
        console.error(`${harness.key}: ${error.message}`);
      }
    }
    break;
  }
  case 'explain': {
    requireLedger();
    const seq = rest[0];
    if (!seq) {
      console.error('attesso explain <seq>');
      process.exit(1);
    }
    const detail = explain(DIR, seq, readState(DIR));
    if (!detail.found) {
      console.error(`no entry #${seq} in this ledger`);
      process.exit(1);
    }
    console.log(JSON.stringify(detail, null, 2));
    break;
  }
  case 'suggest': {
    requireLedger();
    const proposal = suggest(DIR, readState(DIR));
    if (rest.includes('--json')) {
      console.log(JSON.stringify(proposal, null, 2));
    } else if (proposal.repeats.length === 0) {
      console.log('no repeats yet: nothing the ledger can justify narrowing');
    } else {
      for (const repeat of proposal.repeats) {
        console.log(`${repeat.id}: ${repeat.why}`);
        console.log(`  ${JSON.stringify(repeat.rule)}`);
      }
    }
    break;
  }
  case 'tools':
    toolsCommand(rest);
    break;
  case 'hook': {
    let configuredMode;
    try {
      configuredMode = readMode(DIR);
    } catch (error) {
      console.error(`attesso hook: ${error.message}`);
      process.exit(2);
    }
    if (configuredMode === 'off') {
      process.exitCode = 0;
      break;
    }
    requireLedger();
    const observe = configuredMode === null ? rest.includes('--observe') : configuredMode === 'observe';
    const run = createHookDecider({ append, dir: DIR, observe });
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(raw || '{}');
      } catch {
        console.error('attesso hook: stdin was not JSON, so no decision was made');
        process.exit(observe ? 0 : 2);
      }
      let normalized;
      try {
        normalized = normalizeHookPayload(payload);
        const result = run(normalized.payload);
        const rendered = renderHook({ harness: normalized.harness, result });
        if (rendered.stdout) process.stdout.write(rendered.stdout);
        process.exit(rendered.exitCode);
      } catch (error) {
        // An unwritable ledger is not a policy statement, but enforcement must
        // fail closed. Observe mode stays out of the way.
        const body = {
          decision: 'DENY',
          code: 'LEDGER_UNAVAILABLE',
          message: `Attesso could not read the ledger: ${error.message}`,
          enforced: !observe,
        };
        const rendered = renderHook({ harness: normalized?.harness ?? 'generic', result: { body } });
        if (rendered.stdout) process.stdout.write(rendered.stdout);
        console.error(`attesso hook: ${error.message}`);
        process.exit(observe ? 0 : rendered.exitCode);
      }
    });
    break;
  }
  case 'replay': {
    requireLedger();
    const options = flags(rest);
    let candidatePolicy;
    let candidateRules;
    try {
      candidatePolicy = validatePolicy(JSON.parse(readFileSync(options.policy ?? paths(DIR).policy, 'utf8')));
      candidateRules = validateRules(JSON.parse(readFileSync(options.rules ?? paths(DIR).rules, 'utf8')));
    } catch (error) {
      console.error(`replay: ${error.message}`);
      process.exit(2);
    }
    const summary = replay(readState(DIR).entries, { policy: candidatePolicy, rules: candidateRules });
    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      process.stdout.write(renderReplay(summary));
    }
    if (options['max-newly-denied'] !== undefined && summary.newly_denied > Number(options['max-newly-denied'])) {
      process.exitCode = 1;
    }
    break;
  }
  case 'serve':
    requireLedger();
    serve(DIR, { observe: rest.includes('--observe') }).catch((error) => {
      console.error(`attesso serve: ${error.message}`);
      process.exit(1);
    });
    break;
  case 'report': {
    requireLedger();
    const report = await buildReportStream(DIR);
    if (rest.includes('--json')) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      process.stdout.write(renderReport(report));
    }
    break;
  }
  case undefined:
    console.log(USAGE);
    break;
  default:
    if (command === '--help' || command === '-h' || command === 'help') {
      console.log(USAGE);
      break;
    }
    console.error(`unknown command ${command}\n`);
    console.log(USAGE);
    process.exit(2);
}
