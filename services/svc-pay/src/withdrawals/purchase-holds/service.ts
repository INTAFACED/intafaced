import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { parseAmount, type Amount } from '@intafaced/ledger-client';
import { PurchaseHoldError } from './errors.js';
import type { HeldView, HoldView, ListInput, PolicyView, RecordInput, ReleaseResult, SetPolicyInput } from './schemas.js';

/**
 * Purchase holds (W-withdraw-13, wallet-withdraw-047). A purchase by card, ACH or PayPal lands in the customer's
 * ledger balance as usual and stays tradable; the amount recorded here cannot LEAVE as a withdrawal until it is
 * released. Nothing is booked and no balance lives here: the ledger hold-bucket recipe is a named ledger-owner job
 * (X-6), so this is a limit on what may leave, checked at the withdrawal door and shown in eligibility.
 *
 * The release period is owner-set. With no period nothing is released and a withdrawal of held funds refuses with a
 * typed error; the period is never guessed. Release is one row per hold, so releasing twice releases once.
 */
export interface PurchaseHoldServiceDeps {
  readonly sql: Sql;
  /** Injected for tests; production uses the wall clock. */
  readonly now?: () => Date;
}

interface HoldRow {
  id: string;
  hold_ref: string;
  user_id: string;
  asset_id: string;
  amount: string;
  rail: 'card' | 'ach' | 'paypal';
  purchased_at: Date;
  recorded_by: string;
  recorded_at: Date;
  released_at: Date | null;
  hold_seconds: number | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function view(r: HoldRow): HoldView {
  return {
    id: r.id,
    holdRef: r.hold_ref,
    userId: r.user_id,
    assetId: r.asset_id,
    amount: r.amount,
    rail: r.rail,
    purchasedAt: r.purchased_at.toISOString(),
    state: r.released_at ? 'released' : 'held',
    releaseAt: r.hold_seconds == null ? null : new Date(r.purchased_at.getTime() + r.hold_seconds * 1000).toISOString(),
    releasedAt: iso(r.released_at),
    recordedBy: r.recorded_by,
    recordedAt: r.recorded_at.toISOString(),
  };
}

export class PurchaseHoldService {
  private readonly now: () => Date;
  constructor(private readonly deps: PurchaseHoldServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Record a purchase hold. Idempotent on `holdRef`: the same terms return the same hold, different terms refuse. */
  async record(actor: string, input: RecordInput): Promise<HoldView> {
    if (parseAmount(input.amount) <= 0n) throw new PurchaseHoldError('purchase_hold.amount_invalid', 'a hold is a positive amount');
    return transaction(this.deps.sql, async (tx) => {
      await tx`
        INSERT INTO pay.purchase_holds (hold_ref, user_id, asset_id, amount, rail, purchased_at, recorded_by)
        VALUES (${input.holdRef}, ${input.userId}, ${input.assetId}, ${input.amount}::numeric, ${input.rail}, ${input.purchasedAt}::timestamptz, ${actor})
        ON CONFLICT (hold_ref) DO NOTHING`;
      const [existing] = await tx<HoldRow[]>`
        SELECT h.id, h.hold_ref, h.user_id, h.asset_id, h.amount::text AS amount, h.rail, h.purchased_at, h.recorded_by,
               h.recorded_at, r.released_at,
               (SELECT hold_seconds FROM pay.purchase_hold_policy_events ORDER BY seq DESC LIMIT 1) AS hold_seconds
          FROM pay.purchase_holds h LEFT JOIN pay.purchase_hold_releases r ON r.hold_id = h.id
         WHERE h.hold_ref = ${input.holdRef}`;
      const same =
        existing !== undefined &&
        existing.user_id === input.userId &&
        existing.asset_id === input.assetId &&
        existing.rail === input.rail &&
        parseAmount(existing.amount) === parseAmount(input.amount) &&
        existing.purchased_at.getTime() === new Date(input.purchasedAt).getTime();
      if (!same) throw new PurchaseHoldError('purchase_hold.ref_differs', 'that hold reference already names a different purchase');
      return view(existing);
    });
  }

  async list(input: ListInput): Promise<HoldView[]> {
    const rows = await this.deps.sql<HoldRow[]>`
      SELECT h.id, h.hold_ref, h.user_id, h.asset_id, h.amount::text AS amount, h.rail, h.purchased_at, h.recorded_by,
             h.recorded_at, r.released_at,
             (SELECT hold_seconds FROM pay.purchase_hold_policy_events ORDER BY seq DESC LIMIT 1) AS hold_seconds
        FROM pay.purchase_holds h LEFT JOIN pay.purchase_hold_releases r ON r.hold_id = h.id
       WHERE (${input.userId ?? null}::uuid IS NULL OR h.user_id = ${input.userId ?? null}::uuid)
         AND (${input.assetId ?? null}::text IS NULL OR h.asset_id = ${input.assetId ?? null}::text)
         AND (${input.state ?? null}::text IS NULL
              OR (${input.state ?? null}::text = 'released' AND r.hold_id IS NOT NULL)
              OR (${input.state ?? null}::text = 'held' AND r.hold_id IS NULL))
       ORDER BY h.recorded_at DESC, h.id DESC
       LIMIT ${input.limit}`;
    return rows.map(view);
  }

  async policy(): Promise<PolicyView> {
    const [row] = await this.deps.sql<Array<{ hold_seconds: number; set_by: string; set_at: Date }>>`
      SELECT hold_seconds, set_by, set_at FROM pay.purchase_hold_policy_events ORDER BY seq DESC LIMIT 1`;
    return row
      ? { holdSeconds: row.hold_seconds, setBy: row.set_by, setAt: row.set_at.toISOString() }
      : { holdSeconds: null, setBy: null, setAt: null };
  }

  /** Set the release period. Appended, never edited; the latest row is the period. */
  async setPolicy(actor: string, input: SetPolicyInput): Promise<PolicyView> {
    await this.deps.sql`INSERT INTO pay.purchase_hold_policy_events (hold_seconds, set_by) VALUES (${input.holdSeconds}, ${actor})`;
    return this.policy();
  }

  /**
   * Release every hold whose period has elapsed. Idempotent: a hold has one release row, so a second run (or a
   * concurrent one) releases nothing new. With no period set it releases nothing.
   */
  async releaseDue(actor: string): Promise<ReleaseResult> {
    const asOf = this.now();
    const rows = await this.deps.sql<Array<{ hold_id: string }>>`
      INSERT INTO pay.purchase_hold_releases (hold_id, released_at, released_by, basis)
      SELECT h.id, ${asOf}::timestamptz, ${actor}, 'period_elapsed'
        FROM pay.purchase_holds h, (SELECT hold_seconds FROM pay.purchase_hold_policy_events ORDER BY seq DESC LIMIT 1) p
       WHERE h.purchased_at + make_interval(secs => p.hold_seconds) <= ${asOf}::timestamptz
         AND NOT EXISTS (SELECT 1 FROM pay.purchase_hold_releases r WHERE r.hold_id = h.id)
      ON CONFLICT (hold_id) DO NOTHING
      RETURNING hold_id`;
    return { released: rows.map((r) => r.hold_id) };
  }

  /** What is still held for one customer and asset. Releases due holds first, so the answer is current. */
  async held(userId: string, assetId: string): Promise<HeldView> {
    await this.releaseDue('system:purchase-hold-release');
    const [row] = await this.deps.sql<Array<{ total: string; holds: string; earliest: Date | null; hold_seconds: number | null }>>`
      SELECT coalesce(sum(h.amount), 0)::text AS total, count(h.id)::text AS holds,
             min(h.purchased_at) AS earliest,
             (SELECT hold_seconds FROM pay.purchase_hold_policy_events ORDER BY seq DESC LIMIT 1) AS hold_seconds
        FROM pay.purchase_holds h
       WHERE h.user_id = ${userId} AND h.asset_id = ${assetId}
         AND NOT EXISTS (SELECT 1 FROM pay.purchase_hold_releases r WHERE r.hold_id = h.id)`;
    const periodSet = row?.hold_seconds != null;
    return {
      heldAmount: row?.total ?? '0',
      holds: Number(row?.holds ?? 0),
      periodSet,
      earliestReleaseAt: periodSet && row?.earliest ? new Date(row.earliest.getTime() + row.hold_seconds! * 1000).toISOString() : null,
    };
  }

  /** The guard the withdrawal door and the eligibility read use. */
  guard() {
    return {
      held: async (
        userId: string,
        assetId: string,
      ): Promise<{ heldAmount: Amount; periodSet: boolean; earliestReleaseAt: string | null }> => {
        const h = await this.held(userId, assetId);
        return { heldAmount: parseAmount(h.heldAmount), periodSet: h.periodSet, earliestReleaseAt: h.earliestReleaseAt };
      },
    };
  }
}

export type PurchaseHoldGuard = ReturnType<PurchaseHoldService['guard']>;
