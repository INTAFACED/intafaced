/**
 * WHAT THE STOPS REFUSED, COUNTED (project-state #1790; the money model's change 4 item 4, approved 10 Nov 2026).
 *
 * Every partner instruction svc-bank refuses before the partner is asked is counted here, by day (UTC), by what refused
 * it (`posting_freeze` or `partner_stop`), by why (the freeze's cause: `person`, `mismatch`, `unfinished_proofs`,
 * `startup_setting`, `not_reported`, `unreadable`, `not_wired`; the stop's: `stopped`, `unreadable`) and by kind
 * (`bank_move`, `card_hold`, `card_capture`, `card_release`, `card_refund`). A refused card hold is a declined card
 * authorisation, so the desk reads card authorisations refused, by reason, here too.
 *
 * Counting never changes a refusal: a count that cannot be written is dropped, and the refusal is thrown as before.
 * The desk read names the first day counted, so a count is never read as covering days before it existed.
 */
import { scopedProcedure } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { FREEZE_CAUSES, readFreeze, type FreezeCause, type PartnerRefusal, type PostingFreeze } from './partner-bank.js';
import { PARTNER_STOP_KINDS, type PartnerStopService } from './partner-stops.js';

export interface PartnerRefusalCount {
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  refusedBy: PartnerRefusal['refusedBy'];
  cause: string;
  kind: string;
  /** A count, as a decimal string. */
  count: string;
}

export class PartnerRefusalCounts {
  constructor(private readonly sql: Sql) {}

  /** Adds one. Never throws. */
  readonly note = async (refusal: PartnerRefusal): Promise<void> => {
    try {
      await this.sql`
        INSERT INTO bank.partner_refusal_counts (day, refused_by, cause, kind, count)
        VALUES ((now() AT TIME ZONE 'UTC')::date, ${refusal.refusedBy}, ${refusal.cause}, ${refusal.kind}, 1)
        ON CONFLICT (day, refused_by, cause, kind) DO UPDATE SET count = bank.partner_refusal_counts.count + 1
      `;
    } catch {
      // The refusal stands whatever happens here: a dropped count is an undercount, never a move.
    }
  };

  /** The last `days` UTC days, newest first, and the first day ever counted (null when nothing was ever refused). */
  async recent(days: number): Promise<{ firstDay: string | null; counts: PartnerRefusalCount[] }> {
    const rows = await this.sql<
      Array<{ day: string; refused_by: PartnerRefusal['refusedBy']; cause: string; kind: string; count: string }>
    >`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, refused_by, cause, kind, count::text AS count
        FROM bank.partner_refusal_counts
       WHERE day > (now() AT TIME ZONE 'UTC')::date - ${days}::int
       ORDER BY day DESC, refused_by, cause, kind
    `;
    const [first] = await this.sql<Array<{ first: string | null }>>`
      SELECT to_char(min(day), 'YYYY-MM-DD') AS first FROM bank.partner_refusal_counts
    `;
    return {
      firstDay: first?.first ?? null,
      counts: rows.map((r) => ({ day: r.day, refusedBy: r.refused_by, cause: r.cause, kind: r.kind, count: r.count })),
    };
  }
}

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Desk read: whether posting is enabled and, when not, why; which partner kinds are stopped; and what both refused, by
 * reason. `days` is required: a blank window is not a default.
 */
export function partnerRefusalsProcedure(
  deps: () => { counts: PartnerRefusalCounts; stops: PartnerStopService; freeze: PostingFreeze },
  guard: Guard,
) {
  return scopedProcedure('admin:read')
    .input(z.object({ days: z.number().int().min(1).max(90) }))
    .output(
      z.object({
        freeze: z.object({ postingEnabled: z.boolean(), cause: z.enum(FREEZE_CAUSES).nullable(), owner: z.literal('svc-ledger') }),
        stops: z.array(z.object({ partnerId: z.string(), stoppedKinds: z.array(z.enum(PARTNER_STOP_KINDS)), revision: z.number().int() })),
        firstDay: z.string().nullable(),
        counts: z.array(
          z.object({
            day: z.string(),
            refusedBy: z.enum(['posting_freeze', 'partner_stop']),
            cause: z.string(),
            kind: z.string(),
            count: z.string(),
          }),
        ),
      }),
    )
    .query(({ input }) =>
      guard(async () => {
        const { counts, stops, freeze } = deps();
        const reading = await readFreeze(freeze);
        const [stopped, recent] = await Promise.all([stops.list(), counts.recent(input.days)]);
        return {
          freeze: { postingEnabled: reading.postingEnabled, cause: reading.cause as FreezeCause | null, owner: 'svc-ledger' as const },
          stops: stopped.map((s) => ({ partnerId: s.partnerId, stoppedKinds: s.stoppedKinds, revision: s.revision })),
          firstDay: recent.firstDay,
          counts: recent.counts,
        };
      }),
    );
}
