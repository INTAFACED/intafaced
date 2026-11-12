import type postgres from 'postgres';
import { transaction } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client';
import { INVITEE_LIST_LIMIT, type CampaignReferral, type MyInvitee, type MyInvitees } from '@intafaced/contracts/campaigns-catalogue';
import type { MarketNames } from './markets.js';

/**
 * Referral programmes: who each invitee is, and how far they are towards qualifying (CM-referral-02, J-campaigns-06).
 *
 * - An invitee is kept once, from `identity.referral.created`, under the `referral` campaign live at the moment they were
 *   attached (the one started last), with that programme's terms copied: a later revision never changes what an invitee
 *   is measured by (RF-6). An invitee attached while none was live has no programme and nothing is tracked for them.
 * - Their own events count, each once by its event id, and only inside the programme's window from the attach: a
 *   verification (`identity.kyc.approved`, at the tier the programme names or above), a crypto deposit svc-pay credited
 *   (`pay.deposit_credit.posted`, in the programme's asset) and a settled spot fill (`trade.fill.settled`, its quote
 *   amount, on a market quoted in that asset). Nothing else is a deposit: a move between the invitee's own wallet and venue
 *   accounts, a bonus, a trial fund or a gift sends no such event, so it never counts (ENGINE EL-8).
 * - Qualified is written once, under a lock on the invitee, the first time every criterion holds; a redelivered or later
 *   event changes nothing. No money moves here (CM-referral-03 pays the rewards).
 * - The referrer reads a bounded summary of each invitee (ENGINE EL-6): when they joined, each step done or not, and the
 *   summary state, never who they are, an amount or an event.
 */

type Sql = postgres.Sql;

export type ReferralEventKind = 'verified' | 'deposit' | 'fill';

type InviteeRow = {
  invitee_id: string;
  referrer_id: string;
  attached_at: Date;
  campaign_id: string | null;
  revision: number | null;
  terms: CampaignReferral | null;
  qualified_at: Date | null;
};

type Totals = { verified: boolean; deposited: string; traded: string };

const TIER_RANK: Record<string, number> = { basic: 1, full: 2, institutional: 3 };

/** Whether a verification tier meets the programme's: `full` is met by full or institutional, `basic` by any. */
export function tierMeets(tier: string | null, needed: 'basic' | 'full' | null): boolean {
  if (!tier || !needed) return false;
  return (TIER_RANK[tier] ?? 0) >= TIER_RANK[needed]!;
}

/** The quote asset of a market symbol such as `BTC/USDT`; null for anything else. */
export function quoteOf(symbol: string | null): string | null {
  const m = symbol ? /^[A-Z0-9]{2,12}\/([A-Z0-9]{2,12})$/.exec(symbol) : null;
  return m ? m[1]! : null;
}

/** When an invitee's window closes: the attach plus the programme's seconds; null while either is blank. */
export function windowClosesAt(attachedAt: Date, terms: CampaignReferral | null): Date | null {
  const seconds = terms?.criteria.windowSeconds ?? null;
  return seconds === null ? null : new Date(attachedAt.getTime() + seconds * 1000);
}

/**
 * Each step done or not, from what the invitee's counted events add up to. A blank criterion is never met: a programme
 * with one cannot go live, so this only guards a stored row.
 */
export function stepsOf(terms: CampaignReferral, totals: Totals): MyInvitee['steps'] {
  const c = terms.criteria;
  const atLeast = (have: string, min: string | null) => min !== null && parseAmount(have) >= parseAmount(min);
  return {
    verified: totals.verified,
    deposited: atLeast(totals.deposited, c.depositMin),
    traded: atLeast(totals.traded, c.tradeVolumeMin),
  };
}

export class ReferralService {
  private readonly sql: Sql;
  private readonly markets: MarketNames | null;
  private readonly now: () => Date;

  constructor(deps: { sql: Sql; markets: MarketNames | null; now?: () => Date }) {
    this.sql = deps.sql;
    this.markets = deps.markets;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * An invitee was attached to their referrer. Kept once by the invitee, under the referral campaign that was live then
   * (read now: the attach may arrive late, so one paused or ended since still counts if it ran then). Returns whether it
   * was new.
   */
  async onAttached(input: { userId: string; referrerId: string; attachedAt: string }): Promise<boolean> {
    const at = new Date(input.attachedAt);
    if (Number.isNaN(at.getTime())) return false;
    const [campaign] = await this.sql<{ id: string; revision: number; referral: CampaignReferral | null }[]>`
      SELECT id, revision, referral FROM campaigns.campaigns
      WHERE type = 'referral' AND referral IS NOT NULL AND state IN ('scheduled', 'active', 'paused', 'ended', 'closed')
        AND starts_at <= ${at} AND (ends_at IS NULL OR ends_at > ${at})
      ORDER BY (state IN ('scheduled', 'active')) DESC, starts_at DESC, created_at DESC LIMIT 1`;
    const made = await this.sql`
      INSERT INTO campaigns.referral_invitees (invitee_id, referrer_id, attached_at, campaign_id, revision, terms)
      VALUES (${input.userId.toLowerCase()}, ${input.referrerId.toLowerCase()}, ${at}, ${campaign?.id ?? null},
        ${campaign?.revision ?? null}, ${campaign?.referral ? this.sql.json(campaign.referral as unknown as postgres.JSONValue) : null})
      ON CONFLICT (invitee_id) DO NOTHING`;
    return made.count > 0;
  }

  /** A verification tier was granted to an account. */
  onVerified(input: { userId: string; tier: string; eventId: string; at: string }): Promise<boolean> {
    return this.record(input.userId, 'verified', input.eventId, input.at, { tier: input.tier });
  }

  /** A crypto deposit was credited to an account. */
  onDeposit(input: { userId: string; depositId: string; asset: string; amount: string; at: string }): Promise<boolean> {
    return this.record(input.userId, 'deposit', input.depositId, input.at, { asset: input.asset, amount: input.amount });
  }

  /**
   * A spot fill settled for an account. The market is named only for an invitee with a programme; an unreachable market
   * list throws, so the fill comes again.
   */
  async onFill(input: { userId: string; fillId: string; marketId: string; quoteAmount: string; at: string }): Promise<boolean> {
    const invitee = await this.inviteeOf(this.sql, input.userId);
    if (!invitee?.terms) return false;
    if (!this.markets) return false;
    const asset = quoteOf(await this.markets.symbolOf(input.marketId));
    if (!asset) return false;
    return this.record(input.userId, 'fill', input.fillId, input.at, { asset, amount: input.quoteAmount });
  }

  /**
   * Keeps one counted event, once by its id, and qualifies the invitee the first time every criterion holds. Only an
   * invitee with a programme keeps events, and only those inside the window and in the programme's asset or tier.
   */
  private async record(
    userId: string,
    kind: ReferralEventKind,
    eventId: string,
    rawAt: string,
    detail: { asset?: string; amount?: string; tier?: string },
  ): Promise<boolean> {
    const at = new Date(rawAt);
    if (Number.isNaN(at.getTime())) return false;
    return transaction(this.sql, async (tx) => {
      const [invitee] = await tx<InviteeRow[]>`
        SELECT * FROM campaigns.referral_invitees WHERE invitee_id = ${userId.toLowerCase()} FOR UPDATE`;
      if (!invitee?.terms) return false;
      const terms = invitee.terms;
      const closes = windowClosesAt(invitee.attached_at, terms);
      if (at < invitee.attached_at || !closes || at > closes) return false;
      if (kind === 'verified' && !tierMeets(detail.tier ?? null, terms.criteria.verification)) return false;
      if (kind !== 'verified' && detail.asset !== terms.criteria.asset) return false;
      const made = await tx`
        INSERT INTO campaigns.referral_events (invitee_id, kind, event_id, occurred_at, asset, amount, tier)
        VALUES (${invitee.invitee_id}, ${kind}, ${eventId}, ${at}, ${detail.asset ?? null}, ${detail.amount ?? null},
          ${detail.tier ?? null})
        ON CONFLICT (invitee_id, kind, event_id) DO NOTHING`;
      if (made.count === 0 || invitee.qualified_at) return made.count > 0;
      const steps = stepsOf(terms, await this.totals(tx, invitee.invitee_id));
      if (steps.verified && steps.deposited && steps.traded) {
        await tx`
          UPDATE campaigns.referral_invitees SET qualified_at = now(), updated_at = now()
          WHERE invitee_id = ${invitee.invitee_id} AND qualified_at IS NULL`;
        await tx`
          INSERT INTO campaigns.audit_log (actor, action, target, detail)
          VALUES (${invitee.invitee_id}, ${'campaign.referral.qualify'}, ${invitee.campaign_id!},
            ${tx.json({ referrer: invitee.referrer_id, revision: invitee.revision })})`;
      }
      return true;
    });
  }

  private async inviteeOf(sql: Sql, userId: string): Promise<InviteeRow | null> {
    const [row] = await sql<InviteeRow[]>`SELECT * FROM campaigns.referral_invitees WHERE invitee_id = ${userId.toLowerCase()}`;
    return row ?? null;
  }

  private async totals(sql: Sql, inviteeId: string): Promise<Totals> {
    const [row] = await sql<{ verified: boolean; deposited: string; traded: string }[]>`
      SELECT bool_or(kind = 'verified') IS TRUE AS verified,
        COALESCE(sum(amount) FILTER (WHERE kind = 'deposit'), 0)::text AS deposited,
        COALESCE(sum(amount) FILTER (WHERE kind = 'fill'), 0)::text AS traded
      FROM campaigns.referral_events WHERE invitee_id = ${inviteeId}`;
    return { verified: row?.verified ?? false, deposited: row?.deposited ?? '0', traded: row?.traded ?? '0' };
  }

  /** The caller's own invitees, in the order they joined, each as the bounded summary. */
  async myInvitees(input: { referrerId: string }): Promise<MyInvitees> {
    const referrer = input.referrerId.toLowerCase();
    const [{ total } = { total: 0 }] = await this.sql<{ total: number }[]>`
      SELECT count(*)::int AS total FROM campaigns.referral_invitees WHERE referrer_id = ${referrer}`;
    const rows = await this.sql<(InviteeRow & Totals & { name: string | null })[]>`
      SELECT i.*, c.name,
        COALESCE(bool_or(e.kind = 'verified'), false) AS verified,
        COALESCE(sum(e.amount) FILTER (WHERE e.kind = 'deposit'), 0)::text AS deposited,
        COALESCE(sum(e.amount) FILTER (WHERE e.kind = 'fill'), 0)::text AS traded
      FROM campaigns.referral_invitees i
      LEFT JOIN campaigns.campaigns c ON c.id = i.campaign_id
      LEFT JOIN campaigns.referral_events e ON e.invitee_id = i.invitee_id
      WHERE i.referrer_id = ${referrer}
      GROUP BY i.invitee_id, c.name
      ORDER BY i.attached_at, i.invitee_id
      LIMIT ${INVITEE_LIST_LIMIT}`;
    const now = this.now();
    return {
      total,
      invitees: rows.map((r, index) => {
        const closes = windowClosesAt(r.attached_at, r.terms);
        const steps = r.terms
          ? stepsOf(r.terms, { verified: r.verified, deposited: r.deposited, traded: r.traded })
          : { verified: false, deposited: false, traded: false };
        const state: MyInvitee['state'] = !r.terms
          ? 'no_programme'
          : r.qualified_at
            ? 'qualified'
            : closes && now > closes
              ? 'window_closed'
              : 'in_progress';
        return {
          place: index + 1,
          attachedAt: r.attached_at.toISOString(),
          state,
          steps,
          qualifiedAt: r.qualified_at ? r.qualified_at.toISOString() : null,
          windowClosesAt: closes ? closes.toISOString() : null,
          programme: r.campaign_id && r.name ? { id: r.campaign_id, name: r.name } : null,
        };
      }),
    };
  }
}
