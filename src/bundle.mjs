// A bundle is the smallest artifact that lets a stranger re-run one decision:
// the entry, its receipt, the exact policy and rules bytes, and the task history
// the path rule read.
import { entryHash, verifyEntry } from './ledger.mjs';
import { policyDigest } from './policy.mjs';
import { receiptFor, signerOf, verifyReceipt } from './receipt.mjs';
import { decide } from './decide.mjs';
import { proposalOf } from './replay.mjs';
import { rulesDigest } from './rules.mjs';
import { toolsDigest, manifestDigest, validateToolLock } from './toolpin.mjs';
import { readSnapshot, readState, readToolLock } from './store.mjs';

export function bundleFor(dir, seq) {
  const state = readState(dir);
  const index = state.entries.findIndex((entry) => entry.seq === Number(seq));
  if (index === -1) throw new Error(`no entry #${seq} in this ledger`);
  const entry = state.entries[index];
  const policy = readSnapshot(dir, entry.policy_digest, 'policy');
  const rules = entry.rules_digest ? readSnapshot(dir, entry.rules_digest, 'rules') : null;
  const tools = entry.tools_digest ? readSnapshot(dir, entry.tools_digest, 'tools') : null;
  const mcp = entry.mcp_digest ? readSnapshot(dir, entry.mcp_digest, 'mcp') : null;
  const toolLock = readToolLock(dir);
  const history = state.entries.filter(
    (candidate) => (candidate.task ?? null) === (entry.task ?? null) && candidate.seq < entry.seq,
  );
  return {
    v: 1,
    statement: entry,
    key: state.key.public,
    receipt: receiptFor(state.entries, index, signerOf(state.key)),
    policy,
    rules,
    tools,
    mcp,
    tool_lock: toolLock,
    history,
  };
}

export function verifyBundle(bundle, { replay = false, publicPem } = {}) {
  if (!bundle || bundle.v !== 1 || !bundle.statement || !bundle.receipt) {
    return { ok: false, reason: 'bundle is not version 1' };
  }
  const key = publicPem ?? bundle.key;
  const { statement, receipt, policy, rules, tools, mcp, tool_lock: toolLock, history } = bundle;
  if (!verifyEntry(statement, key)) return { ok: false, reason: 'statement signature does not verify' };

  const receiptResult = verifyReceipt(receipt, key);
  if (!receiptResult.ok) return { ok: false, reason: receiptResult.reason };
  if (entryHash(receipt.entry) !== entryHash(statement)) {
    return { ok: false, reason: 'the receipt proves a different entry' };
  }
  if (policyDigest(policy) !== statement.policy_digest) {
    return { ok: false, reason: 'policy_digest does not match the policy in the bundle' };
  }
  let historical = false;
  if (statement.rules_digest) {
    if (!rules) return { ok: false, reason: 'rules_digest is set but the bundle carries no rules' };
    if (rulesDigest(rules) !== statement.rules_digest) {
      return { ok: false, reason: 'rules_digest does not match the rules in the bundle' };
    }
  } else {
    historical = true;
  }
  if (statement.tools_digest) {
    if (!tools) return { ok: false, reason: 'tools_digest is set but the bundle carries no tools' };
    if (toolsDigest(tools) !== statement.tools_digest) {
      return { ok: false, reason: 'tools_digest does not match the tools in the bundle' };
    }
  } else {
    historical = true;
  }
  if (statement.mcp_digest) {
    if (!mcp) return { ok: false, reason: 'mcp_digest is set but the bundle carries no MCP manifest' };
    if (manifestDigest(mcp) !== statement.mcp_digest) {
      return { ok: false, reason: 'mcp_digest does not match the MCP manifest in the bundle' };
    }
  }
  if (statement.tool_pin === 'verified') {
    if (!toolLock) return { ok: false, reason: 'tool_pin is verified but the bundle carries no tool lock' };
    try {
      validateToolLock(toolLock);
    } catch (error) {
      return { ok: false, reason: error.message };
    }
    if (toolLock.tools[statement.subject] !== statement.tool_hash) {
      return { ok: false, reason: 'tool_hash does not match the pinned tool in the bundle' };
    }
  }
  let previous = 0;
  for (const item of history ?? []) {
    if (!verifyEntry(item, key)) return { ok: false, reason: `history entry #${item.seq} signature does not verify` };
    if ((item.task ?? null) !== (statement.task ?? null)) {
      return { ok: false, reason: `history entry #${item.seq} belongs to another task` };
    }
    if (item.seq >= statement.seq || item.seq <= previous) {
      return { ok: false, reason: `history entry #${item.seq} is out of order` };
    }
    previous = item.seq;
  }
  if (!replay) return { ok: true, reason: 'bundle verifies', historical };
  if (statement.control) {
    return { ok: true, reason: 'bundle verifies; control verdict is not replayed', historical };
  }
  if (statement.code === 'TOOL_CHANGED' || statement.code === 'TOOL_UNPINNED') {
    return { ok: true, reason: 'bundle verifies; the tool-pin verdict is not replayed', historical };
  }

  const verdict = decide({
    policy,
    rules,
    history: history ?? [],
    proposal: proposalOf(statement),
    now: new Date(statement.at),
  });
  if (verdict.decision !== statement.decision || verdict.code !== statement.code) {
    return {
      ok: false,
      reason: `replay produced ${verdict.decision}/${verdict.code}, the record says ${statement.decision}/${statement.code}`,
    };
  }
  return {
    ok: true,
    reason: 'bundle verifies and replays to the recorded verdict',
    historical,
    replayed: { decision: verdict.decision, code: verdict.code, rule: verdict.rule ?? null },
  };
}
