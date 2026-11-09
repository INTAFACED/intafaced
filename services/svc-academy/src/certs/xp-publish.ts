/**
 * Certifications Stage-2 — THE EMIT THAT WAS RESIDUAL (TRK-academy.certs §4).
 *
 * `xp-policy.ts` decided what a cert is worth and `xp-emit.ts` decided what the
 * payload looks like, and then nothing published either one: both modules were
 * imported by nothing but their own tests, and `index.ts` said in as many words
 * that svc-academy holds no bus because "the §8.3 event this service would
 * eventually emit is `intafaced.identity.xp.earned` on certification, and
 * certification ships with the curriculum." Certification has shipped. This file
 * is the wire.
 *
 * ── What it is NOT ──────────────────────────────────────────────────────────
 *
 * NOT a rank writer. svc-identity is the only writer to `rank_state` (§4.1) and
 * the only consumer of this event; academy publishes and forgets. NOT money: XP
 * is an integer on the catalog schema, no `Amount`, no ledger client, no
 * balance — `academy` stays `custodial: false`.
 *
 * ── Why re-publishing is safe, and why that is the recovery story ───────────
 *
 * The idempotency key is a business key — `academy.cert:cert:<userId>:<certId>`,
 * derived in `xp-policy.ts` from the grant itself, never a random uuid. Identity
 * inserts `xp_events ON CONFLICT (idempotency_key) DO NOTHING`, so the SECOND
 * delivery of a cert award changes nothing. That is what lets `grantCert` emit
 * on an already-granted cert as well as a fresh one: if the bus was down the
 * first time, calling grant again re-emits and the user gets their XP; if it was
 * up, the re-emit is a no-op at the writer. An outbox table would buy the same
 * guarantee for the price of a table, a sweep and a migration.
 */

import type { EventBus } from '@intafaced/events';
import type { CertGrantRecord } from './progress.js';
import { CERT_XP_V0, xpIntentFromGrant } from './xp-policy.js';
import { mayPublishXp, toXpEarnedPublish } from './xp-emit.js';
import {
  CERT_XP_IDENTITY_GRAPH_EVENT,
  assertCertGrantPathHonest,
  assertMayPublishCertXpOnIdentityGraph,
  decideCertGrantLedgerPost,
} from './grant-ledger.js';

/**
 * The module identity records against the award. `academy`, never `identity` —
 * `sourceModule` answers "who awarded this", and identity awarding itself would
 * make every cert XP row untraceable to the thing that earned it.
 */
export const CERT_XP_SOURCE_MODULE = 'academy' as const;

/**
 * One action for the whole cert path, with the cert named in `meta`.
 *
 * This mirrors svc-p2p, which emits `action: 'trade.released'` and puts the
 * trade id in `meta` rather than minting an action string per trade. Identity
 * groups XP by action; a per-cert action would make that grouping useless the
 * day a second cert exists.
 */
export const CERT_XP_ACTION = 'cert.granted' as const;

/**
 * AC-certificates-02: the action of the reversal published when staff revoke a certificate whose grant carried XP. Its
 * delta is the award's, negated, so the rank (and the perks the rank gave) fall back to where they stood without it.
 */
export const CERT_XP_REVOKE_ACTION = 'cert.revoked' as const;

/**
 * The reversal's business key: the award's key under its own prefix, one per grant, so a repeat revoke re-publishes the
 * same reversal and identity's `ON CONFLICT (idempotency_key) DO NOTHING` takes it once.
 */
export const CERT_XP_REVOKE_KEY_PREFIX = 'academy.cert-revoke:' as const;

/** Matches `xpEarned` in packages/events — XP is an integer, and is NOT money. */
export type CertXpEventPayload = {
  readonly userId: string;
  readonly sourceModule: typeof CERT_XP_SOURCE_MODULE;
  readonly action: typeof CERT_XP_ACTION | typeof CERT_XP_REVOKE_ACTION;
  readonly xpDelta: number;
  readonly meta: { readonly certId: string };
};

/**
 * Why an award did not go out. Every value is a machine reason a caller can act
 * on — there is no user-facing copy in this file, so nothing here needs an i18n
 * key; the shell renders these ids.
 */
export type CertXpSkipReason =
  /** No v0 XP policy for that cert. We do not invent an amount (§ "no product law"). */
  | 'no_policy'
  /** Policy exists but the intent failed `mayPublishXp` — malformed delta or key. */
  | 'not_publishable'
  /** The policy string is not a safe positive integer, so it cannot be an int XP delta. */
  | 'delta_unrepresentable'
  /** This process has no usable bus. Recoverable: grant again once it does. */
  | 'publisher_unavailable'
  /** The bus rejected or dropped the publish. Recoverable: same key, grant again. */
  | 'publish_failed';

export type CertXpEmitResult =
  | { readonly emitted: true; readonly idempotencyKey: string; readonly xpDelta: number }
  | { readonly emitted: false; readonly reason: CertXpSkipReason };

/**
 * A revoke's XP outcome: the publish result, or `award_unrecorded` for a revoked grant of a priced certificate that
 * recorded no awarded XP (granted before grants recorded it). What identity holds for that one is not known here, so
 * nothing is taken back rather than a guessed amount.
 */
export type CertXpReversalResult = CertXpEmitResult | { readonly emitted: false; readonly reason: 'award_unrecorded' };

/**
 * Decimal-string XP → integer XP.
 *
 * The policy carries `xpDelta` as a string because the certs modules were
 * written to the money discipline (no floats on the wire). The catalog schema
 * types XP as `z.number().int()` — XP is NOT money, it has no fractional part
 * and no asset, and identity widens it to `bigint` on arrival. Non-integer,
 * zero, negative or beyond `Number.MAX_SAFE_INTEGER` returns null rather than a
 * rounded guess.
 */
export function certXpDeltaToInt(xpDelta: string): number | null {
  const raw = xpDelta.trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

export type CertXpIntent = {
  readonly payload: CertXpEventPayload;
  readonly idempotencyKey: string;
};

/**
 * Grant → publishable intent, or a named reason it is not one.
 *
 * Pure. Nothing here touches a bus, so the decision is testable without one and
 * the publisher below has no branching left to get wrong.
 */
export function certXpIntentFor(grant: CertGrantRecord): { ok: true; intent: CertXpIntent } | { ok: false; reason: CertXpSkipReason } {
  const intent = xpIntentFromGrant(grant);
  if (!intent) return { ok: false, reason: 'no_policy' };
  if (!mayPublishXp(intent)) return { ok: false, reason: 'not_publishable' };

  const shape = toXpEarnedPublish(intent);
  const xpDelta = certXpDeltaToInt(shape.xpDelta);
  if (xpDelta === null) return { ok: false, reason: 'delta_unrepresentable' };

  return {
    ok: true,
    intent: {
      idempotencyKey: shape.idempotencyKey,
      payload: {
        userId: shape.userId,
        sourceModule: CERT_XP_SOURCE_MODULE,
        action: CERT_XP_ACTION,
        xpDelta,
        meta: { certId: shape.certId },
      },
    },
  };
}

/** The award and its reversal for one revoked grant, both from what the grant recorded it awarded. */
export type CertXpReversalIntents = { readonly award: CertXpIntent; readonly reversal: CertXpIntent };

/**
 * Revoked grant → its award, re-sent, and the reversal of it, or the reason there are none. Pure.
 *
 * The amount is the XP the grant RECORDED it awarded (`academy.cert_grants.xp_awarded`), never today's policy: a policy
 * retuned after the grant must not take back a different amount than was given. The service answers `no_policy` or
 * `award_unrecorded` before this when the grant recorded none. Both keys come from the grant's stored idempotency key,
 * so they cannot drift from the award: `academy.cert:<key>` (the award's own key, which identity already holds when it
 * landed) and `academy.cert-revoke:<key>`.
 */
export function certXpReversalIntentsFor(
  grant: CertGrantRecord,
  awardedXp: number,
): { ok: true; intents: CertXpReversalIntents } | { ok: false; reason: CertXpSkipReason } {
  assertCertGrantPathHonest(grant);
  if (!Number.isSafeInteger(awardedXp) || awardedXp <= 0) return { ok: false, reason: 'delta_unrepresentable' };
  const payload = { userId: grant.userId, sourceModule: CERT_XP_SOURCE_MODULE, meta: { certId: grant.certId } } as const;
  return {
    ok: true,
    intents: {
      award: {
        idempotencyKey: `academy.cert:${grant.idempotencyKey}`,
        payload: { ...payload, action: CERT_XP_ACTION, xpDelta: awardedXp },
      },
      reversal: {
        idempotencyKey: `${CERT_XP_REVOKE_KEY_PREFIX}${grant.idempotencyKey}`,
        payload: { ...payload, action: CERT_XP_REVOKE_ACTION, xpDelta: -awardedXp },
      },
    },
  };
}

/**
 * The port svc-academy's service depends on. Deliberately narrower than
 * `EventBus`: this service may publish one event and may not subscribe to
 * anything, and a port that cannot express `subscribe` cannot grow one by
 * accident.
 */
export interface CertXpPublisher {
  /** Reported on /ready. `none` means awards are not leaving this process. */
  readonly id: string;
  readonly usable: boolean;
  publishCertXp(grant: CertGrantRecord): Promise<CertXpEmitResult>;
  /**
   * AC-certificates-02: for a revoked grant that recorded `awardedXp`, re-send its award and then publish the reversal
   * (`certXpReversalIntentsFor`), so the pair nets to zero at identity whichever of them landed before. Reported, never
   * thrown: the revoke is already durable, and a repeat revoke or the sweep re-publishes both under the same keys.
   */
  publishCertXpReversal(grant: CertGrantRecord, awardedXp: number): Promise<CertXpEmitResult>;
}

/**
 * No bus in this process.
 *
 * Chosen when NATS is unreachable at boot, and it fails OPEN on purpose: a
 * lobby, a seat, a scene and a curriculum read have nothing to do with the bus,
 * and taking svc-academy out of the fleet because a cert award could not be
 * published would trade a whole service for one downstream side effect. The
 * honest part is that it says so — `/ready` reports `usable: false` and
 * `grantCert` returns `publisher_unavailable` for priced certs instead of
 * implying an award happened. Unpriced certs still return `no_policy` first
 * (publish nothing) — a down bus must not look like a missing rate that will
 * appear later. Same shape as the stream provider (see stream/provider.ts).
 */
export class NullCertXpPublisher implements CertXpPublisher {
  readonly id = 'none';
  readonly usable = false;

  async publishCertXp(grant: CertGrantRecord): Promise<CertXpEmitResult> {
    assertCertGrantPathHonest(grant);
    decideCertGrantLedgerPost(grant);
    const decided = certXpIntentFor(grant);
    if (!decided.ok) return { emitted: false, reason: decided.reason };
    return { emitted: false, reason: 'publisher_unavailable' };
  }

  async publishCertXpReversal(grant: CertGrantRecord, awardedXp: number): Promise<CertXpEmitResult> {
    decideCertGrantLedgerPost(grant);
    const decided = certXpReversalIntentsFor(grant, awardedXp);
    if (!decided.ok) return { emitted: false, reason: decided.reason };
    return { emitted: false, reason: 'publisher_unavailable' };
  }
}

/**
 * The real one. Takes the publish half of the bus and nothing else.
 *
 * A publish failure is REPORTED, never thrown: the grant is already durable in
 * `academy.cert_grants` and throwing here would either lose that row or leave
 * the caller believing a certification it earned did not happen. The award is
 * recoverable — same business key, grant again.
 */
export class BusCertXpPublisher implements CertXpPublisher {
  readonly id = 'bus';
  readonly usable = true;

  constructor(
    private readonly bus: Pick<EventBus, 'publish'>,
    private readonly onError: (err: unknown, grant: CertGrantRecord) => void = () => undefined,
  ) {}

  async publishCertXp(grant: CertGrantRecord): Promise<CertXpEmitResult> {
    assertCertGrantPathHonest(grant);
    decideCertGrantLedgerPost(grant);
    const decided = certXpIntentFor(grant);
    if (!decided.ok) return { emitted: false, reason: decided.reason };
    return this.send(grant, [decided.intent]);
  }

  async publishCertXpReversal(grant: CertGrantRecord, awardedXp: number): Promise<CertXpEmitResult> {
    decideCertGrantLedgerPost(grant);
    const decided = certXpReversalIntentsFor(grant, awardedXp);
    if (!decided.ok) return { emitted: false, reason: decided.reason };
    // The award first: when it never landed, the reversal alone would take XP the learner never got.
    return this.send(grant, [decided.intents.award, decided.intents.reversal]);
  }

  /** Publishes the intents in order and answers the last one; the first failure stops the rest and is reported. */
  private async send(grant: CertGrantRecord, intents: readonly CertXpIntent[]): Promise<CertXpEmitResult> {
    try {
      assertMayPublishCertXpOnIdentityGraph(CERT_XP_IDENTITY_GRAPH_EVENT);
      for (const intent of intents) {
        await this.bus.publish(CERT_XP_IDENTITY_GRAPH_EVENT, intent.payload, { idempotencyKey: intent.idempotencyKey });
      }
    } catch (err) {
      this.onError(err, grant);
      return { emitted: false, reason: 'publish_failed' };
    }
    const last = intents.at(-1)!;
    return { emitted: true, idempotencyKey: last.idempotencyKey, xpDelta: last.payload.xpDelta };
  }
}

export type CertXpPlaneStatus = {
  readonly publisherId: string;
  readonly emitEnabled: boolean;
  readonly sourceModule: typeof CERT_XP_SOURCE_MODULE;
  readonly action: typeof CERT_XP_ACTION;
  /** Stated so no client mistakes this service for the ladder. */
  readonly rankWriter: 'svc-identity';
  readonly policies: readonly { readonly certId: string; readonly xpDelta: number }[];
};

/**
 * What the XP plane is doing right now, for the ops surface.
 *
 * `emitEnabled: false` is the answer an operator needs when a user says their
 * certification did not move their rank — it separates "the award was not
 * published" from "the ladder disagrees", which are two different call-outs.
 */
export function certXpPlaneStatus(publisher: CertXpPublisher): CertXpPlaneStatus {
  const policies: { certId: string; xpDelta: number }[] = [];
  for (const p of CERT_XP_V0) {
    const xpDelta = certXpDeltaToInt(p.xpDelta);
    if (xpDelta === null) continue;
    policies.push({ certId: p.certId, xpDelta });
  }
  policies.sort((a, b) => a.certId.localeCompare(b.certId));

  return {
    publisherId: publisher.id,
    emitEnabled: publisher.usable,
    sourceModule: CERT_XP_SOURCE_MODULE,
    action: CERT_XP_ACTION,
    rankWriter: 'svc-identity',
    policies,
  };
}
