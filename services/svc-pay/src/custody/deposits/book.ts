import type { Sql } from 'postgres';
import { formatAmount, parseAmount, POST_IN_FLIGHT_BOUND_SECONDS, type Amount } from '@intafaced/ledger-client';
import {
  PAY_CUSTODY_DEPOSIT_PENDING_STATUSES,
  type PayCustodyDepositReason,
  type PayCustodyDepositRecord,
  type PayCustodyDepositRecordsInput,
  type PayCustodyDepositRecordsReply,
  type PayCustodyDepositStatus,
} from '@intafaced/contracts';
import { payDepositCreditPostedPayloadSchema, type PayDepositCreditPostedPayload } from '@intafaced/events';
import type { RegistryReader } from '../../registries/read-api.js';

/**
 * The record of customer crypto deposits (W-deposit-05). NO BALANCE LIVES HERE: a row is evidence of one transfer, and a
 * customer is credited only by the ledger `deposit` post, keyed `deposit:crypto-native:<network>:<tx_hash>:<output_index>`.
 *
 * - ONE ROW per (asset, network, tx hash, output index). A repeat of the same event finds it; it never makes a second row and
 *   never a second post.
 * - CREDIT happens only when confirmations are at or above the registry's published count AND the amount is at or above the
 *   owner's minimum. A blank count or a blank minimum credits nothing: the row stays `confirming` with the reason
 *   (`confirmations_unset`, `minimum_unset`) and is judged again on the next pass.
 * - CRASH SAFETY. The row is written before the ledger is asked and flipped to `credited` after, in one statement that also
 *   stores the ledger transaction id. A crash between the two leaves `confirming`; the next pass posts again under the same
 *   key, which the ledger answers with the first transaction. A ledger error leaves the row `confirming` and is rethrown.
 * - ONCE A CREDIT HAS STARTED it is finished, whatever the settings say later. `credit_started_at` is written, with the minimum
 *   and count the row was judged by, before the ledger is asked; a retry after a crash skips the judgment and posts under the
 *   same key, so the record and the ledger cannot disagree because an owner setting moved in between.
 * - A finalized amount that differs from the one first seen is `needs_review`, never credited; an asset the address was not
 *   issued for is `rejected` and logged as an alert. `held_for_screening` is W-deposit-06's hold, still to come.
 * - A TRANSFER THE CHAIN TAKES BACK (W-deposit-06, `reverse`): the block it was in was rewritten and it is not in the new one.
 *   A row that was never credited is closed `reversed` (reason `chain_reorg`) and posts nothing. A credited row posts one
 *   `depositReverse`, keyed `deposit.reverse:crypto-native:<network>:<tx_hash>:<output_index>`: `reversal_started_at` is
 *   written before the ledger is asked and the flip to `reversed` stores the reversal's transaction id, so a crash in
 *   between is retried under the same key and the ledger answers with the first reversal. A credit cut short by a crash is
 *   finished first, under its own key, so the reversal always has a credit to reverse. A balance that can no longer cover
 *   the amount (the funds were spent) posts nothing and is `needs_review` (reason `reversal_unfunded`) with an alert: never
 *   a negative balance and never a partial take-back; a later reorg delivery tries again. While a reversal runs the row is
 *   `needs_review` (reason `chain_reorg`), so no sweep or announcement treats it as credited, and `settleOpen` finishes one a
 *   crash or a ledger error cut short. Only a refusal that proves nothing committed (one attempt, the first post under the
 *   key) parks a reversal as unfunded. A retried post, a timeout or a crash leaves it started, and an earlier attempt may
 *   still land, so it is not posted again until `POST_IN_FLIGHT_BOUND_SECONDS` have passed since the last attempt
 *   (`reversal_attempted_at`). Then the key is read back first. A reversed transfer seen again is never credited on its own (a re-inclusion and a late
 *   delivery from before the reorg look the same): a never-credited one goes to review, a reversed credit stays reversed,
 *   each with an alert. Every reorg is kept by position (`custody_deposit_reorgs`), so a sighting that arrives after its
 *   reorg goes to review too. A rejected row (a token the address was not issued for) keeps its rejection.
 * - A DEPOSIT ADDRESS COMPLIANCE FROZE (W-compliance-notices-03, `custody_deposit_address_freezes`): a deposit to it that is not
 *   credited yet is `on_hold` (reason `address_frozen`) and is never credited while the freeze stands. It still follows its
 *   confirmations. The credit start refuses while a freeze is open; a credit that already started is finished, because it may
 *   already be in the ledger. `release` lifts the freeze (after a second founder's unfreeze) and puts its held rows back to be
 *   judged in one transaction, so each is credited once under its usual key; `settleOpen` releases any held row whose
 *   address has no open freeze.
 * - THE INBOUND TRAVEL RULE (W-deposit-07, `custody_deposit_travel_rule`): a deposit that is otherwise due (confirmed, at or
 *   above the minimum) is judged against the owner's latest inbound rule for its asset. With no rule it is not credited: it
 *   stays `confirming` with reason `travel_rule_unset` and is judged again on the next pass. At or above a rule's threshold it
 *   is `held_travel_rule` (reason `travel_rule_declaration`) and a record is opened in the same transaction; it is never
 *   credited while held. `releaseTravelRule` (a founder's release of a declared deposit) puts it back to be judged in one
 *   transaction with the release event, and the record's `released` state lets it through, so it is credited once under its
 *   usual key. A counterparty wait past its limit is recorded `blocking_time_expired` on a pass and stays held.
 * - A transfer first seen at an extra address after its expiry (W-deposit-02) is `held_for_release` with reason
 *   `address_expired`: recorded, never credited on its own and never dropped, left for a support or compliance release. One
 *   first seen before the expiry is judged and credited as any other, however long it takes to confirm.
 * - ANNOUNCED ONCE CREDITED (W-deposit-09). A credited row is published for the customer's inbox (`announceCredit`), then
 *   `credit_notified_at` is written. Crediting never waits for it: the flip only starts an announcing pass in the background,
 *   and the service runs one on a timer too. One pass runs at a time and stops at the first bus failure; a crash or a bus
 *   error leaves the row unrecorded, and a later pass announces it again under the same business key (consumers key on the
 *   deposit id). An announcement that fails never undoes or holds the credit.
 */

/** One transfer to a watched address, as the chain saw it. */
export interface ChainDeposit {
  readonly address: string;
  readonly txHash: string;
  readonly outputIndex: number;
  readonly assetId: string;
  readonly amount: Amount;
  readonly confirmations: number;
}

/** A transfer the chain took back, named by where it was. */
export interface ChainReorg {
  readonly address: string;
  readonly txHash: string;
  readonly outputIndex: number;
}

/** `unknown`: a customer address with no record of that transfer, so there is nothing to take back. */
export type ChainReorgOutcome =
  | { readonly state: 'unmatched' }
  | { readonly state: 'unknown' }
  | { readonly state: 'recorded'; readonly status: PayCustodyDepositStatus; readonly reason: PayCustodyDepositReason | null };

export type ChainDepositOutcome =
  | { readonly state: 'unmatched' }
  | { readonly state: 'recorded'; readonly status: PayCustodyDepositStatus; readonly reason: PayCustodyDepositReason | null };

export interface CustodyDepositBookDeps {
  readonly sql: Sql;
  /** The one deposit engine (`UserMoneyService.postCustodyDeposit`): posts the ledger `deposit` under the business key. */
  readonly postDeposit: (input: {
    userId: string;
    assetId: string;
    amount: Amount;
    networkId: string;
    txHash: string;
    outputIndex: number;
  }) => Promise<{ id: string }>;
  /**
   * The reversal engine (`UserMoneyService.reverseCustodyDeposit`): posts the ledger `depositReverse` under the business key,
   * or answers `unfunded` when the refusal proves nothing committed, or `unsure` when it does not (a retried post). `again`
   * says an earlier call may have posted under the key, so it reads the key back before posting; the book sets it only
   * after the in-flight bound, when an earlier attempt can no longer land. Omitted, a reorg of a credited row refuses (`pay.deposit_reverse_unwired`) and
   * the row stays credited until it is wired; a never-credited row still closes.
   */
  readonly reverseDeposit?: (input: {
    userId: string;
    assetId: string;
    amount: Amount;
    networkId: string;
    txHash: string;
    outputIndex: number;
    again: boolean;
  }) => Promise<{ state: 'reversed'; id: string } | { state: 'unfunded' } | { state: 'unsure' }>;
  readonly registries: Pick<RegistryReader, 'listRoutableNetworks'>;
  /**
   * Publishes one credited deposit for the inbox (`payDepositCreditPosted`, key `pay:deposit-credit:posted:<id>`); throws when
   * the bus did not take it. Omitted, nothing is announced and the rows wait unrecorded, to be announced once a publisher is
   * passed.
   */
  readonly announceCredit?: (credit: DepositCreditAnnouncement) => Promise<void>;
  readonly log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/** What is announced about one credited deposit: the payload of `payDepositCreditPosted`. */
export type DepositCreditAnnouncement = PayDepositCreditPostedPayload;

/** Most credited rows one pass announces again, so a long backlog drains over passes instead of in one burst. */
const ANNOUNCE_BATCH = 200;

interface Row {
  id: string;
  user_id: string;
  asset_id: string;
  network_id: string;
  address: string;
  tx_hash: string;
  output_index: number;
  amount: string;
  confirmations: number;
  confirmations_required: number | null;
  minimum_deposit: string | null;
  status: PayCustodyDepositStatus;
  reason: PayCustodyDepositReason | null;
  detected_at: Date;
  credited_at: Date | null;
  credit_started_at: Date | null;
  reversal_started_at: Date | null;
}

/** The customer an address was issued to, and whether it had expired when this transfer was first seen. */
interface AddressOwner {
  user_id: string;
  asset_id: string;
  network_id: string;
  address: string;
  expired: boolean;
}

const COLUMNS =
  'id, user_id, asset_id, network_id, address, tx_hash, output_index, amount, confirmations, confirmations_required, minimum_deposit, status, reason, detected_at, credited_at, credit_started_at, reversal_started_at';
const ASSET_RE = /^[A-Za-z0-9]{1,16}$/;
const OPEN = new Set<PayCustodyDepositStatus>(PAY_CUSTODY_DEPOSIT_PENDING_STATUSES);
/** Held rows that still follow their confirmations, so each is judged on its real depth once released. */
const HELD = new Set<PayCustodyDepositStatus>(['on_hold', 'held_travel_rule']);
/** A held deposit's reason for each travel-rule record state that keeps it held. */
const TRAVEL_RULE_REASON: Record<string, PayCustodyDepositReason> = {
  awaiting_declaration: 'travel_rule_declaration',
  under_review: 'travel_rule_review',
  counterparty_pending: 'travel_rule_counterparty',
  blocking_time_expired: 'travel_rule_expired',
};
/** A reversal still `unsure` this long after it started (three in-flight bounds, so three rounds at least) raises an alert. */
export const REVERSAL_UNSURE_ALERT_SECONDS = 3 * POST_IN_FLIGHT_BOUND_SECONDS;

export class CustodyDepositBook {
  /**
   * Rows a chain observation can no longer change, so a poll does not judge them again. A reorg can still change one (in
   * this process or another), so a hit is checked against the row's stored status with one read by id, never trusted alone.
   */
  private readonly settled = new Map<string, { readonly id: string; readonly outcome: ChainDepositOutcome & { state: 'recorded' } }>();

  /** The announcing pass running now, if any; a call while it runs asks for one more pass after it. */
  private announcing: Promise<number> | null = null;
  private announceAgain = false;

  constructor(private readonly deps: CustodyDepositBookDeps) {}

  /** Record (and, if it is due, credit) one transfer. `unmatched` means the address is not one issued to a customer. */
  async receive(input: ChainDeposit): Promise<ChainDepositOutcome> {
    const txHash = input.txHash.toLowerCase();
    const memoKey = `${input.address.toLowerCase()}:${txHash}:${input.outputIndex}:${input.assetId}:${input.amount}`;
    const known = this.settled.get(memoKey);
    if (known) {
      const [now] = await this.deps.sql<Array<{ status: PayCustodyDepositStatus; reason: PayCustodyDepositReason | null }>>`
        SELECT status, reason FROM pay.custody_deposits WHERE id = ${known.id}`;
      if (now && now.status === known.outcome.status && now.reason === known.outcome.reason) return known.outcome;
      this.settled.delete(memoKey);
    }

    const owner = await this.addressOwner(input.address);
    if (!owner) return { state: 'unmatched' };
    if (!ASSET_RE.test(input.assetId)) throw new Error('pay.deposit_asset_invalid');

    const unknownAsset = input.assetId !== owner.asset_id;
    const row = await this.upsert({ ...input, txHash }, owner, unknownAsset);
    if (unknownAsset && row.status === 'rejected') {
      this.deps.log?.('custody deposit rejected: asset the address was not issued for', {
        alert: true,
        depositId: row.id,
        address: input.address,
        expected: owner.asset_id,
        received: input.assetId,
      });
    }
    if (row.status === 'held_for_release' && row.reason === 'address_expired') {
      // For the support desk: funds reached custody and wait for a release; nothing was credited.
      this.deps.log?.('custody deposit held for release: the address had expired', { alert: true, depositId: row.id });
    }
    const judged = await this.settle(row);
    const outcome = { state: 'recorded' as const, status: judged.status, reason: judged.reason };
    if (!OPEN.has(judged.status) && !HELD.has(judged.status) && !judged.reversal_started_at) {
      this.settled.set(memoKey, { id: judged.id, outcome });
    }
    return outcome;
  }

  /**
   * The chain took a transfer back. Close it if it never credited; reverse its credit once if it did; send it to review if
   * the balance can no longer cover the reversal. Repeats change nothing. A reorg of a transfer not recorded yet is kept,
   * so a sighting that arrives after it (a late delivery from before the reorg) is put in review instead of credited.
   */
  async reverse(input: ChainReorg): Promise<ChainReorgOutcome> {
    const owner = await this.addressOwner(input.address);
    if (!owner) return { state: 'unmatched' };
    const txHash = input.txHash.toLowerCase();
    const { sql } = this.deps;
    await sql`
      INSERT INTO pay.custody_deposit_reorgs (network_id, address, tx_hash, output_index)
      VALUES (${owner.network_id}, ${owner.address.toLowerCase()}, ${txHash}, ${input.outputIndex})
      ON CONFLICT DO NOTHING`;
    const rows = await sql<Row[]>`
      SELECT ${sql.unsafe(COLUMNS)} FROM pay.custody_deposits
       WHERE network_id = ${owner.network_id} AND tx_hash = ${txHash} AND output_index = ${input.outputIndex}
         AND lower(address) = ${input.address.toLowerCase()}
       ORDER BY detected_at, id`;
    if (rows.length === 0) return { state: 'unknown' };
    // Every row at the position is handled even if one fails; the first failure is raised after, for the watcher to retry.
    const done: Row[] = [];
    let failure: unknown = null;
    for (const row of rows) {
      try {
        done.push(await this.reverseRow(row));
      } catch (err) {
        failure ??= err;
      }
    }
    if (failure !== null) throw failure;
    // The answer names the row that carried a credit, if one did: that is the one whose money moved.
    const named = done.find((row) => row.credited_at !== null) ?? done[done.length - 1]!;
    return { state: 'recorded', status: named.status, reason: named.reason };
  }

  private async reverseRow(row: Row): Promise<Row> {
    const { sql } = this.deps;
    // Reversed already, or a token the address was never issued for: a reorg changes neither, and the rejection keeps its evidence.
    if (row.status === 'reversed' || row.status === 'rejected') return row;
    // Anything the ledger may have credited is reversed there; anything it never did is closed here and posts nothing.
    if (!row.credit_started_at) {
      const closed = await sql<Row[]>`
        UPDATE pay.custody_deposits SET status = 'reversed', reason = 'chain_reorg', updated_at = now()
         WHERE id = ${row.id} AND credit_started_at IS NULL AND status NOT IN ('reversed', 'rejected')
         RETURNING ${sql.unsafe(COLUMNS)}`;
      return closed[0] ?? this.reverseRow(await this.reload(row.id));
    }
    const reverseDeposit = this.deps.reverseDeposit;
    if (!reverseDeposit) throw new Error('pay.deposit_reverse_unwired');
    let current = row;
    let again = false;
    if (!current.credited_at) {
      // A credit a crash cut short: finish it under its own key first, so there is one credit for the one reversal. It is not
      // announced: the reversal follows at once.
      current = await this.credit(current, current.confirmations_required ?? 0, current.minimum_deposit ?? '', false);
      if (!current.credited_at) return current;
    }
    if (!current.reversal_started_at) {
      // From here the row is no longer `credited`: no sweep and no announcement treats it as money that stays, even if the
      // reversal is cut short. `settleOpen` finishes a started one.
      const started = await sql<Row[]>`
        UPDATE pay.custody_deposits SET reversal_started_at = now(), reversal_attempted_at = now(), status = 'needs_review', reason = 'chain_reorg', updated_at = now()
         WHERE id = ${current.id} AND credited_at IS NOT NULL AND status <> 'reversed' AND reversal_started_at IS NULL
         RETURNING ${sql.unsafe(COLUMNS)}`;
      if (!started[0]) {
        const now = await this.reload(current.id);
        return now.status === 'reversed' || !now.reversal_started_at ? now : this.reverseRow(now);
      }
      current = started[0];
    } else {
      // Started by an earlier call, whose post may still be in flight. Only once the bound has passed since the last attempt
      // does one caller claim the next attempt (the claim is the attempt's time, written before the post, so a crash
      // mid-post still counts). That caller reads the key back before posting again.
      const claimed = await sql<Row[]>`
        UPDATE pay.custody_deposits SET reversal_attempted_at = now(), updated_at = now()
         WHERE id = ${current.id} AND reversal_started_at IS NOT NULL AND status <> 'reversed'
           AND coalesce(reversal_attempted_at, reversal_started_at) < now() - make_interval(secs => ${POST_IN_FLIGHT_BOUND_SECONDS})
         RETURNING ${sql.unsafe(COLUMNS)}`;
      if (!claimed[0]) return this.reload(current.id);
      current = claimed[0];
      again = true;
    }
    const outcome = await reverseDeposit({
      userId: current.user_id,
      assetId: current.asset_id,
      amount: parseAmount(current.amount),
      networkId: current.network_id,
      txHash: current.tx_hash,
      outputIndex: current.output_index,
      again,
    });
    if (outcome.state === 'unsure') {
      // A refusal after a retried post: an earlier attempt may still commit, so the reversal stays started and is tried
      // again once the bound has passed. Still unsure after a few rounds, it is an alert: a person reads the ledger.
      const [age] = await sql<Array<{ stuck: boolean }>>`
        SELECT reversal_started_at <= now() - make_interval(secs => ${REVERSAL_UNSURE_ALERT_SECONDS}) AS stuck
          FROM pay.custody_deposits WHERE id = ${current.id}`;
      if (age?.stuck) {
        this.deps.log?.('custody deposit reversal still unsure after several rounds: check the ledger by its key', {
          alert: true,
          depositId: current.id,
        });
      } else {
        this.deps.log?.('custody deposit reversal unsure: a retried post was refused; left started', { depositId: current.id });
      }
      return this.reload(current.id);
    }
    if (outcome.state === 'unfunded') {
      const parked = await sql<Row[]>`
        UPDATE pay.custody_deposits
           SET status = 'needs_review', reason = 'reversal_unfunded', reversal_started_at = NULL, reversal_attempted_at = NULL, updated_at = now()
         WHERE id = ${current.id} AND status <> 'reversed' RETURNING ${sql.unsafe(COLUMNS)}`;
      // For the support desk: the chain took the deposit back after the funds were spent; nothing was posted.
      this.deps.log?.('custody deposit reversal unfunded: the credited funds were already spent', { alert: true, depositId: current.id });
      return parked[0] ?? this.reload(current.id);
    }
    const reversed = await sql<Row[]>`
      UPDATE pay.custody_deposits
         SET status = 'reversed', reason = 'chain_reorg', reversal_ledger_tx_id = ${outcome.id}, reversed_at = now(), updated_at = now()
       WHERE id = ${current.id} AND status <> 'reversed' RETURNING ${sql.unsafe(COLUMNS)}`;
    return reversed[0] ?? this.reload(current.id);
  }

  /**
   * Judge every open row again: the owner may have set a minimum, or the registry a confirmation count, since the transfer
   * was seen. Boot runs this once and the watcher tick runs it each poll. Returns how many rows credited. It also finishes
   * every reversal a crash or a ledger error cut short, under its own key.
   */
  async settleOpen(): Promise<number> {
    const started = await this.deps.sql<Row[]>`
      SELECT ${this.deps.sql.unsafe(COLUMNS)} FROM pay.custody_deposits
       WHERE reversal_started_at IS NOT NULL AND status <> 'reversed'
         AND coalesce(reversal_attempted_at, reversal_started_at) < now() - make_interval(secs => ${POST_IN_FLIGHT_BOUND_SECONDS})
       ORDER BY reversal_started_at, id LIMIT 500`;
    for (const row of started) {
      try {
        await this.reverseRow(row);
      } catch (err) {
        this.deps.log?.('custody deposit reversal left started', {
          depositId: row.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Held rows whose address has no open freeze (the lift releases its own in its transaction, so these are rows held by a
    // freeze that was lifted outside it): judged again below. A failure here leaves them held and does not stop the pass.
    try {
      await this.unhold(this.deps.sql, this.deps.sql`TRUE`);
    } catch (err) {
      this.deps.log?.('custody deposits on hold could not be checked for a lifted freeze', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await this.expireTravelRuleWaits();
    } catch (err) {
      this.deps.log?.('custody deposit travel-rule waits could not be checked', { err: err instanceof Error ? err.message : String(err) });
    }
    const rows = await this.deps.sql<Row[]>`
      SELECT ${this.deps.sql.unsafe(COLUMNS)} FROM pay.custody_deposits
       WHERE status IN ('detected', 'confirming') ORDER BY detected_at, id LIMIT 500`;
    let credited = 0;
    for (const row of rows) {
      try {
        if ((await this.settle(row)).status === 'credited') credited += 1;
      } catch (err) {
        this.deps.log?.('custody deposit left confirming', { depositId: row.id, err: err instanceof Error ? err.message : String(err) });
      }
    }
    return credited;
  }

  /**
   * Announce credited rows not yet recorded as announced (new, or left by a crash or a bus error), oldest first, and resolve
   * with how many were. One pass runs at a time: a call while one runs gets that pass, followed by one more. A pass stops at
   * the first bus failure, so a bus that is down costs one failed publish, not one per row.
   */
  announceOwed(): Promise<number> {
    if (!this.deps.announceCredit) return Promise.resolve(0);
    if (this.announcing) {
      this.announceAgain = true;
      return this.announcing;
    }
    const passes = async () => {
      let announced = 0;
      for (;;) {
        this.announceAgain = false;
        const pass = await this.announcePass();
        announced += pass.announced;
        if (pass.stopped || !this.announceAgain) return announced;
      }
    };
    this.announcing = passes().finally(() => {
      this.announcing = null;
    });
    return this.announcing;
  }

  private async announcePass(): Promise<{ announced: number; stopped: boolean }> {
    const { sql, announceCredit } = this.deps;
    if (!announceCredit) return { announced: 0, stopped: true };
    const owed = await sql<
      Array<{
        id: string;
        user_id: string;
        asset_id: string;
        network_id: string;
        amount: string;
        tx_hash: string;
        ledger_tx_id: string;
        credited_at: Date;
      }>
    >`
      SELECT id, user_id, asset_id, network_id, amount, tx_hash, ledger_tx_id, credited_at FROM pay.custody_deposits
       WHERE status = 'credited' AND credit_notified_at IS NULL ORDER BY credited_at, id LIMIT ${ANNOUNCE_BATCH}`;
    let announced = 0;
    for (const row of owed) {
      const credit = payDepositCreditPostedPayloadSchema.safeParse({
        depositId: row.id,
        userId: row.user_id,
        assetId: row.asset_id,
        networkId: row.network_id,
        amount: row.amount,
        txHash: row.tx_hash,
        ledgerTxId: row.ledger_tx_id,
        creditedAt: row.credited_at.toISOString(),
      });
      if (!credit.success) {
        // A row the event cannot carry is not a bus failure: it stays owed and is named, and the rows after it still go out.
        this.deps.log?.('custody deposit credit cannot be announced', {
          depositId: row.id,
          fields: credit.error.issues.map((issue) => issue.path.join('.')),
        });
        continue;
      }
      try {
        await announceCredit(credit.data);
      } catch (err) {
        this.deps.log?.('custody deposit credit not announced yet', {
          depositId: row.id,
          waiting: owed.length - announced,
          err: err instanceof Error ? err.message : String(err),
        });
        return { announced, stopped: true };
      }
      await sql`UPDATE pay.custody_deposits SET credit_notified_at = now() WHERE id = ${row.id} AND credit_notified_at IS NULL`;
      announced += 1;
    }
    return { announced, stopped: false };
  }

  async records(input: PayCustodyDepositRecordsInput & { offset: number; limit: number }): Promise<PayCustodyDepositRecordsReply> {
    const { sql } = this.deps;
    const where = sql`user_id = ${input.userId}
      ${input.assetId ? sql`AND asset_id = ${input.assetId}` : sql``}
      ${input.networkId ? sql`AND network_id = ${input.networkId}` : sql``}
      ${input.statuses ? sql`AND status IN ${sql([...input.statuses])}` : sql``}
      ${input.txHash ? sql`AND tx_hash = ${input.txHash.toLowerCase()}` : sql``}
      ${input.address ? sql`AND lower(address) = ${input.address.toLowerCase()}` : sql``}`;
    const [rows, count] = await Promise.all([
      sql<Row[]>`SELECT ${sql.unsafe(COLUMNS)} FROM pay.custody_deposits WHERE ${where}
                  ORDER BY detected_at DESC, id LIMIT ${input.limit} OFFSET ${input.offset}`,
      sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM pay.custody_deposits WHERE ${where}`,
    ]);
    return { items: rows.map(toRecord), total: Number(count[0]?.n ?? '0') };
  }

  private async addressOwner(address: string): Promise<AddressOwner | null> {
    // `expired` is the database's own clock, the same one `detected_at` is written with.
    const rows = await this.deps.sql<AddressOwner[]>`
      SELECT user_id, asset_id, network_id, address, (expires_at IS NOT NULL AND expires_at <= now()) AS expired
        FROM pay.custody_deposit_addresses
       WHERE lower(address) = ${address.toLowerCase()} LIMIT 2`;
    // Two owners of one address is a fault, not a guess: nothing is credited until a person looks.
    if (rows.length > 1) throw new Error('pay.deposit_address_ambiguous');
    return rows[0] ?? null;
  }

  /** Insert the row, or read the one that is there and apply the new confirmation depth. A different amount is `needs_review`. */
  private async upsert(input: ChainDeposit & { txHash: string }, owner: AddressOwner, unknownAsset: boolean): Promise<Row> {
    const { sql } = this.deps;
    const amount = formatAmount(input.amount);
    const conf = Math.max(0, Math.trunc(input.confirmations));
    // Only a NEW row is judged against the expiry: a transfer already recorded before the address expired keeps its course.
    return sql.begin(async (tx) => {
      // A reorg already reported for this position (it arrived before this sighting): never credited on its own.
      const reorged =
        (
          await tx`
            SELECT 1 FROM pay.custody_deposit_reorgs
             WHERE network_id = ${owner.network_id} AND address = ${owner.address.toLowerCase()} AND tx_hash = ${input.txHash}
               AND output_index = ${input.outputIndex}`
        ).length > 0;
      const first = unknownAsset
        ? 'rejected'
        : reorged
          ? 'needs_review'
          : owner.expired
            ? 'held_for_release'
            : conf > 0
              ? 'confirming'
              : 'detected';
      const firstReason = unknownAsset ? 'unknown_asset' : reorged ? 'chain_reorg' : owner.expired ? 'address_expired' : null;
      const inserted = await tx<Row[]>`
        INSERT INTO pay.custody_deposits (user_id, asset_id, network_id, address, tx_hash, output_index, amount, confirmations, status, reason)
        VALUES (${owner.user_id}, ${input.assetId}, ${owner.network_id}, ${owner.address}, ${input.txHash}, ${input.outputIndex},
                ${amount}, ${conf}, ${first}, ${firstReason})
        ON CONFLICT (asset_id, network_id, tx_hash, output_index) DO NOTHING
        RETURNING ${sql.unsafe(COLUMNS)}`;
      if (inserted[0]) {
        if (reorged && !unknownAsset) {
          this.deps.log?.('custody deposit first seen after a reorg took it out', { alert: true, depositId: inserted[0].id });
        }
        return inserted[0];
      }
      const existing = (
        await tx<Row[]>`
          SELECT ${sql.unsafe(COLUMNS)} FROM pay.custody_deposits
           WHERE asset_id = ${input.assetId} AND network_id = ${owner.network_id} AND tx_hash = ${input.txHash}
             AND output_index = ${input.outputIndex} FOR UPDATE`
      )[0]!;
      if (existing.status === 'reversed' && !existing.credit_started_at) {
        // Seen again after a reorg took it out. A re-inclusion and a late delivery from before the reorg look the same here,
        // so it is not credited on its own: a person checks the chain.
        const flagged = await tx<Row[]>`
          UPDATE pay.custody_deposits SET status = 'needs_review', reason = 'chain_reorg', updated_at = now()
           WHERE id = ${existing.id} RETURNING ${sql.unsafe(COLUMNS)}`;
        this.deps.log?.('custody deposit seen again after a reorg took it out', { alert: true, depositId: existing.id });
        return flagged[0]!;
      }
      if (existing.status === 'reversed' || (existing.status === 'needs_review' && existing.credited_at)) {
        // A reversed credit, or one in review, seen again: its credit key is spent, so only a person decides what it is worth.
        this.deps.log?.('custody deposit seen again after its credit was reversed or sent to review', {
          alert: true,
          depositId: existing.id,
        });
        return existing;
      }
      // A held row keeps following its confirmations, so it is judged on its real depth once released.
      if ((!OPEN.has(existing.status) && !HELD.has(existing.status)) || existing.credit_started_at) return existing;
      if (parseAmount(existing.amount) !== input.amount) {
        const flagged = await tx<Row[]>`
          UPDATE pay.custody_deposits SET status = 'needs_review', reason = 'amount_mismatch', updated_at = now()
           WHERE id = ${existing.id} RETURNING ${sql.unsafe(COLUMNS)}`;
        this.deps.log?.('custody deposit amount changed between sightings', { alert: true, depositId: existing.id });
        return flagged[0]!;
      }
      if (conf <= existing.confirmations) return existing;
      const moved = await tx<Row[]>`
        UPDATE pay.custody_deposits
           SET confirmations = ${conf}, status = CASE WHEN status IN ('on_hold', 'held_travel_rule') THEN status ELSE 'confirming' END,
               updated_at = now()
         WHERE id = ${existing.id} RETURNING ${sql.unsafe(COLUMNS)}`;
      return moved[0]!;
    });
  }

  /** Decide an open row: wait, mark below minimum, or credit. Anything else is returned as it is. */
  private async settle(row: Row): Promise<Row> {
    if (!OPEN.has(row.status)) return row;
    const { sql } = this.deps;
    if (row.credit_started_at) return this.credit(row, row.confirmations_required ?? 0, row.minimum_deposit ?? '');
    if (await this.frozen(row)) return this.hold(row);
    const [required, minimum] = await Promise.all([this.requiredConfirmations(row), this.minimumDeposit(row)]);

    if (required === null) return this.park(row, null, minimum, 'confirmations_unset');
    if (minimum === null) return this.park(row, required, null, 'minimum_unset');

    const amount = parseAmount(row.amount);
    if (amount < parseAmount(minimum)) {
      const done = await sql<Row[]>`
        UPDATE pay.custody_deposits
           SET status = 'below_minimum', reason = 'below_minimum', confirmations_required = ${required}, minimum_deposit = ${minimum},
               updated_at = now()
         WHERE id = ${row.id} AND status IN ('detected', 'confirming') RETURNING ${sql.unsafe(COLUMNS)}`;
      return done[0] ?? (await this.reload(row.id));
    }
    if (row.confirmations < required) {
      const waiting = await sql<Row[]>`
        UPDATE pay.custody_deposits
           SET confirmations_required = ${required}, minimum_deposit = ${minimum}, reason = NULL, updated_at = now()
         WHERE id = ${row.id} AND status IN ('detected', 'confirming') RETURNING ${sql.unsafe(COLUMNS)}`;
      return waiting[0] ?? (await this.reload(row.id));
    }

    const travel = await this.travelRuleGate(row, required, minimum);
    if (travel !== 'clear') return travel;
    return this.credit(row, required, minimum);
  }

  /**
   * The inbound travel rule for a deposit that is otherwise due (W-deposit-07): `clear` to credit, or the row as it now stands
   * (parked with `travel_rule_unset`, or held with a record opened). A released record lets the deposit through; a record in
   * any other state keeps it held.
   */
  private async travelRuleGate(row: Row, required: number, minimum: string): Promise<'clear' | Row> {
    const { sql } = this.deps;
    const [record] = await sql<Array<{ state: string }>>`
      SELECT e.state FROM pay.custody_deposit_travel_rule t
        JOIN LATERAL (SELECT state FROM pay.custody_deposit_travel_rule_events WHERE deposit_id = t.deposit_id ORDER BY seq DESC LIMIT 1) e
          ON true
       WHERE t.deposit_id = ${row.id}`;
    if (record) return record.state === 'released' ? 'clear' : this.holdForTravelRule(row, record.state);
    const [rule] = await sql<Array<{ seq: string; applies: boolean; threshold: string | null; fields: unknown }>>`
      SELECT seq::text, applies, threshold::text, fields FROM pay.travel_rule_inbound_rule_events
       WHERE asset_id = ${row.asset_id} ORDER BY seq DESC LIMIT 1`;
    if (!rule) return this.park(row, required, minimum, 'travel_rule_unset');
    if (!rule.applies || rule.threshold === null || parseAmount(row.amount) < parseAmount(rule.threshold)) return 'clear';
    const held = await sql.begin(async (tx) => {
      const rows = await tx<Row[]>`
        UPDATE pay.custody_deposits
           SET status = 'held_travel_rule', reason = 'travel_rule_declaration', confirmations_required = ${required},
               minimum_deposit = ${minimum}, updated_at = now()
         WHERE id = ${row.id} AND status IN ('detected', 'confirming') AND credit_started_at IS NULL
         RETURNING ${tx.unsafe(COLUMNS)}`;
      if (!rows[0]) return null;
      await tx`
        INSERT INTO pay.custody_deposit_travel_rule (deposit_id, user_id, rule_seq, threshold, required_fields)
        VALUES (${row.id}, ${row.user_id}, ${rule.seq}::bigint, ${rule.threshold}::numeric, ${tx.json(rule.fields as never)})`;
      await tx`
        INSERT INTO pay.custody_deposit_travel_rule_events (deposit_id, state, source, actor, reason)
        VALUES (${row.id}, 'awaiting_declaration', 'system', 'svc-pay', 'at or above the owner travel-rule threshold')`;
      return rows[0];
    });
    return held ?? (await this.reload(row.id));
  }

  /** A row whose record is not released yet: held, with the reason its record's state names. */
  private async holdForTravelRule(row: Row, state: string): Promise<Row> {
    const { sql } = this.deps;
    const reason = TRAVEL_RULE_REASON[state] ?? 'travel_rule_declaration';
    const held = await sql<Row[]>`
      UPDATE pay.custody_deposits SET status = 'held_travel_rule', reason = ${reason}, updated_at = now()
       WHERE id = ${row.id} AND status IN ('detected', 'confirming') AND credit_started_at IS NULL RETURNING ${sql.unsafe(COLUMNS)}`;
    return held[0] ?? (await this.reload(row.id));
  }

  /**
   * A founder released a held deposit (`record` writes the release event and returns what it wrote). In one transaction the
   * release is recorded and the deposit goes back to be judged; then it is credited once under its usual key if it is due. A
   * credit the ledger did not answer stays started and `settleOpen` finishes it.
   */
  async releaseTravelRule<T>(depositId: string, record: (tx: Sql) => Promise<T>): Promise<{ recorded: T; credited: boolean }> {
    const { recorded, row } = await this.deps.sql.begin(async (tx) => {
      const recorded = await record(tx as unknown as Sql);
      const rows = await (tx as unknown as Sql)<Row[]>`
        UPDATE pay.custody_deposits
           SET status = CASE WHEN confirmations > 0 THEN 'confirming' ELSE 'detected' END, reason = NULL, updated_at = now()
         WHERE id = ${depositId} AND status = 'held_travel_rule' RETURNING ${(tx as unknown as Sql).unsafe(COLUMNS)}`;
      return { recorded, row: rows[0] ?? null };
    });
    if (!row) return { recorded, credited: false };
    try {
      return { recorded, credited: (await this.settle(row)).status === 'credited' };
    } catch (err) {
      this.deps.log?.('custody deposit released from the travel rule but not credited yet', {
        depositId,
        err: err instanceof Error ? err.message : String(err),
      });
      return { recorded, credited: false };
    }
  }

  /** The record's state as the deposit's reason. Used when a record moves while the deposit stays held. */
  async markTravelRuleReason(tx: Sql, depositId: string, state: string): Promise<void> {
    const reason = TRAVEL_RULE_REASON[state];
    if (!reason) return;
    await tx`UPDATE pay.custody_deposits SET reason = ${reason}, updated_at = now() WHERE id = ${depositId} AND status = 'held_travel_rule'`;
  }

  /**
   * Counterparty waits that ran out are recorded `blocking_time_expired`, and the deposit stays held: a timer never releases
   * (ENGINE T-3). Returns how many were recorded.
   */
  async expireTravelRuleWaits(): Promise<number> {
    const { sql } = this.deps;
    return sql.begin(async (tx) => {
      const due = await tx<Array<{ deposit_id: string }>>`
        SELECT t.deposit_id FROM pay.custody_deposit_travel_rule t
          JOIN LATERAL (SELECT state, wait_deadline FROM pay.custody_deposit_travel_rule_events
                         WHERE deposit_id = t.deposit_id ORDER BY seq DESC LIMIT 1) e ON true
         WHERE e.state = 'counterparty_pending' AND e.wait_deadline < now()
         ORDER BY t.deposit_id LIMIT 500
         FOR UPDATE OF t SKIP LOCKED`;
      for (const { deposit_id } of due) {
        await tx`
          INSERT INTO pay.custody_deposit_travel_rule_events (deposit_id, state, source, actor, reason)
          VALUES (${deposit_id}, 'blocking_time_expired', 'system', 'svc-pay', 'the counterparty wait ran out; still held')`;
        await this.markTravelRuleReason(tx as unknown as Sql, deposit_id, 'blocking_time_expired');
      }
      return due.length;
    });
  }

  /** Mark the credit started (with the judging figures), post under the business key, then flip. Retried as it is after a crash. */
  private async credit(row: Row, required: number, minimum: string, announce = true): Promise<Row> {
    const { sql } = this.deps;
    const amount = parseAmount(row.amount);
    if (!row.credit_started_at) {
      const started = await sql<Row[]>`
        UPDATE pay.custody_deposits
           SET credit_started_at = now(), reason = NULL, confirmations_required = ${required}, minimum_deposit = ${minimum}, updated_at = now()
         WHERE id = ${row.id} AND status IN ('detected', 'confirming')
           AND NOT EXISTS (
             SELECT 1 FROM pay.custody_deposit_address_freezes f
              WHERE f.network_id = custody_deposits.network_id AND f.address = lower(custody_deposits.address) AND f.unfrozen_at IS NULL)
         RETURNING ${sql.unsafe(COLUMNS)}`;
      if (!started[0]) {
        // Frozen between the judgement and the start: held, never credited.
        const now = await this.reload(row.id);
        return OPEN.has(now.status) && !now.credit_started_at && (await this.frozen(now)) ? this.hold(now) : now;
      }
    }
    const tx = await this.deps.postDeposit({
      userId: row.user_id,
      assetId: row.asset_id,
      amount,
      networkId: row.network_id,
      txHash: row.tx_hash,
      outputIndex: row.output_index,
    });
    const credited = await sql<Row[]>`
      UPDATE pay.custody_deposits
         SET status = 'credited', reason = NULL, confirmations_required = ${required}, minimum_deposit = ${minimum},
             ledger_tx_id = ${tx.id}, credited_at = now(), updated_at = now()
       WHERE id = ${row.id} AND status IN ('detected', 'confirming') RETURNING ${sql.unsafe(COLUMNS)}`;
    if (credited[0]) {
      // Announced in the background: the credit never waits for the bus, and one not announced now is on a later pass.
      if (announce && this.deps.announceCredit) {
        this.announceOwed().catch((err: unknown) =>
          this.deps.log?.('custody deposit credits not announced', { err: err instanceof Error ? err.message : String(err) }),
        );
      }
      return credited[0];
    }
    return this.reload(row.id);
  }

  /** True while the row's address has an open compliance freeze. */
  private async frozen(row: Pick<Row, 'network_id' | 'address'>): Promise<boolean> {
    const rows = await this.deps.sql`
      SELECT 1 FROM pay.custody_deposit_address_freezes
       WHERE network_id = ${row.network_id} AND address = ${row.address.toLowerCase()} AND unfrozen_at IS NULL`;
    return rows.length > 0;
  }

  private async hold(row: Row): Promise<Row> {
    const { sql } = this.deps;
    const held = await sql<Row[]>`
      UPDATE pay.custody_deposits SET status = 'on_hold', reason = 'address_frozen', updated_at = now()
       WHERE id = ${row.id} AND status IN ('detected', 'confirming') AND credit_started_at IS NULL RETURNING ${sql.unsafe(COLUMNS)}`;
    return held[0] ?? (await this.reload(row.id));
  }

  /**
   * Compliance froze `address` (W-compliance-notices-03): every deposit to it that is still on its way and not started is held
   * now, so the customer sees it on hold at once. Returns how many were held. Nothing is posted.
   */
  async holdAddress(networkId: string, address: string): Promise<number> {
    const { sql } = this.deps;
    const held = await sql`
      UPDATE pay.custody_deposits SET status = 'on_hold', reason = 'address_frozen', updated_at = now()
       WHERE network_id = ${networkId} AND lower(address) = ${address.toLowerCase()}
         AND status IN ('detected', 'confirming') AND credit_started_at IS NULL
         AND EXISTS (
           SELECT 1 FROM pay.custody_deposit_address_freezes f
            WHERE f.network_id = ${networkId} AND f.address = ${address.toLowerCase()} AND f.unfrozen_at IS NULL)
       RETURNING id`;
    return held.length;
  }

  /**
   * Lift the freeze on `address` (`lift` runs the freeze table's own update) and put its held deposits back to be judged, in
   * one transaction, so a lift never commits with its deposits still held and no other pass can claim them first. Then each
   * one that is due is credited once, under its usual key; a credit the ledger did not answer stays started and `settleOpen`
   * finishes it. Returns what `lift` returned, how many were released and how many credited now.
   */
  async release<T>(
    networkId: string,
    address: string,
    lift: (tx: Sql) => Promise<T>,
  ): Promise<{ lifted: T; released: number; credited: number }> {
    const { lifted, rows } = await this.deps.sql.begin(async (tx) => {
      const lifted = await lift(tx as unknown as Sql);
      const rows = await this.unhold(tx as unknown as Sql, tx`network_id = ${networkId} AND lower(address) = ${address.toLowerCase()}`);
      return { lifted, rows };
    });
    let credited = 0;
    for (const row of rows) {
      try {
        if ((await this.settle(row)).status === 'credited') credited += 1;
      } catch (err) {
        this.deps.log?.('custody deposit released but not credited yet', {
          depositId: row.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { lifted, released: rows.length, credited };
  }

  /** Put held rows matching `where` whose address has no open freeze back to `confirming` (or `detected`). */
  private async unhold(sql: Sql, where: ReturnType<Sql>): Promise<Row[]> {
    return sql<Row[]>`
      UPDATE pay.custody_deposits d
         SET status = CASE WHEN d.confirmations > 0 THEN 'confirming' ELSE 'detected' END, reason = NULL, updated_at = now()
       WHERE ${where} AND d.status = 'on_hold'
         AND NOT EXISTS (
           SELECT 1 FROM pay.custody_deposit_address_freezes f
            WHERE f.network_id = d.network_id AND f.address = lower(d.address) AND f.unfrozen_at IS NULL)
       RETURNING ${sql.unsafe(
         COLUMNS.split(', ')
           .map((c) => `d.${c}`)
           .join(', '),
       )}`;
  }

  private async park(row: Row, required: number | null, minimum: string | null, reason: PayCustodyDepositReason): Promise<Row> {
    const { sql } = this.deps;
    const parked = await sql<Row[]>`
      UPDATE pay.custody_deposits
         SET status = 'confirming', reason = ${reason}, confirmations_required = ${required}, minimum_deposit = ${minimum},
             updated_at = now()
       WHERE id = ${row.id} AND status IN ('detected', 'confirming') RETURNING ${sql.unsafe(COLUMNS)}`;
    return parked[0] ?? (await this.reload(row.id));
  }

  private async reload(id: string): Promise<Row> {
    const rows = await this.deps.sql<Row[]>`SELECT ${this.deps.sql.unsafe(COLUMNS)} FROM pay.custody_deposits WHERE id = ${id}`;
    return rows[0]!;
  }

  /** The registry's published count for the row's network and asset, or null when the pair is not routable or the count is blank. */
  private async requiredConfirmations(row: Row): Promise<number | null> {
    const network = (await this.deps.registries.listRoutableNetworks()).find((n) => n.networkId === row.network_id);
    if (!network || network.confirmationsRequired === null || !network.assetCodes.includes(row.asset_id)) return null;
    return network.confirmationsRequired;
  }

  /** The owner's enabled minimum for the pair, or null when there is none. */
  private async minimumDeposit(row: Row): Promise<string | null> {
    const rows = await this.deps.sql<Array<{ minimum_deposit: string }>>`
      SELECT minimum_deposit FROM pay.custody_deposit_settings
       WHERE asset_id = ${row.asset_id} AND network_id = ${row.network_id} AND enabled`;
    return rows[0]?.minimum_deposit ?? null;
  }
}

function toRecord(row: Row): PayCustodyDepositRecord {
  return {
    id: row.id,
    assetId: row.asset_id,
    networkId: row.network_id,
    address: row.address,
    txHash: row.tx_hash,
    outputIndex: row.output_index,
    amount: row.amount,
    confirmations: row.confirmations,
    confirmationsRequired: row.confirmations_required,
    status: row.status,
    reason: row.reason,
    minimumDeposit: row.minimum_deposit,
    detectedAt: row.detected_at.toISOString(),
    creditedAt: row.credited_at ? row.credited_at.toISOString() : null,
  };
}
