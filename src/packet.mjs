// A packet is a named envelope around one or more local bundles. The bundle
// already carries the statement, receipt, policy and task history; the packet
// adds only a digest, a human title and a summary, never new evidence.
import { createHash } from 'node:crypto';
import { canonical } from './canonical.mjs';
import { bundleFor, verifyBundle } from './bundle.mjs';

export const PACKET_KIND = 'attesso.bounds.packet.v1';
export const MAX_PACKET_BUNDLES = 20;

function packetDigest(body) {
  return createHash('sha256').update(canonical(body)).digest('hex');
}

function summarize(bundle) {
  const entries = [...(bundle.history ?? []), bundle.statement];
  const codes = [...new Set(entries.map((entry) => entry.code))].sort();
  const refused = entries.filter((entry) => entry.decision === 'DENY').length;
  return {
    task: bundle.statement.task ?? null,
    decisions: entries.length,
    allowed: entries.length - refused,
    refused,
    codes,
  };
}

export function packetFor(dir, seq, { title } = {}) {
  const bundle = bundleFor(dir, seq);
  const body = {
    v: 1,
    kind: PACKET_KIND,
    created_at: new Date().toISOString(),
    title: typeof title === 'string' && title.trim() !== ''
      ? title.trim()
      : `${bundle.statement.task ?? 'ledger'} / decision #${bundle.statement.seq}`,
    summary: summarize(bundle),
    bundles: [bundle],
    notes: [],
  };
  return { ...body, digest: packetDigest(body) };
}

export function verifyPacket(packet, { replay = false, publicPem } = {}) {
  if (!packet || packet.v !== 1 || packet.kind !== PACKET_KIND || !Array.isArray(packet.bundles)) {
    return { ok: false, reason: 'packet is not a version 1 Bounds packet' };
  }
  if (packet.bundles.length === 0 || packet.bundles.length > MAX_PACKET_BUNDLES) {
    return { ok: false, reason: `packet must contain 1 to ${MAX_PACKET_BUNDLES} bundles` };
  }
  if (typeof packet.digest !== 'string' || packet.digest === '') {
    return { ok: false, reason: 'packet has no digest' };
  }
  const { digest, ...body } = packet;
  if (packetDigest(body) !== digest) {
    return { ok: false, reason: 'packet digest does not match its contents' };
  }
  const task = body.summary?.task ?? null;
  let historical = false;
  for (const bundle of body.bundles) {
    const result = verifyBundle(bundle, { replay, publicPem });
    if (!result.ok) return { ok: false, reason: result.reason };
    if ((bundle.statement?.task ?? null) !== task) {
      return { ok: false, reason: 'a packet bundle belongs to another task' };
    }
    historical = historical || Boolean(result.historical);
  }
  return {
    ok: true,
    reason: replay
      ? 'packet verifies and every bundle replays to its recorded verdict'
      : 'packet verifies',
    historical,
  };
}
