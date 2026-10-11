import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { pendingPayfacPermissionIntentCount } from './payfac-authority.js';

/**
 * THE SUB-MERCHANT TREE, AND WHO MAY ACT INSIDE IT (§6.1 PayFac mode).
 *
 * ══ WHAT THIS FILE DOES NOT DECIDE ═══════════════════════════════════════════
 *
 * IT DOES NOT MOVE VALUE, AND IT NEVER WILL. There is no `ledger` import here,
 * no recipe, no balance, and no amount of any kind. A sub-merchant IS a
 * sovereign account exactly as a merchant is, its money sits in the ledger, and
 * it moves only through `packages/ledger-client` (Doctrine §0.6). What this file
 * decides is WHO MAY ASK — never where value is or where it goes.
 *
 * IT DOES NOT MAKE US A PAYMENT FACILITATOR. `docs/SPEC-PAY-VERTICALS-2026-08-02.md`
 * §2 is explicit — "Build: the mechanics. Do not become one" — because a payfac
 * takes on its sub-merchants' liability, which is a licence and a sponsor bank,
 * not a feature flag. Accordingly `settlingParty` accepts exactly one value here
 * (`'self'`, which is what settlement already does) and refuses every other by
 * name. See `SETTLING_PARTY_SELF`.
 *
 * ══ THE "14 PERMISSION AREAS" — SAID OUT LOUD ════════════════════════════════
 *
 * The tracker row `pay.payfac` is titled "PayFac mode — sub-merchant trees, 14
 * permission areas". THAT LIST HAS NEVER EXISTED. The phrase appears in
 * `tooling/tracker/features.mjs`, `tooling/coverage.yaml`,
 * `INTAFACED_DEFINITIVE_BUILD.md` and three board renders derived from them —
 * six copies of one title string, and nobody ever enumerated the fourteen.
 * `docs/PAY-LANE-HARVEST-AND-BUILD-PLAN-2026-08-08.md` §2 records the same
 * finding independently, and §6.3 puts "enumerate them, or drop the claim from
 * the title" on the owner's list.
 *
 * So this ships the MECHANISM, and the default area list below is EVERY AREA
 * THAT NAMES A SURFACE THIS SERVICE ACTUALLY HAS — eleven of them, not fourteen.
 * Padding the list to hit a number in a title would be inventing product law
 * inside an implementation, which is the one thing an agent may not do. Adding
 * the twelfth is a one-line change to `PERMISSION_AREAS` and needs no migration,
 * because `area` is stored as text precisely so an unsettled list is not frozen
 * into a live table.
 *
 * ══ THE TWO CHECKS, WHICH ARE NOT THE SAME CHECK ═════════════════════════════
 *
 * Every operation names a SUBJECT merchant and is judged twice:
 *
 *   1. SCOPE — structural, absolute, and unwidenable by any configuration. The
 *      actor's merchant node must be an ancestor of the subject, or the subject
 *      itself. Nothing else is reachable, ever. This is what makes "a parent
 *      cannot read a sibling subtree" a property of the system rather than a
 *      promise, and no grant can turn it off.
 *
 *   2. AREA — a permission, and only for a subject that is not the actor itself.
 *      A merchant holds every area over its OWN node (that is what owning your
 *      merchant means). Over a descendant it holds an area only if it is the
 *      ROOT of that tree, or a live grant says so.
 *
 * WHY THE ROOT HOLDS EVERYTHING IMPLICITLY. Some node has to be the source of
 * authority or the first grant can never be made, and the root is the only
 * defensible one: it is the node with the platform relationship, and §2 of the
 * spec says the facilitator "takes on their liability". Giving that to an
 * operator scope instead would mean a payfac cannot onboard anyone without a
 * human at this company clicking, which is not a payfac.
 *
 * WHY A NON-ROOT CANNOT SELF-GRANT. Delegation only ever flows DOWN, and only
 * what the granter already holds. An intermediate node with `submerchant` over
 * its children cannot hand itself `refund`; if it could, the grant mechanism
 * would be decorative and the tree would collapse back into "every node owns its
 * whole subtree".
 */

/** Thrown for every refusal here. Transport-free — the routers render it. */
export class SubMerchantError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SubMerchantError';
  }
}

/** submerchant.list page size unpublished. Blank / non-finite / <1 refuses. Never invent 100. */
export function assertSubMerchantListLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new SubMerchantError(
      'submerchant.list page size is unset. Blank refuses — never 100. Pass a positive integer (100 is allowed if explicit).',
      'pay.submerchant_list_limit_unset',
    );
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new SubMerchantError(
      'submerchant.list page size is unset. Blank refuses — never 100. Pass a positive integer (100 is allowed if explicit).',
      'pay.submerchant_list_limit_unset',
    );
  }
  return Math.min(500, n);
}

/** submerchantPermission.list page size unpublished. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertPermissionListLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new SubMerchantError(
      'submerchantPermission.list page size is unset. Blank refuses — never 50. Pass a positive integer (50 is allowed if explicit).',
      'pay.submerchant_permission_list_limit_unset',
    );
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new SubMerchantError(
      'submerchantPermission.list page size is unset. Blank refuses — never 50. Pass a positive integer (50 is allowed if explicit).',
      'pay.submerchant_permission_list_limit_unset',
    );
  }
  return Math.min(200, n);
}

/** submerchantPermission.history page size unpublished. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertPermissionHistoryLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new SubMerchantError(
      'submerchantPermission.history page size is unset. Blank refuses — never 50. Pass a positive integer (50 is allowed if explicit).',
      'pay.submerchant_permission_history_limit_unset',
    );
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new SubMerchantError(
      'submerchantPermission.history page size is unset. Blank refuses — never 50. Pass a positive integer (50 is allowed if explicit).',
      'pay.submerchant_permission_history_limit_unset',
    );
  }
  return Math.min(200, n);
}

/**
 * THE PERMISSION AREAS.
 *
 * Each one names a surface `services/svc-pay` genuinely has today. Read the
 * banner above before adding one: the number in the tracker title is not a
 * target, and an area that names nothing is worse than a missing area, because
 * it can be granted and then does nothing.
 */
export const PERMISSION_AREAS = [
  /** The sub-merchant's own record: pricing band, settlement prefs, status. */
  'merchant.profile',
  /** `payment_profiles` — checkout config, fee routing, allowed domains. */
  'checkout.profile',
  /** `payment_links` — shareable links and their use counters. */
  'payment.link',
  /** Create and read payments. NOT refunds — sending money back is its own area. */
  'payment',
  /** Refund a captured payment. Separate because it moves value back out. */
  'payment.refund',
  /** Read and run settlement windows. */
  'settlement',
  /** Pay a settlement out through a rail. The value-leaves-the-platform area. */
  'settlement.payout',
  /** Outbound webhook endpoints and the delivery dashboard. */
  'webhook',
  /** Submit and read the KYB dossier state. */
  'kyb',
  /** See and onboard nodes beneath this one. */
  'submerchant',
  /** Grant and revoke within this subtree. Delegating delegation. */
  'permission',
] as const;

export type PermissionArea = (typeof PERMISSION_AREAS)[number];

/**
 * WHAT A NEWLY ONBOARDED SUB-MERCHANT'S ANCESTORS GET FOR FREE.
 *
 * Deliberately the two areas that let a parent SEE what it onboarded and where
 * it sits, and nothing that touches money. `payment`, `payment.refund`,
 * `settlement` and `settlement.payout` are held by no non-root node until
 * somebody grants them by name and says why — because "the parent onboarded
 * them" is not, on its own, a reason the parent may move their money.
 */
export const DEFAULT_GRANTED_AREAS: readonly PermissionArea[] = ['merchant.profile', 'submerchant'];

/**
 * The only `settlingParty` this service accepts.
 *
 * `'self'` means the merchant settles into its OWN ledger account — precisely
 * what `settleWindow` already does for every merchant. Any other value names a
 * party that would settle on their behalf, which is acquiring: it requires the
 * sponsor bank that `docs/SPEC-PAY-VERTICALS-2026-08-02.md` §8 puts on the
 * owner's list and that `socket.psp-partners` tracks. Storing such a value while
 * settlement ignored it would be a lie kept in a column.
 */
export const SETTLING_PARTY_SELF = 'self';

/**
 * How far below the root a sub-merchant may sit. Root is depth 0.
 *
 * A STRUCTURAL SAFETY BOUND, NOT PRODUCT LAW. Nothing in the doctrine states a
 * maximum tree depth; what a bound buys is that the ancestor walk on the hot
 * authorization path has a fixed cost and that a mistake cannot grow an
 * unbounded chain. It refuses by name (`pay.submerchant_too_deep`) rather than
 * silently truncating, so if the product ever wants deeper trees the refusal
 * says exactly which constant to change.
 */
export const MAX_SUBMERCHANT_DEPTH = 4;

/**
 * The ancestor walk's own limit, one step past the deepest legal tree.
 *
 * Cycles cannot be created through this service — `parent_merchant_id` is set
 * once, at insert, to a node that already exists — and the database refuses a
 * self-parent. This bound is for the tree that got into that state some other
 * way (a restore, a hand-run UPDATE): the walk stops and the caller is REFUSED
 * with `pay.submerchant_cycle` rather than the query never returning. An
 * authorization check that hangs is an authorization check that gets bypassed.
 */
const MAX_ANCESTOR_WALK = MAX_SUBMERCHANT_DEPTH + 2;

export interface SubMerchantRecord {
  id: string;
  userId: string;
  parentMerchantId: string | null;
  mode: 'gateway' | 'psp' | 'payfac';
  status: 'pending' | 'active' | 'suspended' | 'closed';
  kybStatus: 'none' | 'pending' | 'approved' | 'rejected';
  settlingParty: string;
  feeBps: number | null;
  /** Distance below the root of its tree. A top-level merchant is 0. */
  depth: number;
  createdAt: Date;
}

export interface PermissionGrantRecord {
  granteeMerchantId: string;
  subjectMerchantId: string;
  area: PermissionArea;
  reason: string;
  actorId: string;
  actorMerchantId: string;
  grantedAt: Date;
}

export interface PermissionEventRecord {
  id: string;
  seq: string;
  granteeMerchantId: string;
  subjectMerchantId: string;
  area: string;
  action: 'grant' | 'revoke';
  reason: string;
  actorId: string;
  actorMerchantId: string;
  actorScope: string;
  createdAt: Date;
}

interface MerchantNodeRow {
  id: string;
  user_id: string;
  parent_merchant_id: string | null;
  mode: SubMerchantRecord['mode'];
  status: SubMerchantRecord['status'];
  kyb_status: SubMerchantRecord['kybStatus'];
  settling_party: string;
  pricing: Record<string, unknown>;
  created_at: Date;
}

interface PermissionEventRow {
  id: string;
  seq: string;
  grantee_merchant_id: string;
  subject_merchant_id: string;
  area: string;
  action: 'grant' | 'revoke';
  reason: string;
  actor_id: string;
  actor_merchant_id: string;
  actor_scope: string;
  created_at: Date;
}

function feeBpsOf(pricing: Record<string, unknown>): number | null {
  const raw = pricing['feeBps'];
  return typeof raw === 'number' ? raw : null;
}

function toRecord(row: MerchantNodeRow, depth: number): SubMerchantRecord {
  return {
    id: row.id,
    userId: row.user_id,
    parentMerchantId: row.parent_merchant_id,
    mode: row.mode,
    status: row.status,
    kybStatus: row.kyb_status,
    settlingParty: row.settling_party,
    feeBps: feeBpsOf(row.pricing),
    depth,
    createdAt: row.created_at,
  };
}

function toEvent(row: PermissionEventRow): PermissionEventRecord {
  return {
    id: row.id,
    // `bigserial` arrives as a string and stays one — an ordering key, never
    // arithmetic, and a `number` would put a 2^53 ceiling on an append-only log.
    seq: String(row.seq),
    granteeMerchantId: row.grantee_merchant_id,
    subjectMerchantId: row.subject_merchant_id,
    area: row.area,
    action: row.action,
    reason: row.reason,
    actorId: row.actor_id,
    actorMerchantId: row.actor_merchant_id,
    actorScope: row.actor_scope,
    createdAt: row.created_at,
  };
}

export function isPermissionArea(value: string): value is PermissionArea {
  return (PERMISSION_AREAS as readonly string[]).includes(value);
}

export interface CreateSubMerchantInput {
  /** The node the caller is acting as. Resolved from the principal, never sent. */
  actorMerchantId: string;
  /** Where in the tree the new node hangs. Must be inside the actor's subtree. */
  parentMerchantId: string;
  /** The new sub-merchant's OWN sovereign account. Not the parent's. */
  userId: string;
  pricing: { feeBps: number };
  /** `'self'` only, today. See `SETTLING_PARTY_SELF`. */
  settlingParty?: string;
  settlementPrefs?: Record<string, unknown>;
  actorId: string;
  actorScope: string;
}

export interface PermissionChangeInput {
  actorMerchantId: string;
  granteeMerchantId: string;
  subjectMerchantId: string;
  area: string;
  reason: string;
  actorId: string;
  actorScope: string;
}
export type PermissionAuthorityEvidence = {
  actorMerchantId: string;
  subjectMerchantId: string;
  area: PermissionArea;
  proof:
    | { kind: 'root_relation'; rootMerchantId: string; ancestry: string[] }
    | { kind: 'permission_event'; grantEventId: string; grantSequence: string };
};
export type PermissionIntentDrain = (tx: Sql, current: PermissionEventRecord) => Promise<void>;

export class SubMerchantService {
  constructor(
    private readonly sql: Sql,
    private readonly drainPermissionIntents?: PermissionIntentDrain,
  ) {}

  /** Caller owns the subject's SHARE guard; evidence is server-derived from the live tree. */
  async permissionAuthorityEvidence(
    actorUserId: string,
    subjectMerchantId: string,
    area: PermissionArea,
    tx: Sql,
  ): Promise<PermissionAuthorityEvidence> {
    const [actor] = await tx`SELECT id FROM pay.merchants WHERE user_id=${actorUserId}`;
    if (!actor) throw new SubMerchantError('Actor has no merchant node', 'pay.submerchant_not_onboarded');
    const actorMerchantId = String(actor.id);
    const ancestry = await this.assertWithinSubtree(actorMerchantId, subjectMerchantId, tx);
    if (actorMerchantId === subjectMerchantId)
      throw new SubMerchantError('Own-node authority needs no PayFac proof', 'pay.submerchant_grant_self');
    const rootMerchantId = ancestry[ancestry.length - 1]!;
    if (rootMerchantId === actorMerchantId)
      return { actorMerchantId, subjectMerchantId, area, proof: { kind: 'root_relation', rootMerchantId, ancestry } };
    const event = await this.latestEvent(actorMerchantId, subjectMerchantId, area, tx);
    if (!event || event.action !== 'grant') throw new SubMerchantError('Actor holds no current grant', 'pay.submerchant_permission_denied');
    return {
      actorMerchantId,
      subjectMerchantId,
      area,
      proof: { kind: 'permission_event', grantEventId: event.id, grantSequence: event.seq },
    };
  }

  /**
   * The chain from a node up to the root of its tree — `[self, parent, …, root]`.
   *
   * ONE QUERY, bounded. A per-level round trip would make the hot authorization
   * path N queries deep and would race a concurrent onboarding halfway up.
   */
  private async ancestry(merchantId: string, tx: Sql = this.sql): Promise<string[]> {
    const rows = await tx<Array<{ id: string; depth: number }>>`
      WITH RECURSIVE chain AS (
        SELECT id, parent_merchant_id, 0 AS depth
          FROM pay.merchants
         WHERE id = ${merchantId}
        UNION ALL
        SELECT m.id, m.parent_merchant_id, c.depth + 1
          FROM pay.merchants m
          JOIN chain c ON m.id = c.parent_merchant_id
         WHERE c.depth < ${MAX_ANCESTOR_WALK}
      )
      SELECT id, depth FROM chain ORDER BY depth ASC
    `;

    if (rows.length === 0) {
      throw new SubMerchantError(`No merchant ${merchantId}`, 'pay.merchant_not_found');
    }
    if (rows.length > MAX_ANCESTOR_WALK) {
      // The walk hit its bound, which a legal tree cannot do. Refusing is the
      // only safe answer: a truncated chain would silently omit an ancestor, and
      // omitting an ancestor is how a node stops being reachable by the payfac
      // that is liable for it.
      throw new SubMerchantError(
        `The merchant tree above ${merchantId} does not terminate within ${MAX_ANCESTOR_WALK} levels. ` +
          'That is a cycle or a corrupted parent chain, and no authorization decision can be made over it.',
        'pay.submerchant_cycle',
        { merchantId, walked: rows.length },
      );
    }
    return rows.map((r) => r.id);
  }

  /**
   * CHECK 1 — SCOPE. Absolute, and no grant can widen it.
   *
   * The subject must be the actor itself or a descendant of it. A sibling, a
   * cousin, an ancestor and an unrelated merchant are all equally unreachable,
   * and they fail with the same code so the refusal is not an oracle for the
   * shape of somebody else's tree.
   */
  async assertWithinSubtree(actorMerchantId: string, subjectMerchantId: string, tx: Sql = this.sql): Promise<string[]> {
    const chain = await this.ancestry(subjectMerchantId, tx);
    if (!chain.includes(actorMerchantId)) {
      throw new SubMerchantError(
        `Merchant ${subjectMerchantId} is not inside merchant ${actorMerchantId}'s sub-merchant tree`,
        'pay.submerchant_out_of_scope',
      );
    }
    return chain;
  }

  /** The latest journal entry for one triple, or null if it was never touched. */
  private async latestEvent(
    granteeMerchantId: string,
    subjectMerchantId: string,
    area: string,
    tx: Sql = this.sql,
  ): Promise<PermissionEventRecord | null> {
    const rows = await tx<PermissionEventRow[]>`
      SELECT id, seq, grantee_merchant_id, subject_merchant_id, area, action, reason,
             actor_id, actor_merchant_id, actor_scope, created_at
        FROM pay.merchant_permission_events
       WHERE grantee_merchant_id = ${granteeMerchantId}
         AND subject_merchant_id = ${subjectMerchantId}
         AND area = ${area}
       ORDER BY seq DESC
       LIMIT 1
    `;
    const row = rows[0];
    return row ? toEvent(row) : null;
  }

  /**
   * CHECK 2 — AREA. Does this node hold this permission over that one?
   *
   * Three ways to hold it, and only three:
   *   · the subject IS the actor — you own your own merchant;
   *   · the actor is the ROOT of the subject's tree — the payfac relationship;
   *   · a live grant says so.
   *
   * `chain` is passed in when the caller has already walked it, so an operation
   * that checks scope and then area does not walk the tree twice.
   */
  async holds(actorMerchantId: string, subjectMerchantId: string, area: string, tx: Sql = this.sql, chain?: string[]): Promise<boolean> {
    const ancestry = chain ?? (await this.assertWithinSubtree(actorMerchantId, subjectMerchantId, tx));
    if (actorMerchantId === subjectMerchantId) return true;
    if (ancestry[ancestry.length - 1] === actorMerchantId) return true;

    const latest = await this.latestEvent(actorMerchantId, subjectMerchantId, area, tx);
    return latest !== null && latest.action === 'grant';
  }

  /** `holds`, as a refusal. The routers call this before every scoped read or write. */
  async assertHolds(
    actorMerchantId: string,
    subjectMerchantId: string,
    area: PermissionArea,
    tx: Sql = this.sql,
    chain?: string[],
  ): Promise<void> {
    const ancestry = chain ?? (await this.assertWithinSubtree(actorMerchantId, subjectMerchantId, tx));
    if (await this.holds(actorMerchantId, subjectMerchantId, area, tx, ancestry)) return;
    throw new SubMerchantError(
      `Merchant ${actorMerchantId} holds no "${area}" permission over merchant ${subjectMerchantId}`,
      'pay.submerchant_permission_denied',
      { area },
    );
  }

  /**
   * ONBOARD A SUB-MERCHANT UNDER A NODE THE ACTOR CAN REACH.
   *
   * ── WHAT IT REFUSES ────────────────────────────────────────────────────────
   *
   * A PARENT OUTSIDE THE ACTOR'S SUBTREE, and a parent the actor may see but
   * holds no `submerchant` permission over. The two are different refusals on
   * purpose: the first says the node is not yours to look at, the second says it
   * is yours to look at and not yours to extend.
   *
   * A TREE DEEPER THAN `MAX_SUBMERCHANT_DEPTH`.
   *
   * A `settlingParty` other than `'self'` — see `SETTLING_PARTY_SELF`.
   *
   * AN ACCOUNT THAT IS ALREADY SOMEBODY ELSE'S MERCHANT. `merchants.user_id` is
   * UNIQUE and stays that way, so onboarding a user who already trades as a
   * merchant elsewhere is refused by name rather than silently adopting their
   * existing row into this tree — which would hand the actor authority over a
   * merchant that predates them.
   *
   * ── WHY IT IS IDEMPOTENT ───────────────────────────────────────────────────
   *
   * Onboarding is retried more than almost anything else in a payments product.
   * Calling this twice for the same `(parent, userId)` returns the SAME node
   * rather than failing, exactly as `createMerchant` does — and the default
   * grants are written with the journal's own history in mind, so a retry does
   * not re-grant an area an operator has since revoked.
   */
  async createSubMerchant(input: CreateSubMerchantInput): Promise<SubMerchantRecord> {
    const settlingParty = (input.settlingParty ?? SETTLING_PARTY_SELF).trim();
    if (settlingParty !== SETTLING_PARTY_SELF) {
      throw new SubMerchantError(
        `settlingParty "${settlingParty}" is not supported. A sub-merchant settles into its own ledger account ` +
          `("${SETTLING_PARTY_SELF}") because settling one out of ours is acquiring, and acquiring is a sponsor bank ` +
          'and an acquiring BIN — a commercial relationship no code closes. The column exists so adopting a partner ' +
          'later is configuration rather than a rewrite; it is not a switch this service can throw.',
        'pay.submerchant_settling_party_unsupported',
        { settlingParty, supported: [SETTLING_PARTY_SELF] },
      );
    }

    if (!Number.isInteger(input.pricing.feeBps) || input.pricing.feeBps < 0 || input.pricing.feeBps > 10_000) {
      throw new SubMerchantError('feeBps must be an integer between 0 and 10000', 'pay.submerchant_pricing_invalid');
    }

    return transaction(
      this.sql,
      async (tx) => {
        const parentChain = await this.assertWithinSubtree(input.actorMerchantId, input.parentMerchantId, tx);
        await this.assertHolds(input.actorMerchantId, input.parentMerchantId, 'submerchant', tx, parentChain);

        // `parentChain` is [parent, …, root], so its length is the parent's
        // depth + 1, and the child would sit one below that.
        const childDepth = parentChain.length;
        if (childDepth > MAX_SUBMERCHANT_DEPTH) {
          throw new SubMerchantError(
            `A sub-merchant under ${input.parentMerchantId} would sit ${childDepth} levels below the root, and the ` +
              `structural bound is ${MAX_SUBMERCHANT_DEPTH}. This is a safety bound, not a product rule — ` +
              'MAX_SUBMERCHANT_DEPTH in submerchants.ts is the one number to change.',
            'pay.submerchant_too_deep',
            { depth: childDepth, max: MAX_SUBMERCHANT_DEPTH },
          );
        }

        await tx`
          INSERT INTO pay.merchants (user_id, parent_merchant_id, mode, status, pricing, settlement_prefs, settling_party)
          VALUES (
            ${input.userId}, ${input.parentMerchantId}, 'payfac', 'pending',
            ${tx.json(input.pricing as never)},
            ${tx.json((input.settlementPrefs ?? {}) as never)},
            ${settlingParty}
          )
          ON CONFLICT (user_id) DO NOTHING
        `;

        const rows = await tx<MerchantNodeRow[]>`
          SELECT id, user_id, parent_merchant_id, mode, status, kyb_status, settling_party, pricing, created_at
            FROM pay.merchants WHERE user_id = ${input.userId}
        `;
        const row = rows[0];
        if (!row) {
          throw new SubMerchantError(`Sub-merchant for user ${input.userId} not found after insert`, 'pay.merchant_not_found');
        }

        if (row.parent_merchant_id !== input.parentMerchantId) {
          // The account already had a merchant, and it is not this node's child.
          // Adopting it would give the actor authority over a merchant that
          // existed before them, which no onboarding call is entitled to do.
          throw new SubMerchantError(
            `Account ${input.userId} is already a merchant${
              row.parent_merchant_id === null ? ' in its own right' : ' under another parent'
            }. One merchant per sovereign account is a database rule, and onboarding does not adopt an existing one.`,
            'pay.submerchant_user_already_merchant',
            { merchantId: row.id },
          );
        }

        // THE CONSERVATIVE DEFAULT, and the whole of it.
        //
        // Every STRICT ancestor except the root receives the read-shaped areas
        // in `DEFAULT_GRANTED_AREAS`, and nothing else. The root is skipped
        // because it already holds every area over its whole tree implicitly, so
        // a row for it would be a grant that cannot be revoked — an operator
        // reading the journal would think revoking it did something.
        //
        // Ancestors rather than only the parent: in a payfac the node at the top
        // carries the liability for everyone underneath (spec §2), and a
        // structure whose upper nodes cannot see who was onboarded beneath them
        // is not one anybody can be liable for.
        const strictAncestors = parentChain.slice(0, Math.max(parentChain.length - 1, 0));
        for (const ancestor of strictAncestors) {
          for (const area of DEFAULT_GRANTED_AREAS) {
            const existing = await this.latestEvent(ancestor, row.id, area, tx);
            // A retried onboarding must not resurrect an area somebody revoked.
            if (existing !== null) continue;
            await tx`
              INSERT INTO pay.merchant_permission_events
                (grantee_merchant_id, subject_merchant_id, area, action, reason, actor_id, actor_merchant_id, actor_scope)
              VALUES (
                ${ancestor}, ${row.id}, ${area}, 'grant',
                'default grant at onboarding — visibility only, no value-moving area',
                ${input.actorId}, ${input.actorMerchantId}, ${input.actorScope}
              )
            `;
          }
        }

        return toRecord(row, childDepth);
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  /**
   * The DIRECT children of a node — not the whole subtree.
   *
   * Direct children because that is the shape a console renders one level at a
   * time, and because a flattened subtree answer would hand a caller the whole
   * structure in one response, which is a different disclosure decision from the
   * one `submerchant` permission expresses.
   */
  async listSubMerchants(actorMerchantId: string, merchantId: string, limit?: number): Promise<SubMerchantRecord[]> {
    const page = assertSubMerchantListLimit(limit);
    const chain = await this.assertWithinSubtree(actorMerchantId, merchantId);
    await this.assertHolds(actorMerchantId, merchantId, 'submerchant', this.sql, chain);

    const rows = await this.sql<MerchantNodeRow[]>`
      SELECT id, user_id, parent_merchant_id, mode, status, kyb_status, settling_party, pricing, created_at
        FROM pay.merchants
       WHERE parent_merchant_id = ${merchantId}
       ORDER BY created_at ASC
       LIMIT ${page}
    `;
    // The parent's depth is `chain.length - 1` from the subject's own walk, so
    // every child sits one below it. No second walk per row.
    const childDepth = chain.length;
    return rows.map((r) => toRecord(r, childDepth));
  }

  /**
   * One sub-merchant's record.
   *
   * Gated on `merchant.profile`, not on `submerchant`: seeing that a node exists
   * beneath you and reading its pricing band and status are different questions,
   * and a node may legitimately be delegated one without the other.
   */
  async getSubMerchant(actorMerchantId: string, merchantId: string): Promise<SubMerchantRecord> {
    const chain = await this.assertWithinSubtree(actorMerchantId, merchantId);
    await this.assertHolds(actorMerchantId, merchantId, 'merchant.profile', this.sql, chain);

    const rows = await this.sql<MerchantNodeRow[]>`
      SELECT id, user_id, parent_merchant_id, mode, status, kyb_status, settling_party, pricing, created_at
        FROM pay.merchants WHERE id = ${merchantId}
    `;
    const row = rows[0];
    if (!row) throw new SubMerchantError(`No merchant ${merchantId}`, 'pay.merchant_not_found');
    return toRecord(row, chain.length - 1);
  }

  /**
   * The shared rule behind `grant` and `revoke`. Both are the same authority
   * question asked once, which is why it is one function: a revoke that could be
   * performed by somebody who could not have granted is a privilege escalation
   * dressed as a cleanup.
   */
  private async assertMayDelegate(input: PermissionChangeInput, tx: Sql): Promise<void> {
    if (!isPermissionArea(input.area)) {
      throw new SubMerchantError(`Unknown permission area "${input.area}"`, 'pay.submerchant_area_unknown', {
        known: PERMISSION_AREAS,
      });
    }
    if (input.granteeMerchantId === input.subjectMerchantId) {
      throw new SubMerchantError(
        'A merchant already holds every area over its own node; a grant to itself would be a row that can be revoked without taking anything away.',
        'pay.submerchant_grant_self',
      );
    }
    if (input.granteeMerchantId === input.actorMerchantId) {
      throw new SubMerchantError(
        'A node cannot grant to itself. Authority flows down: it comes from being the root of the tree, or from a ' +
          'grant made by somebody above you. A self-grant would make the whole mechanism decorative.',
        'pay.submerchant_grant_self',
      );
    }

    // SCOPE, twice. The subject and the grantee must both be inside the actor's
    // subtree, or an actor could name a stranger as grantee and learn from the
    // refusal whether that stranger exists.
    const subjectChain = await this.assertWithinSubtree(input.actorMerchantId, input.subjectMerchantId, tx);
    await this.assertWithinSubtree(input.actorMerchantId, input.granteeMerchantId, tx);

    // NO LATERAL GRANTS. The grantee has to be ON THE PATH between the actor and
    // the subject — an ancestor of the subject. Otherwise a payfac could hand
    // one child authority over another child, which is the exact disclosure the
    // subtree fence exists to prevent, arranged by consent nobody asked the
    // subject for.
    if (!subjectChain.includes(input.granteeMerchantId)) {
      throw new SubMerchantError(
        `Merchant ${input.granteeMerchantId} is not an ancestor of ${input.subjectMerchantId}, so it cannot hold a ` +
          'permission over it. Permissions follow the tree; they are never lateral.',
        'pay.submerchant_grant_lateral',
      );
    }

    // AND THE GRANTER MUST ALREADY HOLD IT. Delegation passes on what you have.
    await this.assertHolds(input.actorMerchantId, input.subjectMerchantId, input.area, tx, subjectChain);
  }

  /** Delegate an area over a descendant to a node between the actor and it. */
  async grantPermission(input: PermissionChangeInput): Promise<PermissionEventRecord> {
    return this.appendPermissionEvent(input, 'grant');
  }

  /**
   * Take it back. A NEW ROW, never an edit — the trigger on the table refuses
   * anything else, and the journal has to be able to say that authority existed
   * between two dates.
   */
  async revokePermission(input: PermissionChangeInput): Promise<PermissionEventRecord> {
    return this.appendPermissionEvent(input, 'revoke');
  }

  private async appendPermissionEvent(input: PermissionChangeInput, action: 'grant' | 'revoke'): Promise<PermissionEventRecord> {
    const reason = input.reason.trim();
    if (reason.length === 0) {
      throw new SubMerchantError(
        'A permission change requires a reason. "Why does this node hold refund authority over that one" must be ' +
          'answerable from the database, and it is not answerable from an empty string.',
        'pay.submerchant_reason_required',
      );
    }

    return transaction(
      this.sql,
      async (tx) => {
        // Money owner prepares/grants under SHARE on this same subject row.
        // Permission changes must serialize with that guard, not a read snapshot.
        await tx`SELECT id FROM pay.merchants WHERE id=${input.subjectMerchantId} FOR UPDATE`;
        await this.assertMayDelegate(input, tx);

        const current = await this.latestEvent(input.granteeMerchantId, input.subjectMerchantId, input.area, tx);
        const held = current !== null && current.action === 'grant';
        if ((action === 'grant' && held) || (action === 'revoke' && !held)) {
          // A no-op writes nothing. A journal full of re-grants is a journal
          // nobody reads, and a history nobody reads is how the real rows get
          // missed — the same rule `merchant-state-service.ts` follows.
          throw new SubMerchantError(
            action === 'grant'
              ? `Merchant ${input.granteeMerchantId} already holds "${input.area}" over ${input.subjectMerchantId}`
              : `Merchant ${input.granteeMerchantId} does not hold "${input.area}" over ${input.subjectMerchantId}`,
            action === 'grant' ? 'pay.submerchant_grant_redundant' : 'pay.submerchant_revoke_redundant',
          );
        }
        if (action === 'revoke' && current && (await pendingPayfacPermissionIntentCount(tx, current))) {
          if (!this.drainPermissionIntents)
            throw new SubMerchantError('Identity admission drain is unavailable', 'pay.identity_admission_unavailable');
          try {
            await this.drainPermissionIntents(tx, current);
            if (await pendingPayfacPermissionIntentCount(tx, current)) throw new Error('Incomplete identity admission drain');
          } catch {
            throw new SubMerchantError('Pending identity decisions prevent permission cutoff', 'pay.identity_admission_unavailable');
          }
        }

        const rows = await tx<PermissionEventRow[]>`
          INSERT INTO pay.merchant_permission_events
            (grantee_merchant_id, subject_merchant_id, area, action, reason, actor_id, actor_merchant_id, actor_scope)
          VALUES (
            ${input.granteeMerchantId}, ${input.subjectMerchantId}, ${input.area}, ${action}, ${reason},
            ${input.actorId}, ${input.actorMerchantId}, ${input.actorScope}
          )
          RETURNING id, seq, grantee_merchant_id, subject_merchant_id, area, action, reason,
                    actor_id, actor_merchant_id, actor_scope, created_at
        `;
        const row = rows[0];
        if (!row) {
          throw new SubMerchantError(
            `The ${action} of "${input.area}" was applied but the journal row was not returned. The change has been rolled back.`,
            'pay.submerchant_permission_not_written',
          );
        }
        return toEvent(row);
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  /**
   * The LIVE grants over one node — what a console shows next to a sub-merchant.
   *
   * Derived from the journal rather than stored beside it, so there is one truth
   * about who holds what. Implicit authority (the root's, and the node's over
   * itself) is deliberately NOT synthesised into this list: it is not a grant,
   * it cannot be revoked, and printing it as a row would suggest otherwise.
   */
  async listPermissions(actorMerchantId: string, subjectMerchantId: string, limit?: number): Promise<PermissionGrantRecord[]> {
    const page = assertPermissionListLimit(limit);
    const chain = await this.assertWithinSubtree(actorMerchantId, subjectMerchantId);
    await this.assertHolds(actorMerchantId, subjectMerchantId, 'permission', this.sql, chain);

    const rows = await this.sql<PermissionEventRow[]>`
      SELECT id, seq, grantee_merchant_id, subject_merchant_id, area, action, reason,
             actor_id, actor_merchant_id, actor_scope, created_at
        FROM (
          SELECT DISTINCT ON (grantee_merchant_id, area)
                 id, seq, grantee_merchant_id, subject_merchant_id, area, action, reason,
                 actor_id, actor_merchant_id, actor_scope, created_at
            FROM pay.merchant_permission_events
           WHERE subject_merchant_id = ${subjectMerchantId}
           ORDER BY grantee_merchant_id, area, seq DESC
        ) latest
       WHERE action = 'grant'
       ORDER BY created_at DESC
       LIMIT ${page}
    `;

    return rows.map((r) => ({
      granteeMerchantId: r.grantee_merchant_id,
      subjectMerchantId: r.subject_merchant_id,
      area: r.area as PermissionArea,
      reason: r.reason,
      actorId: r.actor_id,
      actorMerchantId: r.actor_merchant_id,
      grantedAt: r.created_at,
    }));
  }

  /**
   * The full journal for one node, newest first — grants AND revokes.
   *
   * Newest first for the same reason the merchant status history is: the
   * question is almost always about what is true now, and the row that explains
   * it is the last one written.
   */
  async permissionHistory(actorMerchantId: string, subjectMerchantId: string, limit?: number): Promise<PermissionEventRecord[]> {
    const page = assertPermissionHistoryLimit(limit);
    const chain = await this.assertWithinSubtree(actorMerchantId, subjectMerchantId);
    await this.assertHolds(actorMerchantId, subjectMerchantId, 'permission', this.sql, chain);

    const rows = await this.sql<PermissionEventRow[]>`
      SELECT id, seq, grantee_merchant_id, subject_merchant_id, area, action, reason,
             actor_id, actor_merchant_id, actor_scope, created_at
        FROM pay.merchant_permission_events
       WHERE subject_merchant_id = ${subjectMerchantId}
       ORDER BY seq DESC
       LIMIT ${page}
    `;
    return rows.map(toEvent);
  }
}
