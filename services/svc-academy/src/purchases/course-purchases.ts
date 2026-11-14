/**
 * J-academy-07 (AC-commerce-01, AC-access-grants-01) — buying the certificate track of a paid course staff made, from
 * the buyer's own wallet, and a staff refund.
 *
 * INTAFACED holds none of the buyer's money (the launch money model). The buyer's wallet signs one token transfer of the
 * price to INTAFACED's own receiving address. Academy reads the chain; once the payment has the confirmations the owner
 * set, it records it once on the ledger (`academyPurchase`, keyed `academy:purchase:<course>:<learner>:<n>`) and only then
 * writes the access grant.
 *
 * Order, every time:
 *   1. The intent and its terms (price, token, receiver, wallet, the block it starts at) are stored first. A second Buy, a
 *      lost reply or a press from another tab finds the same row: the wallet is asked to sign only on the one answer that
 *      opened the intent, never again for it.
 *   2. The payment is found on the chain by its hash, or, when the hash was lost, by the wallet's transfer of exactly
 *      the price to the receiver since the intent's block. An unknown outcome is settled against the chain only.
 *   3. A confirmed payment is claimed for posting by one conditional UPDATE, posted with no transaction open, and the
 *      answer written. A retry is the same key, so the ledger answers with the original transaction. The grant is
 *      written in the same database transaction that marks the purchase posted.
 *   4. A refund is stored first (its key, reason and who), then sent by the owner's refund signer under its key (the
 *      same key answers the same transaction), confirmed on the chain, posted once as the exact reverse
 *      (`academyPurchaseRefund`), and the grant revoked with the reason, in one database transaction.
 *
 * Nothing here signs, holds a key, or posts a customer balance.
 */
import type { Sql, TransactionSql } from 'postgres';
import type { AcademyCoursePurchase, AcademyCoursePurchaseView, AcademyStaffPurchase } from '@intafaced/contracts';
import { AcademyError } from '../errors.js';
import { canonicalPrice } from '../curriculum/courses.js';
import { ChainUnreadError, isAddress, isTxHash, toBaseUnits, transferCalldata, type PaymentChain, type TransferFact } from './chain.js';
import { POST_DEADLINE_SECONDS, type PostAnswer, type PurchaseLedger, type PurchasePost } from './purchase-ledger.js';
import type { RefundSender } from './refund-signer.js';
import type { LinkedWalletsPort } from './linked-wallets.js';

/** The owner's payment settings: all of them, or course payments are off. */
export interface PaymentSettings {
  readonly chainId: number;
  readonly token: string;
  readonly decimals: number;
  readonly asset: string;
  readonly receiver: string;
  readonly confirmations: number;
}

export interface CoursePurchaseDeps {
  readonly settings: PaymentSettings | null;
  readonly chain: PaymentChain | null;
  readonly ledger: PurchaseLedger | null;
  readonly refunds: RefundSender | null;
  /** Identity's linked wallets: a payer must be one of the buyer's own. Without it nothing is sold. */
  readonly wallets: LinkedWalletsPort | null;
}

type Db = Sql | TransactionSql;

type CourseRow = { id: string; slug: string; state: string; pricing: 'free' | 'paid'; price: string | null; price_asset: string | null };

type PurchaseRow = {
  id: string;
  course_id: string;
  course_slug: string;
  user_id: string;
  n: number;
  purchase_key: string;
  price: string;
  asset: string;
  chain_id: number;
  token: string;
  token_decimals: number;
  receiver: string;
  payer: string;
  from_block: string;
  state: 'awaiting_signature' | 'abandoned' | 'submitted' | 'confirmed' | 'posted' | 'failed' | 'refunding' | 'refunded';
  tx_hash: string | null;
  failure: string | null;
  post_state: 'posting' | 'unknown' | 'refused' | null;
  post_reason: string | null;
  ledger_tx_id: string | null;
  refund_key: string | null;
  refund_reason: string | null;
  refund_actor: string | null;
  refund_tx_hash: string | null;
  refund_send_at: Date | null;
  refund_ledger_tx_id: string | null;
  created_at: Date;
  updated_at: Date;
  posted_at: Date | null;
  refunded_at: Date | null;
};

const notFound = (slug: string) => new AcademyError(`no published course has the address "${slug}"`, 'academy.course_not_found');
const purchaseNotFound = () => new AcademyError('no purchase with that key', 'academy.purchase_not_found');

export const purchaseKeyOf = (course: string, userId: string, n: number) => `academy:purchase:${course}:${userId}:${n}`;
export const refundKeyOf = (course: string, userId: string, n: number) => `academy:refund:${course}:${userId}:${n}`;

/** States that are still moving: the reconciler reads them against the chain and the ledger. */
const OPEN_STATES = ['awaiting_signature', 'submitted', 'confirmed', 'refunding'] as const;
/**
 * How long the reconciler keeps searching a set-aside intent for a payment that was sent but not yet mined when it was set
 * aside. After that, the learner's next view or Buy still searches it, from the intent's first block.
 */
const ABANDONED_SEARCH_DAYS = 7;

export class CoursePurchases {
  constructor(
    private readonly sql: Sql,
    private readonly deps: CoursePurchaseDeps,
  ) {}

  /** Whether course payments are set up: every owner value, the chain node and the ledger. */
  get paymentsOn(): boolean {
    return this.deps.settings !== null && this.deps.chain !== null && this.deps.ledger !== null && this.deps.wallets !== null;
  }

  /** Whether a priced course can be sold with these settings (its price is in the payment token's asset). */
  sells(course: Pick<CourseRow, 'pricing' | 'price' | 'price_asset'>): boolean {
    return (
      this.paymentsOn &&
      course.pricing === 'paid' &&
      course.price !== null &&
      course.price_asset !== null &&
      course.price_asset === this.deps.settings!.asset
    );
  }

  /** True when the learner holds a recorded, unrefunded purchase of the course: what the certificate track needs. */
  async holdsPurchase(db: Db, courseId: string, userId: string): Promise<boolean> {
    const [row] = await db<Array<{ n: number }>>`
      SELECT 1 AS n FROM academy.course_purchases
       WHERE course_id = ${courseId} AND user_id = ${userId} AND state = 'posted'
       LIMIT 1
    `;
    return Boolean(row);
  }

  /** The course's price, how it can be paid, and the caller's latest purchase, read against the chain first. */
  async view(input: { userId: string; slug: string }): Promise<AcademyCoursePurchaseView> {
    const course = await this.publishedCourse(this.sql, input.slug);
    const latest = await this.latest(this.sql, course.id, input.userId);
    const settled = latest ? await this.reconcileRow(latest) : null;
    return this.viewOf(course, settled, null);
  }

  /**
   * Buy: store the intent (or find the one already stored) and answer with the one transaction the wallet is asked to
   * sign, only when this call opened the intent. Any other answer carries no request, so the wallet is never asked twice.
   */
  async buy(input: { userId: string; slug: string; wallet: string; now?: Date }): Promise<AcademyCoursePurchaseView> {
    const now = input.now ?? new Date();
    const wallet = input.wallet.toLowerCase();
    if (!isAddress(wallet))
      throw new AcademyError('academy.wallet_invalid the wallet address is not a 0x address', 'academy.wallet_invalid');
    const course = await this.publishedCourse(this.sql, input.slug);
    if (course.pricing !== 'paid') throw new AcademyError(`academy.payments_off "${course.slug}" is free`, 'academy.payments_off');
    if (course.price === null) throw new AcademyError(`academy.price_unset "${course.slug}" has no price`, 'academy.price_unset');
    if (!this.sells(course))
      throw new AcademyError('academy.payments_off course payments are not set up, so nothing is sold', 'academy.payments_off');
    const settings = this.deps.settings!;
    const chain = this.deps.chain!;
    await this.assertOwnWallet(input.userId, wallet);

    let latest = await this.latest(this.sql, course.id, input.userId);
    if (latest) latest = await this.reconcileRow(latest);
    // A purchase that is open or recorded is the answer: no second intent, no second signature request.
    if (latest && latest.state !== 'abandoned' && latest.state !== 'failed' && latest.state !== 'refunded')
      return this.viewOf(course, latest, null);

    let fromBlock: bigint;
    try {
      fromBlock = await chain.blockNumber();
    } catch (err) {
      if (err instanceof ChainUnreadError)
        throw new AcademyError(`academy.payments_off the payment network cannot be read: ${err.message}`, 'academy.payments_off');
      throw err;
    }
    const amount = toBaseUnits(canonicalPrice(course.price)!, settings.decimals);

    let opened: PurchaseRow | undefined;
    if (latest && (latest.state === 'abandoned' || latest.state === 'failed')) {
      // The same intent, reopened: same key, its wallet and terms set again. Of two presses at once, one reopens it. Its
      // first block is kept, so a payment sent before it was set aside, and mined since, is still found for it.
      [opened] = await this.sql<PurchaseRow[]>`
        UPDATE academy.course_purchases
           SET state = 'awaiting_signature', payer = ${wallet}, tx_hash = NULL,
               price = ${course.price}, asset = ${course.price_asset!}, chain_id = ${settings.chainId}, token = ${settings.token},
               token_decimals = ${settings.decimals}, receiver = ${settings.receiver}, updated_at = ${now}
         WHERE id = ${latest.id} AND state = ${latest.state}
        RETURNING *
      `;
    } else {
      const n = latest ? latest.n + 1 : 1;
      [opened] = await this.sql<PurchaseRow[]>`
        INSERT INTO academy.course_purchases
          (course_id, course_slug, user_id, n, purchase_key, price, asset, chain_id, token, token_decimals, receiver, payer,
           from_block, state, created_at, updated_at)
        VALUES (${course.id}, ${course.slug}, ${input.userId}, ${n}, ${purchaseKeyOf(course.slug, input.userId, n)}, ${course.price},
                ${course.price_asset!}, ${settings.chainId}, ${settings.token}, ${settings.decimals}, ${settings.receiver}, ${wallet},
                ${fromBlock.toString()}, 'awaiting_signature', ${now}, ${now})
        ON CONFLICT (course_id, user_id, n) DO NOTHING
        RETURNING *
      `;
    }
    if (!opened) return this.viewOf(course, await this.latest(this.sql, course.id, input.userId), null);
    return this.viewOf(course, opened, {
      chainId: settings.chainId,
      to: settings.token,
      data: transferCalldata(settings.receiver, amount),
    });
  }

  /**
   * The payer is the buyer's own wallet: one their account linked by its own signature in identity, and an address links
   * to one account only. Without this, anyone could name another person's wallet and have that person's payment counted
   * for their own purchase. Unread, nothing is opened.
   */
  private async assertOwnWallet(userId: string, wallet: string): Promise<void> {
    const linked = await this.deps.wallets!.read(userId);
    if (linked === null)
      throw new AcademyError('academy.wallet_unread the wallets linked to this account cannot be read now', 'academy.wallet_unread');
    if (linked.state !== 'usable' || !linked.wallets.some((w) => w.address === wallet))
      throw new AcademyError('academy.wallet_not_linked pay from a wallet linked to your own account', 'academy.wallet_not_linked');
  }

  /** The wallet sent the payment: its hash is stored on the intent, then read against the chain. */
  async submitPayment(input: { userId: string; key: string; txHash: string; now?: Date }): Promise<AcademyCoursePurchaseView> {
    const hash = input.txHash.toLowerCase();
    if (!isTxHash(hash)) throw new AcademyError('academy.wallet_invalid not a transaction hash', 'academy.wallet_invalid');
    const row = await this.own(input.userId, input.key);
    if (row.state === 'awaiting_signature' || row.state === 'abandoned') {
      await this.sql`
        UPDATE academy.course_purchases SET state = 'submitted', tx_hash = ${hash}, updated_at = ${input.now ?? new Date()}
         WHERE id = ${row.id} AND state IN ('awaiting_signature', 'abandoned')
      `.catch((err: unknown) => {
        // The same hash already counts for another purchase: it cannot pay for this one too.
        if ((err as { code?: string }).code === '23505')
          throw new AcademyError('academy.wallet_invalid that transaction already paid for a purchase', 'academy.wallet_invalid');
        throw err;
      });
    }
    return this.view({ userId: input.userId, slug: row.course_slug });
  }

  /**
   * The wallet refused to sign: the intent is set aside and no purchase is shown. Read against the chain first, so a
   * payment that did go out is never set aside.
   */
  async abandon(input: { userId: string; key: string; now?: Date }): Promise<AcademyCoursePurchaseView> {
    const row = await this.reconcileRow(await this.own(input.userId, input.key));
    if (row.state === 'awaiting_signature') {
      await this.sql`
        UPDATE academy.course_purchases SET state = 'abandoned', updated_at = ${input.now ?? new Date()}
         WHERE id = ${row.id} AND state = 'awaiting_signature'
      `;
    }
    return this.view({ userId: input.userId, slug: row.course_slug });
  }

  /** Staff: one purchase by its key, read against the chain and the ledger first. */
  async staffRead(key: string): Promise<AcademyStaffPurchase> {
    const row = await this.byKey(this.sql, key);
    if (!row) throw purchaseNotFound();
    return this.staffOf(await this.reconcileRow(row));
  }

  /**
   * Staff refund (AC-commerce-01, AC-roles-01): stored first with its key, reason and who; then sent, confirmed, posted
   * and the grant revoked by the reconciler, which this call runs once. A repeat answers with the same refund.
   */
  async refund(input: { key: string; reason: string; actorId: string; now?: Date }): Promise<AcademyStaffPurchase> {
    const reason = input.reason.trim();
    if (!reason) throw new AcademyError('academy.reason_required a refund needs a reason', 'academy.reason_required');
    if (!this.deps.refunds)
      throw new AcademyError('academy.refund_sender_unset no refund signer is set, so nothing is sent', 'academy.refund_sender_unset');
    if (!this.paymentsOn) throw new AcademyError('academy.payments_off course payments are not set up', 'academy.payments_off');
    const row = await this.byKey(this.sql, input.key);
    if (!row) throw purchaseNotFound();
    const current = await this.reconcileRow(row);
    if (current.state === 'posted') {
      await this.sql`
        UPDATE academy.course_purchases
           SET state = 'refunding', refund_key = ${refundKeyOf(current.course_slug, current.user_id, current.n)},
               refund_reason = ${reason}, refund_actor = ${input.actorId}, updated_at = ${input.now ?? new Date()}
         WHERE id = ${current.id} AND state = 'posted'
      `;
    } else if (current.state !== 'refunding' && current.state !== 'refunded') {
      throw new AcademyError(
        `academy.purchase_state a ${current.state} purchase is not recorded, so there is nothing to refund`,
        'academy.purchase_state',
      );
    }
    return this.staffRead(input.key);
  }

  /**
   * Every open purchase, read against the chain and the ledger once. One row's error does not stop the others: it is
   * reported to `onError` with the purchase key, the row stays where it is, and the next pass retries it.
   */
  async reconcile(limit = 100, onError: (key: string, err: unknown) => void = () => undefined): Promise<number> {
    const rows = await this.sql<PurchaseRow[]>`
      SELECT * FROM academy.course_purchases WHERE state IN ${this.sql(OPEN_STATES)} ORDER BY updated_at LIMIT ${limit}
    `;
    // A set-aside intent is searched too: the wallet may have sent its payment before it was set aside, unmined then.
    const setAside = await this.sql<PurchaseRow[]>`
      SELECT * FROM academy.course_purchases
       WHERE state = 'abandoned' AND updated_at > now() - make_interval(days => ${ABANDONED_SEARCH_DAYS})
       ORDER BY updated_at LIMIT ${limit}
    `;
    for (const row of [...rows, ...setAside]) await this.reconcileRow(row).catch((err: unknown) => onError(row.purchase_key, err));
    return rows.length + setAside.length;
  }

  // ── The state machine ───────────────────────────────────────────────────────────────────────────────────────────

  /** Moves one purchase as far as the chain and the ledger allow now, and answers with it as stored. */
  private async reconcileRow(start: PurchaseRow): Promise<PurchaseRow> {
    let row = start;
    if (!this.deps.chain || !this.deps.ledger) return row;
    for (let step = 0; step < 6; step++) {
      const next = await this.step(row).catch((err: unknown) => {
        // An unreadable node leaves the row where it is: unknown is not "no payment".
        if (err instanceof ChainUnreadError) return null;
        throw err;
      });
      if (!next || next.state === row.state) return next ?? row;
      row = next;
    }
    return row;
  }

  private async step(row: PurchaseRow): Promise<PurchaseRow | null> {
    switch (row.state) {
      case 'awaiting_signature':
      case 'abandoned':
        return this.findLostPayment(row);
      case 'submitted':
        return this.confirmPayment(row);
      case 'confirmed':
        return this.postPurchase(row);
      case 'refunding':
        return this.advanceRefund(row);
      default:
        return row;
    }
  }

  private amountOf(row: PurchaseRow): bigint {
    return toBaseUnits(canonicalPrice(row.price)!, row.token_decimals);
  }

  /** The hash was lost: the wallet's own transfer of exactly the price to the receiver since the intent, not yet counted. */
  private async findLostPayment(row: PurchaseRow): Promise<PurchaseRow> {
    const transfers = await this.deps.chain!.transfers({
      token: row.token,
      from: row.payer,
      to: row.receiver,
      fromBlock: BigInt(row.from_block),
    });
    const amount = this.amountOf(row);
    for (const transfer of transfers.filter((t) => t.amount === amount)) {
      const [used] = await this.sql<Array<{ id: string }>>`
        SELECT id FROM academy.course_purchases WHERE chain_id = ${row.chain_id} AND tx_hash = ${transfer.txHash}
      `;
      if (used) continue;
      // A plain transfer names no course. If another open intent of this wallet could have paid this same transfer (same
      // receiver, token and price, opened at or before its block), it is not taken for either: the wallet's own reported
      // hash settles which purchase it paid, so a payment is never recorded against the wrong course.
      const [rival] = await this.sql<Array<{ id: string }>>`
        SELECT id FROM academy.course_purchases
         WHERE id <> ${row.id} AND state IN ('awaiting_signature', 'abandoned') AND chain_id = ${row.chain_id}
           AND payer = ${row.payer} AND receiver = ${row.receiver} AND token = ${row.token} AND price = ${row.price}
           AND token_decimals = ${row.token_decimals} AND from_block::numeric <= ${transfer.blockNumber.toString()}::numeric
         LIMIT 1
      `;
      if (rival) continue;
      const [moved] = await this.sql<PurchaseRow[]>`
        UPDATE academy.course_purchases SET state = 'submitted', tx_hash = ${transfer.txHash}, updated_at = now()
         WHERE id = ${row.id} AND state IN ('awaiting_signature', 'abandoned')
        RETURNING *
      `.catch((err: unknown) => {
        // Another purchase took this hash between the read and the write: it is not this payment. Anything else stops.
        if ((err as { code?: string }).code === '23505') return [] as PurchaseRow[];
        throw err;
      });
      return moved ?? (await this.reread(row));
    }
    return row;
  }

  private matches(transfer: TransferFact, from: string, to: string, amount: bigint): boolean {
    return transfer.from === from.toLowerCase() && transfer.to === to.toLowerCase() && transfer.amount === amount;
  }

  /** The payment as the chain shows it: reverted or paying something else fails; enough confirmations confirm. */
  private async confirmPayment(row: PurchaseRow): Promise<PurchaseRow> {
    const fact = await this.deps.chain!.transaction(row.tx_hash!, row.token);
    if (fact.state === 'unseen') return row;
    const failure =
      fact.state === 'reverted'
        ? 'payment_reverted'
        : fact.transfers.some((t) => this.matches(t, row.payer, row.receiver, this.amountOf(row)))
          ? null
          : 'payment_mismatch';
    if (failure) {
      const [failed] = await this.sql<PurchaseRow[]>`
        UPDATE academy.course_purchases SET state = 'failed', failure = ${failure}, updated_at = now()
         WHERE id = ${row.id} AND state = 'submitted' RETURNING *
      `;
      return failed ?? (await this.reread(row));
    }
    if (fact.state !== 'mined' || fact.confirmations < BigInt(this.deps.settings!.confirmations)) return row;
    const [confirmed] = await this.sql<PurchaseRow[]>`
      UPDATE academy.course_purchases SET state = 'confirmed', updated_at = now()
       WHERE id = ${row.id} AND state = 'submitted' RETURNING *
    `;
    return confirmed ?? (await this.reread(row));
  }

  private postOf(row: PurchaseRow, txHash: string): PurchasePost {
    return {
      course: row.course_slug,
      userId: row.user_id,
      n: row.n,
      asset: row.asset,
      amount: canonicalPrice(row.price)!,
      receiver: row.receiver,
      txHash,
    };
  }

  /**
   * Claims the post (one conditional UPDATE: of two at once only one posts; a `posting` claim older than the ledger
   * client's whole deadline is a crash and is taken again), posts with no transaction open, writes the answer. A definite
   * refusal booked nothing (the platform-wide posting freeze, say), so it is posted again on the same key once that
   * deadline has passed: a payment the chain confirmed is never left unrecorded.
   */
  private async claimPost(row: PurchaseRow, state: 'confirmed' | 'refunding'): Promise<boolean> {
    const [claimed] = await this.sql<Array<{ id: string }>>`
      UPDATE academy.course_purchases SET post_state = 'posting', updated_at = now()
       WHERE id = ${row.id} AND state = ${state}
         AND (post_state IS NULL OR post_state = 'unknown'
              OR (post_state IN ('posting', 'refused') AND updated_at < now() - make_interval(secs => ${POST_DEADLINE_SECONDS})))
      RETURNING id
    `;
    return Boolean(claimed);
  }

  private async recordFailedPost(row: PurchaseRow, answer: Exclude<PostAnswer, { state: 'posted' }>): Promise<PurchaseRow> {
    const [after] = await this.sql<PurchaseRow[]>`
      UPDATE academy.course_purchases SET post_state = ${answer.state}, post_reason = ${answer.reason}, updated_at = now()
       WHERE id = ${row.id} RETURNING *
    `;
    return after ?? row;
  }

  private async postPurchase(row: PurchaseRow): Promise<PurchaseRow> {
    if (!(await this.claimPost(row, 'confirmed'))) return this.reread(row);
    const answer = await this.deps.ledger!.postPurchase(this.postOf(row, row.tx_hash!));
    if (answer.state !== 'posted') return this.recordFailedPost(row, answer);
    return this.sql.begin(async (tx) => {
      const [posted] = await tx<PurchaseRow[]>`
        UPDATE academy.course_purchases
           SET state = 'posted', post_state = NULL, post_reason = NULL, ledger_tx_id = ${answer.txId}, posted_at = now(), updated_at = now()
         WHERE id = ${row.id} AND state = 'confirmed' RETURNING *
      `;
      if (!posted) return (await this.byKey(tx, row.purchase_key))!;
      await this.grant(tx, posted);
      return posted;
    });
  }

  /** The access grant, written with the post: one record per course and learner, its event keyed by the purchase. */
  private async grant(tx: TransactionSql, row: PurchaseRow): Promise<void> {
    const [grant] = await tx<Array<{ id: string }>>`
      INSERT INTO academy.access_grants (user_id, path_slug, source, reason, starts_at, expires_at, state, created_at, updated_at)
      VALUES (${row.user_id}, ${row.course_slug}, 'purchase', null, now(), null, 'granted', now(), now())
      ON CONFLICT (path_slug, user_id) DO UPDATE SET source = 'purchase', state = 'granted', expires_at = null, updated_at = now()
      RETURNING id
    `;
    const [next] = await tx<Array<{ n: number }>>`
      SELECT COALESCE(MAX(n), 0)::int + 1 AS n FROM academy.access_grant_events WHERE grant_id = ${grant!.id}
    `;
    await tx`
      INSERT INTO academy.access_grant_events (grant_id, n, kind, key, reason, actor_id, expires_at, at)
      VALUES (${grant!.id}, ${next!.n}, 'granted', ${`purchase:${row.purchase_key}`}, null, ${row.user_id}, null, now())
      ON CONFLICT (key) DO NOTHING
    `;
  }

  /** A refund: sent once under its key, confirmed on the chain, posted once, and the grant revoked with its reason. */
  private async advanceRefund(row: PurchaseRow): Promise<PurchaseRow> {
    if (!row.refund_tx_hash) {
      if (!this.deps.refunds) return row;
      // One caller sends at a time: the reconciler, a staff read, a learner's view and a refund call can all reach here at
      // once. A claim a crash left behind is taken again after the deadline; the signer answers a key it already sent
      // with that same transaction, so a retry never sends twice.
      const [claimed] = await this.sql<Array<{ id: string }>>`
        UPDATE academy.course_purchases SET refund_send_at = now()
         WHERE id = ${row.id} AND state = 'refunding' AND refund_tx_hash IS NULL
           AND (refund_send_at IS NULL OR refund_send_at < now() - make_interval(secs => ${POST_DEADLINE_SECONDS}))
        RETURNING id
      `;
      if (!claimed) return this.reread(row);
      const release = () => this.sql`
        UPDATE academy.course_purchases SET refund_send_at = NULL
         WHERE id = ${row.id} AND state = 'refunding' AND refund_tx_hash IS NULL
      `;
      let hash: string | null;
      try {
        hash = await this.deps.refunds.send({
          key: row.refund_key!,
          chainId: row.chain_id,
          token: row.token,
          to: row.payer,
          amount: this.amountOf(row),
        });
      } catch (err) {
        await release();
        throw err;
      }
      // A lost answer frees the claim: the next try asks the signer again under the same key.
      if (!hash) {
        await release();
        return row;
      }
      const [sent] = await this.sql<PurchaseRow[]>`
        UPDATE academy.course_purchases SET refund_tx_hash = ${hash}, updated_at = now()
         WHERE id = ${row.id} AND state = 'refunding' AND refund_tx_hash IS NULL RETURNING *
      `;
      return sent ?? (await this.reread(row));
    }
    const fact = await this.deps.chain!.transaction(row.refund_tx_hash, row.token);
    if (fact.state !== 'mined' || fact.confirmations < BigInt(this.deps.settings!.confirmations)) return row;
    // The signer answered a transaction that does not send this refund: stop and show it, never send again.
    if (!fact.transfers.some((t) => this.matches(t, row.receiver, row.payer, this.amountOf(row)))) {
      if (row.post_state === 'refused' && row.post_reason === 'refund_mismatch') return row;
      return this.recordFailedPost(row, { state: 'refused', reason: 'refund_mismatch' });
    }
    if (!(await this.claimPost(row, 'refunding'))) return this.reread(row);
    const answer = await this.deps.ledger!.postRefund(this.postOf(row, row.refund_tx_hash));
    if (answer.state !== 'posted') return this.recordFailedPost(row, answer);
    return this.sql.begin(async (tx) => {
      const [refunded] = await tx<PurchaseRow[]>`
        UPDATE academy.course_purchases
           SET state = 'refunded', post_state = NULL, post_reason = NULL, refund_ledger_tx_id = ${answer.txId}, refunded_at = now(),
               updated_at = now()
         WHERE id = ${row.id} AND state = 'refunding' RETURNING *
      `;
      if (!refunded) return (await this.byKey(tx, row.purchase_key))!;
      await this.revoke(tx, refunded);
      return refunded;
    });
  }

  /** The grant ends with the refund's reason and who refunded, and a certificate-track enrolment it opened closes. */
  private async revoke(tx: TransactionSql, row: PurchaseRow): Promise<void> {
    const [grant] = await tx<Array<{ id: string }>>`
      UPDATE academy.access_grants SET state = 'revoked', updated_at = now()
       WHERE path_slug = ${row.course_slug} AND user_id = ${row.user_id} AND source = 'purchase'
      RETURNING id
    `;
    if (grant) {
      const [next] = await tx<Array<{ n: number }>>`
        SELECT COALESCE(MAX(n), 0)::int + 1 AS n FROM academy.access_grant_events WHERE grant_id = ${grant.id}
      `;
      await tx`
        INSERT INTO academy.access_grant_events (grant_id, n, kind, key, reason, actor_id, expires_at, at)
        VALUES (${grant.id}, ${next!.n}, 'revoked', ${`refund:${row.refund_key}`}, ${row.refund_reason}, ${row.refund_actor}, null, now())
        ON CONFLICT (key) DO NOTHING
      `;
    }
    await tx`
      UPDATE academy.course_enrolments SET left_at = now()
       WHERE course_id = ${row.course_id} AND user_id = ${row.user_id} AND track = 'certificate' AND left_at IS NULL
    `;
  }

  // ── Reads ────────────────────────────────────────────────────────────────────────────────────────────────────────

  private async publishedCourse(db: Db, slug: string): Promise<CourseRow> {
    const [course] = await db<CourseRow[]>`
      SELECT id, slug, state, pricing, price::text AS price, price_asset FROM academy.courses WHERE slug = ${slug}
    `;
    if (!course || course.state !== 'published') throw notFound(slug);
    return course;
  }

  private async latest(db: Db, courseId: string, userId: string): Promise<PurchaseRow | null> {
    const [row] = await db<PurchaseRow[]>`
      SELECT * FROM academy.course_purchases
       WHERE course_id = ${courseId} AND user_id = ${userId} ORDER BY n DESC LIMIT 1
    `;
    return row ?? null;
  }

  private async byKey(db: Db, key: string): Promise<PurchaseRow | null> {
    const [row] = await db<PurchaseRow[]>`
      SELECT * FROM academy.course_purchases WHERE purchase_key = ${key}
    `;
    return row ?? null;
  }

  private async reread(row: PurchaseRow): Promise<PurchaseRow> {
    return (await this.byKey(this.sql, row.purchase_key)) ?? row;
  }

  /** The caller's own purchase; someone else's is the same not-found as a missing one. */
  private async own(userId: string, key: string): Promise<PurchaseRow> {
    const row = await this.byKey(this.sql, key);
    if (!row || row.user_id !== userId) throw purchaseNotFound();
    return row;
  }

  private async grantOf(row: PurchaseRow): Promise<'granted' | 'revoked' | null> {
    if (row.state !== 'posted' && row.state !== 'refunding' && row.state !== 'refunded') return null;
    const [grant] = await this.sql<Array<{ state: string }>>`
      SELECT state FROM academy.access_grants WHERE path_slug = ${row.course_slug} AND user_id = ${row.user_id}
    `;
    return grant?.state === 'granted' ? 'granted' : grant ? 'revoked' : null;
  }

  private async purchaseOf(row: PurchaseRow): Promise<AcademyCoursePurchase> {
    return {
      key: row.purchase_key,
      state: row.state === 'abandoned' ? 'awaiting_signature' : row.state,
      amount: canonicalPrice(row.price)!,
      asset: row.asset,
      chainId: row.chain_id,
      token: row.token.toLowerCase(),
      receiver: row.receiver.toLowerCase(),
      payer: row.payer.toLowerCase(),
      txHash: row.tx_hash,
      failure: row.failure ?? (row.post_state === 'refused' || row.post_state === 'unknown' ? row.post_reason : null),
      grant: await this.grantOf(row),
      refund: row.refund_key ? { txHash: row.refund_tx_hash, reason: row.refund_reason ?? '' } : null,
      createdAt: row.created_at.toISOString(),
      postedAt: row.posted_at?.toISOString() ?? null,
      refundedAt: row.refunded_at?.toISOString() ?? null,
    };
  }

  private async viewOf(
    course: CourseRow,
    row: PurchaseRow | null,
    request: AcademyCoursePurchaseView['request'],
  ): Promise<AcademyCoursePurchaseView> {
    const settings = this.deps.settings;
    const wallet: AcademyCoursePurchaseView['wallet'] =
      course.pricing === 'paid' && course.price === null
        ? { state: 'off', code: 'academy.price_unset' }
        : this.sells(course)
          ? { state: 'on', chainId: settings!.chainId, token: settings!.token.toLowerCase(), receiver: settings!.receiver.toLowerCase() }
          : { state: 'off', code: 'academy.payments_off' };
    return {
      slug: course.slug,
      pricing: course.pricing,
      price: canonicalPrice(course.price),
      asset: course.price === null ? null : course.price_asset,
      wallet,
      card: { state: 'off', code: 'rail.card' },
      // A refused signature leaves no purchase.
      purchase: row && row.state !== 'abandoned' ? await this.purchaseOf(row) : null,
      request,
    };
  }

  private async staffOf(row: PurchaseRow): Promise<AcademyStaffPurchase> {
    return {
      ...(await this.purchaseOf(row)),
      course: row.course_slug,
      userId: row.user_id,
      ledgerTxId: row.ledger_tx_id,
      refundLedgerTxId: row.refund_ledger_tx_id,
    };
  }
}
