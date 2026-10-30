import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { lockInstrumentOwners } from './instrument-lock.js';
import { P2pError } from './p2p-service.js';
import { withSpan } from './tracing.js';

/**
 * P2P EXPORT AND ERASURE — stage 1 (§0.9 · GDPR Art. 15 / Art. 17).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT WAS HERE BEFORE: NOTHING.
 *
 * `blueprint.export` / `blueprint.erase` are real, self-only and a genuine hard
 * delete — and every statement in them is prefixed `blueprint.`. No p2p table
 * is covered by anything. There is no platform-wide erasure orchestrator, no
 * per-service erase convention, and svc-p2p subscribes to no events at all, so
 * it could not hear an account-deletion signal if one existed.
 *
 * The de facto answers were `instruments.reveal` for export and
 * `instruments.remove` for erase — one instrument at a time, only while active,
 * and covering none of the offers, trades, disputes or reputation this service
 * holds about a person.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TWO RULES THIS FILE IS BUILT ON
 *
 * 1 · **Never erase something the platform still owes an answer about.** A
 *     trade holding escrow, an open dispute, a decision recorded but not yet
 *     settled — deleting our copy of the terms while svc-ledger still holds the
 *     value is how escrow becomes a pile of money with no owner and no
 *     instruction. That is the exact stranded-funds condition the whole service
 *     is built to prevent, and "the user asked" does not make it safe.
 *
 * 2 · **Say what was kept, and why, in the response.** An erase that silently
 *     retains half the record is worse than one that refuses: the person
 *     believes something that is not true, and only finds out in a dispute.
 *     Every call returns a `retained` manifest naming each category, the count,
 *     and the reason — and the reasons here are honest ones ("a settled trade
 *     is the audit trail for a movement of value") rather than "compliance".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT STAGE 1 DOES NOT DO, stated here rather than discovered later:
 *
 *   · **Settled trades are retained, not pseudonymised.** Replacing a user id
 *     with a surrogate everywhere it appears is a migration across every row
 *     that references it, and getting it half-right leaves a trade whose two
 *     sides disagree about who traded. Stage 3, and it needs the owner's answer
 *     on how long a settled P2P trade must remain attributable.
 *   · **There is no cross-service orchestration.** This is reachable only by
 *     the person themselves. When a platform-wide erasure signal exists, this
 *     is what it calls.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PAYMENT INSTRUMENTS — the thing this file was written before and now covers.
 *
 * The first version of this file said instruments were "not yet built". They
 * are: `payment_instruments` holds the account number a seller is paid at, and
 * it is the single most sensitive row in the service. An erase that leaves it
 * there and does not say so is exactly the "silently retains half the record"
 * failure this file is built to refuse.
 *
 * It is erased the way the instrument table already defines erasure — a state
 * change to `removed`, which the `payment_instruments_details_ck` CHECK turns
 * into "details IS NULL" at the database. Not a DELETE: the access log and the
 * frozen trade snapshots both carry foreign keys to the row, and deleting it
 * would take the record of who looked at the details away with the details.
 * The `fingerprint` deliberately survives — an appeal can still be told whether
 * the account a seller now names is the one the buyer was shown, without us
 * holding the account in order to answer.
 *
 * The frozen snapshots on the caller's OWN trades are purged on the same tick
 * rather than left to `purgeExpiredSnapshots` — the retention window is how
 * long we keep them when nobody asked; somebody asked. Snapshots owned by a
 * COUNTERPARTY are not touched: those are that person's account details, on a
 * trade they did not ask to be erased from.
 */

/** One category of data, and what happened to it. */
export interface ErasureLine {
  readonly category: string;
  readonly rows: number;
  /** Why it was kept. Absent on erased categories. */
  readonly reason?: string;
}

export interface ErasureReport {
  readonly userId: string;
  readonly at: Date;
  readonly erased: ErasureLine[];
  readonly retained: ErasureLine[];
}

export interface P2pExport {
  readonly userId: string;
  readonly at: Date;
  readonly offers: unknown[];
  readonly trades: unknown[];
  readonly disputes: unknown[];
  /**
   * Reviews this person wrote or was written about. Both sides are held: the
   * words belong to the other party as much as to the caller.
   */
  readonly orderReviews: unknown[];
  /** Sensitive payment-note remark cases this person reported or was reported in (P-ads-merchant-19), whole. */
  readonly remarkCases: unknown[];
  /** The person's ad edits counted against the daily cap (P-ads-merchant-06). */
  readonly offerEdits: unknown[];
  /** Links the person made to their ads: when made, when they end or were withdrawn. Tokens are not held (P-ads-merchant-07). */
  readonly shareLinks: unknown[];
  readonly reputation: unknown | null;
  /**
   * The caller's payment destinations — **headers only, never the values.**
   *
   * The values are readable, by the owner, through `instruments.reveal`, and
   * that path writes an access-log row in the same statement that reads them.
   * Serving them here as well would be a second, unlogged way to read an
   * account number, which is the one property the instrument design is built
   * on. `notCovered` names where to get them instead.
   */
  readonly instruments: unknown[];
  /**
   * The caller's past P2P risk notice acceptances (`p2p.risk_acceptances`). No take reads them any more (owner
   * decision 2026-10-27), but the rows are still held, so they are still the caller's to see.
   */
  readonly riskAcceptances: unknown[];
  /** Named so a reader knows the export is of THIS service, not the platform. */
  readonly notCovered: string[];
}

export class P2pErasure {
  constructor(private readonly sql: Sql) {}

  /**
   * EVERYTHING THIS SERVICE HOLDS ABOUT ONE PERSON. Self-only at the router.
   *
   * Deliberately raw rows rather than the API's output shapes: an export exists
   * so a person can see what is held, and a view that has already dropped the
   * fields the API does not serialise is not that. `evidence` in particular is
   * returned whole for disputes they were party to — it is a record made ABOUT
   * them, which is the clearest case in the file for Art. 15.
   */
  async exportFor(userId: string): Promise<P2pExport> {
    return withSpan('p2p.export', async () => {
      const [offers, trades, disputes, orderReviews, remarkCases, reputation, instruments, riskAcceptances, offerEdits, shareLinks] =
        await Promise.all([
          this.sql`SELECT * FROM p2p.offers WHERE maker_id = ${userId} ORDER BY created_at`,
          this.sql`SELECT * FROM p2p.p2p_trades WHERE seller_id = ${userId} OR buyer_id = ${userId} ORDER BY created_at`,
          this.sql`
          SELECT d.* FROM p2p.p2p_disputes d
            JOIN p2p.p2p_trades t ON t.id = d.trade_id
           WHERE t.seller_id = ${userId} OR t.buyer_id = ${userId}
           ORDER BY d.opened_at
        `,
          this.sql`
          SELECT * FROM p2p.order_reviews
           WHERE author_id = ${userId} OR subject_id = ${userId}
           ORDER BY created_at
        `,
          this.sql`
          SELECT * FROM p2p.remark_cases
           WHERE reporter_id = ${userId} OR reported_id = ${userId}
           ORDER BY opened_at
        `,
          this.sql`SELECT * FROM p2p.p2p_reputation WHERE user_id = ${userId}`,
          // HEADERS ONLY — the column list is explicit precisely so that `SELECT *`
          // cannot quietly start returning `details` the day someone adds a
          // column. `fingerprint` is out too: it is a hash of the account details,
          // and a hash handed to a caller is an oracle a guessed account number
          // can be checked against.
          this.sql`
          SELECT id, method_id, country, fiat_currency, label, status, created_at, updated_at, removed_at
            FROM p2p.payment_instruments
           WHERE owner_id = ${userId}
           ORDER BY created_at
        `,
          this.sql`SELECT user_id, version, accepted_at FROM p2p.risk_acceptances WHERE user_id = ${userId} ORDER BY accepted_at`,
          this.sql`SELECT * FROM p2p.offer_edits WHERE maker_id = ${userId} ORDER BY edited_at`,
          this.sql`
          SELECT id, offer_id, created_at, expires_at, revoked_at FROM p2p.offer_share_links
           WHERE maker_id = ${userId}
           ORDER BY created_at
        `,
        ]);

      // The column list above is the export reader. `details` is not selected, so a
      // sealed blob cannot leave as if it were account text. Reveal is the logged
      // open. If a row ever carries `details`, refuse rather than return it.
      for (const row of instruments) {
        if (row !== null && typeof row === 'object' && 'details' in row) {
          throw new P2pError('p2p.instrument_kms_required', 'p2p.instrument_kms_required');
        }
      }

      return {
        userId,
        at: new Date(),
        offers: [...offers],
        trades: [...trades],
        disputes: [...disputes],
        orderReviews: [...orderReviews],
        remarkCases: [...remarkCases],
        offerEdits: [...offerEdits],
        shareLinks: [...shareLinks],
        reputation: reputation[0] ?? null,
        instruments: [...instruments],
        riskAcceptances: [...riskAcceptances],
        // An export that implies it is the whole platform is a lie told by
        // omission. These are the parts a reader must go elsewhere for.
        notCovered: [
          'the values inside your payment instruments — `instruments.reveal`, which access-logs every read (this export deliberately is not a second, unlogged way to read them)',
          'who has looked at your payment instruments (`instruments.accessLog`)',
          'identity, KYC records and sessions (svc-identity)',
          'ledger entries for escrow movements (svc-ledger)',
          'blueprint (blueprint.export)',
          'block/RFQ quotes (rfq.quote / rfq.accept / rfq.expire — firm quotes, not book fills)',
        ],
      };
    });
  }

  /**
   * ERASE WHAT CAN HONESTLY BE ERASED. Self-only at the router.
   *
   * Refuses outright while anything is live. Not "erases what it can and warns
   * about the rest" — a person mid-trade who asks to be erased is asking a
   * question the platform cannot answer yet, and the useful reply names the
   * trades rather than half-deleting around them.
   */
  async eraseFor(userId: string): Promise<ErasureReport> {
    return withSpan('p2p.erase', async () =>
      transaction(
        this.sql,
        async (tx) => {
          // THE LOCK, BEFORE THE REFUSAL READ — and the order is the whole
          // point of it.
          //
          // This transaction is about to ask "is any trade of this person still
          // open?", act on the answer, and report the answer to them. At READ
          // COMMITTED that answer is true when it is read and says nothing
          // about the moment it is acted on: a take starting after the UPDATEs
          // below and before this COMMIT reads the pre-update instrument row
          // under MVCC and freezes the account number onto a brand new trade.
          // Erase then reports "instruments erased=1, frozen snapshots
          // erased=0" — both true of what it saw, and together a lie. The
          // snapshot survives `purgeExpiredSnapshots`, which only sweeps
          // TERMINATED trades, so a trade that never terminates keeps it.
          //
          // Held from here to commit, the lock makes the refusal read still
          // true when it is reported: `reserveTrade` takes the same key before
          // its first row lock, so no take for this person can begin inside the
          // window. Whichever arrives second sees the first. `instrument-lock.ts`
          // has the reproduction and the ordering rules.
          await lockInstrumentOwners(tx, userId);

          // THE REFUSAL, FIRST. Every state in which svc-ledger might still be
          // holding this person's value, or in which a decision is recorded and
          // the post has not happened.
          const live = await tx<Array<{ id: string; status: string }>>`
            SELECT id, status FROM p2p.p2p_trades
             WHERE (seller_id = ${userId} OR buyer_id = ${userId})
               AND (resolution IS NULL OR settled_at IS NULL)
             ORDER BY created_at
          `;

          if (live.length > 0) {
            throw new P2pError(
              `Erasure is refused while ${live.length} trade(s) are still open or unsettled — ` +
                `the escrow they describe is held in the ledger, and deleting the record of who it belongs to ` +
                `would strand it. Close or settle them first.`,
              'p2p.erase_blocked',
            );
          }

          const erased: ErasureLine[] = [];
          const retained: ErasureLine[] = [];

          // Reputation: counters keyed on the user id, deriving nothing anyone
          // else needs and referenced by no foreign key. A genuine delete.
          const reputation = await tx`DELETE FROM p2p.p2p_reputation WHERE user_id = ${userId} RETURNING user_id`;
          erased.push({ category: 'reputation', rows: reputation.length });

          // P-ads-merchant-06: the person's ad edits, counted against the daily cap. They name nobody else.
          const edits = await tx`DELETE FROM p2p.offer_edits WHERE maker_id = ${userId} RETURNING offer_id`;
          erased.push({ category: 'ad edits counted against the daily cap', rows: edits.length });

          // P-ads-merchant-07: links the person made to their ads, kept ones included. Only token hashes and times.
          const links = await tx`DELETE FROM p2p.offer_share_links WHERE maker_id = ${userId} RETURNING id`;
          erased.push({ category: 'share links to ads', rows: links.length });

          // Offers with no trades against them never became part of anyone
          // else's record. Ones that were traded are load-bearing: a trade row
          // references its offer, and `writeDecision` puts liquidity back on it.
          const offers = await tx`
            DELETE FROM p2p.offers o
             WHERE o.maker_id = ${userId}
               AND NOT EXISTS (SELECT 1 FROM p2p.p2p_trades t WHERE t.offer_id = o.id)
            RETURNING id
          `;
          erased.push({ category: 'offers (never traded)', rows: offers.length });

          // P-ads-merchant-18: the record of each payment-method removal that paused this person's ads, which is also
          // the outbox of its notice. It names nobody else, so it goes; a notice not yet handed over goes with it.
          const removals = await tx`DELETE FROM p2p.method_removal_pauses WHERE maker_id = ${userId} RETURNING instrument_id`;
          erased.push({ category: 'ads paused by a removed payment method', rows: removals.length });

          // THE ACCOUNT NUMBER. Removal is a state change and not a DELETE —
          // `payment_instruments_details_ck` makes `status = 'removed'` and
          // `details IS NULL` the same fact at the database, so this cannot
          // half-happen, and the access log and the frozen snapshots keep
          // pointing at a row that exists. Same statement `removeInstrument`
          // runs, written here rather than called because the whole erase is
          // one transaction and a collaborator with its own connection would
          // commit outside it.
          const instruments = await tx`
            UPDATE p2p.payment_instruments
               SET status = 'removed', details = NULL, removed_at = now(), updated_at = now()
             WHERE owner_id = ${userId} AND status = 'active'
            RETURNING id
          `;
          erased.push({ category: 'payment instrument details', rows: instruments.length });

          // The destinations frozen onto the caller's OWN trades. The retention
          // window is how long these are kept when nobody asked; somebody
          // asked. Only rows they own — a snapshot owned by a counterparty is
          // that person's account, on a trade they did not ask to be erased
          // from.
          const snapshots = await tx`
            UPDATE p2p.trade_payment_instruments
               SET details = NULL, purged_at = now()
             WHERE owner_id = ${userId} AND purged_at IS NULL
            RETURNING trade_id
          `;
          erased.push({ category: 'payment details frozen onto trades', rows: snapshots.length });

          // Past risk notice acceptances: one row per person and version, read by nothing since owner decision
          // 2026-10-27 and referenced by no foreign key. A genuine delete.
          const acceptances = await tx`DELETE FROM p2p.risk_acceptances WHERE user_id = ${userId} RETURNING version`;
          erased.push({ category: 'risk notice acceptances', rows: acceptances.length });

          const tradedOffers = await tx<Array<{ n: string }>>`
            SELECT count(*) AS n FROM p2p.offers o
             WHERE o.maker_id = ${userId} AND EXISTS (SELECT 1 FROM p2p.p2p_trades t WHERE t.offer_id = o.id)
          `;
          if (Number(tradedOffers[0]!.n) > 0) {
            retained.push({
              category: 'offers (traded against)',
              rows: Number(tradedOffers[0]!.n),
              reason:
                'A settled trade references the offer it was taken from, and the price and terms it was taken at. ' +
                'Deleting the offer would leave the counterparty holding half a contract.',
            });
          }

          const trades = await tx<Array<{ n: string }>>`
            SELECT count(*) AS n FROM p2p.p2p_trades WHERE seller_id = ${userId} OR buyer_id = ${userId}
          `;
          if (Number(trades[0]!.n) > 0) {
            retained.push({
              category: 'settled trades',
              rows: Number(trades[0]!.n),
              reason:
                'A settled trade is the audit trail for a movement of value that svc-ledger recorded — §5 requires ' +
                'every movement to be explainable, and it names a counterparty who did not ask to be erased. ' +
                'Pseudonymisation is the right answer here and is not built (stage 3).',
            });
          }

          const disputes = await tx<Array<{ n: string }>>`
            SELECT count(*) AS n FROM p2p.p2p_disputes d
              JOIN p2p.p2p_trades t ON t.id = d.trade_id
             WHERE t.seller_id = ${userId} OR t.buyer_id = ${userId}
          `;
          if (Number(disputes[0]!.n) > 0) {
            retained.push({
              category: 'disputes and their evidence',
              rows: Number(disputes[0]!.n),
              reason:
                'A dispute is a record of two people disagreeing, and the evidence in it was filed BY and ABOUT ' +
                'both of them. It is append-only by construction, and one party erasing it would remove the ' +
                "other party's account of what happened.",
            });
          }

          // Not deleted. A remark case is a report BY one party ABOUT the other, the record a penalty would rest on.
          const remarkCases = await tx<Array<{ n: string }>>`
            SELECT count(*) AS n FROM p2p.remark_cases WHERE reporter_id = ${userId} OR reported_id = ${userId}
          `;
          if (Number(remarkCases[0]!.n) > 0) {
            retained.push({
              category: 'reports of a sensitive payment-note remark',
              rows: Number(remarkCases[0]!.n),
              reason:
                'A remark case is one party reporting what the other wrote in a payment note, and staff decide it. ' +
                "Erasing it at either party's request would remove the record a decision rests on, or the account " +
                'of the person who reported it.',
            });
          }

          // Not deleted. The row is the other party's rating and words, and also
          // the caller's. One side asking to be erased does not get to remove it.
          const orderReviews = await tx<Array<{ n: string }>>`
            SELECT count(*) AS n FROM p2p.order_reviews
             WHERE author_id = ${userId} OR subject_id = ${userId}
          `;
          if (Number(orderReviews[0]!.n) > 0) {
            retained.push({
              category: 'order reviews',
              rows: Number(orderReviews[0]!.n),
              reason:
                "The other party's rating and words stay. A review names both sides of a settled trade, and deleting " +
                "it would remove the counterparty's account of how the trade went.",
            });
          }

          const instrumentShells = await tx<Array<{ n: string }>>`
            SELECT count(*) AS n FROM p2p.payment_instruments WHERE owner_id = ${userId}
          `;
          if (Number(instrumentShells[0]!.n) > 0) {
            retained.push({
              category: 'payment instrument records, without their details',
              rows: Number(instrumentShells[0]!.n),
              reason:
                'The account details are gone; what is left is the row, its label and a hash of what it used to be. ' +
                'The access log and the destinations frozen onto settled trades both point at it, so deleting it ' +
                'would take away the record of who looked at your details along with the details.',
            });
          }

          const accessLog = await tx<Array<{ n: string }>>`
            SELECT count(*) AS n FROM p2p.instrument_access_log
             WHERE owner_id = ${userId} OR viewer_id = ${userId}
          `;
          if (Number(accessLog[0]!.n) > 0) {
            retained.push({
              category: 'payment instrument access log',
              rows: Number(accessLog[0]!.n),
              reason:
                'This is the record of who looked at your account details and when, and it is append-only by a ' +
                'database trigger — it cannot be edited by this service or by anyone holding a session. ' +
                'Erasing it on request would delete the evidence of a leak at the request of whoever caused it.',
            });
          }

          // ── THE REPORT IS RE-ASSERTED BEFORE IT IS MADE ──────────────────
          //
          // Rule 2 at the top of this file says the response must say what was
          // kept and why. That is a claim about the state of the database at
          // COMMIT, and everything above is a claim about the state at the
          // moment each statement ran. The lock closes the gap for the one
          // writer that could open it today; this closes it for the writer
          // nobody has written yet.
          //
          // It re-reads the three facts the manifest asserts, at the end,
          // inside the transaction — so a run that cannot honestly make them
          // ROLLS BACK and says so, instead of committing a manifest that is
          // wrong. `transaction` retries, and on the retry the lock is taken
          // from the start, so a genuine race resolves rather than spinning.
          const [stillLive, stillHeld] = await Promise.all([
            tx<Array<{ n: string }>>`
              SELECT count(*) AS n FROM p2p.p2p_trades
               WHERE (seller_id = ${userId} OR buyer_id = ${userId})
                 AND (resolution IS NULL OR settled_at IS NULL)
            `,
            tx<Array<{ n: string }>>`
              SELECT
                (SELECT count(*) FROM p2p.payment_instruments
                  WHERE owner_id = ${userId} AND status = 'active')
                + (SELECT count(*) FROM p2p.trade_payment_instruments
                    WHERE owner_id = ${userId} AND (purged_at IS NULL OR details IS NOT NULL))
                AS n
            `,
          ]);

          if (Number(stillLive[0]!.n) > 0 || Number(stillHeld[0]!.n) > 0) {
            throw new P2pError(
              `Erasure was overtaken: ${stillLive[0]!.n} trade(s) became live and ${stillHeld[0]!.n} payment ` +
                `destination(s) are still readable at the end of the transaction that was about to report them erased. ` +
                `Nothing was written. Retry — the report this would have returned was not true.`,
              'p2p.erase_raced',
            );
          }

          return { userId, at: new Date(), erased, retained };
        },
        { isolation: 'read committed', maxAttempts: 3 },
      ),
    );
  }
}
