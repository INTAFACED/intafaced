/**
 * KYC capabilities (I-kyc-compliance-07, J-identity-08 #6). What a person's verification lets them do: custody,
 * transfer and trade, crypto and fiat. The owner maps capabilities to levels (`IDENTITY_KYC_CAPABILITIES_BY_LEVEL`, NO
 * DEFAULT). A level grants what is mapped to it and to every level below it. A request marks what it would newly
 * grant pending, the approval makes its level's capabilities active in its own transaction, and a reject puts back
 * only what that request made pending. Every change appends one history row.
 *
 * WHAT THE READ SAYS. The level the person holds now (approved and not lapsed) decides what is active: a capability its
 * level grants reads active, so a lapsed level stops reading active and a level approved before capabilities existed
 * reads active without a backfill. A stored row adds only `pending` (an open request) and `inactive`.
 *
 * `inactive` is terminal (ENGINE KYC-1, X-4): compliance sets it with a code from the owner's capability reason list
 * (`IDENTITY_KYC_CAPABILITY_REASONS`) under a four-eyes approval, no approval or request turns it back on, and a
 * request for a level whose own capabilities include it is refused (`kyc.capability_inactive`). With no mapping
 * published an approval grants no capability, and the read says so (`mapped: false`).
 */
import type { Sql } from 'postgres';
import { KYC_TIERS, type KycTier } from '@intafaced/config';
import type { KycRejectReasons } from './cases.js';
import {
  KYC_CAPABILITIES,
  kycCapabilitySchema,
  type KycCapabilitiesOutput,
  type KycCapability,
  type KycCapabilityState,
} from '@intafaced/contracts/identity-kyc-capabilities';

export type KycCapabilityErrorCode = 'kyc.capability_inactive' | 'kyc.capability_state';

export class KycCapabilityError extends Error {
  constructor(
    message: string,
    readonly code: KycCapabilityErrorCode,
  ) {
    super(message);
    this.name = 'KycCapabilityError';
  }
}

/** Level -> the capabilities the owner maps to it. Empty when the owner has published none. */
export type KycCapabilityMap = ReadonlyMap<KycTier, readonly KycCapability[]>;

/**
 * `IDENTITY_KYC_CAPABILITIES_BY_LEVEL`: a JSON object, level -> list of capabilities, for example
 * `{"basic":["custody_crypto","trade_crypto"],"full":["custody_fiat"]}`. A level left out adds nothing of its own.
 * Unset or blank is no mapping. An empty object or list, the level none, an unknown capability, a repeat, or a
 * capability mapped to two levels stops the service.
 */
export function parseKycCapabilitiesByLevel(raw: string | undefined): KycCapabilityMap {
  const setting = 'IDENTITY_KYC_CAPABILITIES_BY_LEVEL';
  const out = new Map<KycTier, readonly KycCapability[]>();
  if (raw === undefined || raw.trim() === '') return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${setting} must be a JSON object of level -> capabilities`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length === 0)
    throw new Error(`${setting} must map at least one level`);
  const seen = new Set<KycCapability>();
  for (const [level, list] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(KYC_TIERS as readonly string[]).includes(level) || level === 'none')
      throw new Error(`${setting}: "${level}" is not a level that can be granted`);
    if (!Array.isArray(list) || list.length === 0) throw new Error(`${setting}: ${level} needs at least one capability`);
    const caps: KycCapability[] = [];
    for (const entry of list) {
      const cap = kycCapabilitySchema.safeParse(entry);
      if (!cap.success) throw new Error(`${setting}: ${JSON.stringify(entry)} is not a capability`);
      if (seen.has(cap.data)) throw new Error(`${setting}: ${cap.data} is mapped twice`);
      seen.add(cap.data);
      caps.push(cap.data);
    }
    out.set(level as KycTier, caps);
  }
  return out;
}

/** The capabilities a level grants: its own and every lower level's. */
export function capabilitiesOfLevel(map: KycCapabilityMap, tier: KycTier): KycCapability[] {
  const rank = KYC_TIERS.indexOf(tier);
  return KYC_TIERS.filter((t, i) => i <= rank).flatMap((t) => map.get(t) ?? []);
}

function lowestLevelOf(map: KycCapabilityMap, capability: KycCapability): KycTier | null {
  return KYC_TIERS.find((t) => map.get(t)?.includes(capability)) ?? null;
}

interface CapabilityRow {
  capability: KycCapability;
  state: KycCapabilityState;
  case_id: string | null;
  version: number;
  reason_code: string | null;
  at: Date;
}

/**
 * The person's capability rows, under a lock on the person's capabilities as a whole. A row lock alone would miss a
 * row that does not exist yet, so two first writes (an approval and a switch-off) could both take version 1.
 */
async function locked(tx: Sql, userId: string, capabilities: readonly KycCapability[]): Promise<Map<KycCapability, CapabilityRow>> {
  if (capabilities.length === 0) return new Map();
  await tx`SELECT pg_advisory_xact_lock(hashtextextended('identity.kyc_capabilities:' || ${userId}, 0))`;
  const rows = await tx<CapabilityRow[]>`
    SELECT capability, state, case_id, version, reason_code, at FROM kyc_capabilities
    WHERE user_id = ${userId} AND capability IN ${tx(capabilities as KycCapability[])}`;
  return new Map(rows.map((r) => [r.capability, r]));
}

async function write(
  tx: Sql,
  userId: string,
  capability: KycCapability,
  prior: CapabilityRow | undefined,
  next: { state: KycCapabilityState; caseId: string | null; by: string | null; reasonCode: string | null; at: Date },
): Promise<void> {
  const version = (prior?.version ?? 0) + 1;
  await tx`
    INSERT INTO kyc_capabilities (user_id, capability, state, case_id, decided_by, reason_code, version, at)
    VALUES (${userId}, ${capability}, ${next.state}, ${next.caseId}, ${next.by}, ${next.reasonCode}, ${version}, ${next.at})
    ON CONFLICT (user_id, capability) DO UPDATE SET state = EXCLUDED.state, case_id = EXCLUDED.case_id,
      decided_by = EXCLUDED.decided_by, reason_code = EXCLUDED.reason_code, version = EXCLUDED.version, at = EXCLUDED.at`;
  await tx`
    INSERT INTO kyc_capability_events (user_id, capability, version, state, case_id, decided_by, reason_code, at)
    VALUES (${userId}, ${capability}, ${version}, ${next.state}, ${next.caseId}, ${next.by}, ${next.reasonCode}, ${next.at})`;
}

/**
 * Before a request is stored: a level whose own capabilities include one compliance switched off is refused
 * (`kyc.capability_inactive`), because inactive is a decision a new request does not undo. A higher level stays open:
 * its approval leaves the inactive one off.
 */
export async function assertRequestable(sql: Sql, map: KycCapabilityMap, userId: string, tier: KycTier): Promise<void> {
  const own = map.get(tier) ?? [];
  if (own.length === 0) return;
  const [blocked] = await sql<Array<{ capability: string }>>`
    SELECT capability FROM kyc_capabilities
    WHERE user_id = ${userId} AND state = 'inactive' AND capability IN ${sql(own as KycCapability[])} ORDER BY capability LIMIT 1`;
  if (blocked)
    throw new KycCapabilityError(
      `${blocked.capability} was switched off by compliance; a request for the level that grants it is refused`,
      'kyc.capability_inactive',
    );
}

/** A request was stored: what its level would grant beyond the level the person holds becomes pending, owned by its case. */
export async function markRequested(
  tx: Sql,
  map: KycCapabilityMap,
  record: { userId: string; tier: KycTier; heldTier: KycTier; caseId: string; at: Date },
): Promise<void> {
  const held = new Set(capabilitiesOfLevel(map, record.heldTier));
  const wanted = capabilitiesOfLevel(map, record.tier).filter((cap) => !held.has(cap));
  const rows = await locked(tx, record.userId, wanted);
  for (const cap of wanted) {
    const prior = rows.get(cap);
    if (prior?.state === 'inactive' || prior?.state === 'pending') continue;
    await write(tx, record.userId, cap, prior, { state: 'pending', caseId: record.caseId, by: null, reasonCode: null, at: record.at });
  }
}

/**
 * An approval of `tier`: every capability the level grants becomes active in the approval's transaction. An inactive
 * one stays inactive. Returns what became active.
 */
export async function grantOnApproval(
  tx: Sql,
  map: KycCapabilityMap,
  decision: { userId: string; tier: KycTier; caseId: string | null; by: string; at: Date },
): Promise<KycCapability[]> {
  const wanted = capabilitiesOfLevel(map, decision.tier);
  const rows = await locked(tx, decision.userId, wanted);
  const granted: KycCapability[] = [];
  for (const cap of wanted) {
    const prior = rows.get(cap);
    if (prior?.state === 'active' || prior?.state === 'inactive') continue;
    await write(tx, decision.userId, cap, prior, {
      state: 'active',
      caseId: decision.caseId,
      by: decision.by,
      reasonCode: null,
      at: decision.at,
    });
    granted.push(cap);
  }
  return granted;
}

/**
 * A reject: a capability that this request made pending goes back to unrequested. One another open request made
 * pending stays pending.
 */
export async function releaseOnReject(
  tx: Sql,
  map: KycCapabilityMap,
  decision: { userId: string; tier: KycTier; caseId: string; by: string; at: Date },
): Promise<void> {
  const wanted = capabilitiesOfLevel(map, decision.tier);
  const rows = await locked(tx, decision.userId, wanted);
  for (const cap of wanted) {
    const prior = rows.get(cap);
    if (prior?.state !== 'pending' || prior.case_id !== decision.caseId) continue;
    await write(tx, decision.userId, cap, prior, {
      state: 'unrequested',
      caseId: decision.caseId,
      by: decision.by,
      reasonCode: null,
      at: decision.at,
    });
  }
}

/**
 * Compliance switches a capability off for good. The same capability already inactive with the same code is the same
 * decision and returns; with another code it is refused (`kyc.capability_state`), so the recorded reason never changes.
 */
export async function deactivateCapability(
  tx: Sql,
  input: { userId: string; capability: KycCapability; reasonCode: string; by: string; at: Date },
): Promise<void> {
  const rows = await locked(tx, input.userId, [input.capability]);
  const prior = rows.get(input.capability);
  if (prior?.state === 'inactive') {
    if (prior.reason_code === input.reasonCode) return;
    throw new KycCapabilityError(`${input.capability} is already inactive with ${prior.reason_code}`, 'kyc.capability_state');
  }
  await write(tx, input.userId, input.capability, prior, {
    state: 'inactive',
    caseId: null,
    by: input.by,
    reasonCode: input.reasonCode,
    at: input.at,
  });
}

/** Before the four-eyes approval is spent: the decision would refuse an inactive capability with another code. */
export async function assertDeactivatable(sql: Sql, userId: string, capability: KycCapability, reasonCode: string): Promise<void> {
  const [row] = await sql<Array<{ state: string; reason_code: string | null }>>`
    SELECT state, reason_code FROM kyc_capabilities WHERE user_id = ${userId} AND capability = ${capability}`;
  if (row?.state === 'inactive' && row.reason_code !== reasonCode)
    throw new KycCapabilityError(`${capability} is already inactive with ${row.reason_code}`, 'kyc.capability_state');
}

/**
 * Every capability with its state. Inactive wins; then the level the person holds now (`heldTier`, approved and not
 * lapsed) makes what it grants read active; then an open request reads pending; anything else reads unrequested. An
 * inactive one carries the owner's reason text when the code is still on the list.
 */
export async function listCapabilities(
  sql: Sql,
  map: KycCapabilityMap,
  userId: string,
  heldTier: KycTier,
  reasons: KycRejectReasons,
): Promise<KycCapabilitiesOutput> {
  const rows = await sql<CapabilityRow[]>`
    SELECT capability, state, case_id, version, reason_code, at FROM kyc_capabilities WHERE user_id = ${userId}`;
  const byCap = new Map(rows.map((r) => [r.capability, r]));
  const held = new Set(capabilitiesOfLevel(map, heldTier));
  return {
    mapped: map.size > 0,
    capabilities: KYC_CAPABILITIES.map((capability) => {
      const row = byCap.get(capability);
      const state: KycCapabilityState =
        row?.state === 'inactive' ? 'inactive' : held.has(capability) ? 'active' : row?.state === 'pending' ? 'pending' : 'unrequested';
      const code = state === 'inactive' ? (row?.reason_code ?? null) : null;
      return {
        capability,
        state,
        grantedAt: lowestLevelOf(map, capability),
        reasonCode: code,
        reasonText: code ? (reasons.get(code)?.reason ?? null) : null,
        changedAt: row ? row.at.toISOString() : null,
      };
    }),
  };
}
