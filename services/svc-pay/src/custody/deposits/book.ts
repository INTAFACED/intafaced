import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import {
  PAY_CUSTODY_DEPOSIT_PENDING_STATUSES,
  type PayCustodyDepositReason,
  type PayCustodyDepositRecord,
  type PayCustodyDepositRecordsInput,
  type PayCustodyDepositRecordsReply,
  type PayCustodyDepositStatus,
} from '@intafaced/contracts';
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
 *   issued for is `rejected` and logged as an alert. `held_for_screening` is W-deposit-06 (holds, still to come).
 * - REORG (W-deposit-06). A row is one transfer at one index of one transaction. If the chain positively says that transfer is gone
 *   (the node answered "no such receipt" on several refreshes in a row, the transaction reverted), the credit is taken back once through the reversal post
 *   (`deposit.reverse:<network>:<tx>:<index>`) and the row is `reversed`. A node that did not answer proves nothing. A transfer re-mined in another block keeps its
 *   credit, at the same index or another (the money is the same); the stored block is updated. A row at a new index for a
 *   transaction that already holds a credit is never credited (no double credit); it waits for a person. `reversal_started_at` is written before the ledger is asked, so a crash between
 *   the two is finished on the next pass under the same key. If the customer has already spent the funds the ledger refuses, and
 *   the row is `needs_review` with `reversal_unfunded` and an alert: the balance never goes negative and a person decides. A
 *   reversed row is never credited again by this book. KNOWN GAP: a transfer that vanishes while no process is watching is not
 *   re-checked by height after a restart (follow-up: a reorg audit sweep).
 */

/** One transfer to a watched address, as the chain saw it. */
export interface ChainDeposit {
  readonly address: string;
  readonly txHash: string;
  readonly outputIndex: number;
  readonly assetId: string;
  readonly amount: Amount;
  readonly confirmations: number;
  /** Block the transfer was last read from, when the node said. A different hash on a credited row is a reorg. */
  readonly blockHeight?: bigint | null;
  readonly blockHash?: string | null;
}

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
  /** The one deposit engine again (`UserMoneyService.postCustodyDepositReverse`): takes a credit back under its business key. */
  readonly reverseDeposit: (input: {
    userId: string;
    assetId: string;
    amount: Amount;
    networkId: string;
    txHash: string;
    outputIndex: number;
  }) => Promise<{ id: string }>;
  readonly registries: Pick<RegistryReader, 'listRoutableNetworks'>;
  readonly log?: (msg: string, extra?: Record<string, unknown>) => void;
}

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
  block_height: string | null;
  block_hash: string | null;
  reversal_started_at: Date | null;
}

const COLUMNS =
  'id, user_id, asset_id, network_id, address, tx_hash, output_index, amount, confirmations, confirmations_required, minimum_deposit, status, reason, detected_at, credited_at, credit_started_at, block_height, block_hash, reversal_started_at';
const ASSET_RE = /^[A-Za-z0-9]{1,16}$/;
const OPEN = new Set<PayCustodyDepositStatus>(PAY_CUSTODY_DEPOSIT_PENDING_STATUSES);

export class CustodyDepositBook {
  /** Keys of rows that can no longer change by a chain observation, so a poll does not read them again. */
  private readonly settled = new Map<string, ChainDepositOutcome>();

  constructor(private readonly deps: CustodyDepositBookDeps) {}

  /** Record (and, if it is due, credit) one transfer. `unmatched` means the address is not one issued to a customer. */
  async receive(input: ChainDeposit): Promise<ChainDepositOutcome> {
    const txHash = input.txHash.toLowerCase();
    const memoKey = `${input.address.toLowerCase()}:${txHash}:${input.outputIndex}:${input.assetId}:${input.amount}:${input.blockHash ?? ''}`;
    const known = this.settled.get(memoKey);
    if (known) return known;

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
    if (row.status === 'credited') {
      // A reversal that was started is finished. A new block hash for a transfer still at the same index is NOT a reason to take
      // the credit back: the funds are on the chain, only the block moved, so the stored block is brought up to date as evidence.
      if (row.reversal_started_at) {
        const reversed = await this.reverse(row, 'finishing a reversal that was started');
        return { state: 'recorded', status: reversed.status, reason: reversed.reason };
      }
      const hash = input.blockHash ? input.blockHash.toLowerCase() : null;
      if (hash !== null && hash !== row.block_hash) {
        await this.deps.sql`
          UPDATE pay.custody_deposits SET block_hash = ${hash},
                 block_height = COALESCE(${input.blockHeight === null || input.blockHeight === undefined ? null : input.blockHeight.toString()}, block_height),
                 updated_at = now()
           WHERE id = ${row.id} AND status = 'credited'`;
        if (row.block_hash !== null) {
          this.deps.log?.('custody deposit block changed, transfer still present at the same index', { depositId: row.id });
        }
      }
    }
    const judged = await this.settle(row);
    const outcome: ChainDepositOutcome = { state: 'recorded', status: judged.status, reason: judged.reason };
    if (!OPEN.has(judged.status)) this.settled.set(memoKey, outcome);
    return outcome;
  }

  /**
   * The chain no longer reports these transfers (dropped, replaced or reverted after they were seen). A credited row for one of
   * them is reversed; any other row is left as it is, because nothing was posted for it. Returns how many credits were taken back.
   */
  async dropped(items: readonly Pick<ChainDeposit, 'address' | 'txHash' | 'outputIndex' | 'assetId'>[]): Promise<number> {
    let reversed = 0;
    for (const item of items) {
      const key = `${item.address.toLowerCase()}:${item.txHash.toLowerCase()}:${item.outputIndex}:${item.assetId}`;
      try {
        const rows = await this.deps.sql<Row[]>`
          SELECT ${this.deps.sql.unsafe(COLUMNS)} FROM pay.custody_deposits
           WHERE lower(address) = ${item.address.toLowerCase()} AND tx_hash = ${item.txHash.toLowerCase()}
             AND output_index = ${item.outputIndex} AND asset_id = ${item.assetId} AND status = 'credited'`;
        const row = rows[0];
        if (row && (await this.reverse(row, 'the chain no longer reports the transfer')).status === 'reversed') reversed += 1;
      } catch (err) {
        this.deps.log?.('custody deposit reversal left pending', {
          alert: true,
          key,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return reversed;
  }

  /** Finish every reversal that was started and not recorded (a crash between the ledger post and the row flip). */
  async resumeReversals(): Promise<number> {
    const rows = await this.deps.sql<Row[]>`
      SELECT ${this.deps.sql.unsafe(COLUMNS)} FROM pay.custody_deposits
       WHERE status = 'credited' AND reversal_started_at IS NOT NULL ORDER BY reversal_started_at, id LIMIT 200`;
    let done = 0;
    for (const row of rows) {
      try {
        if ((await this.reverse(row, 'finishing a reversal that was started')).status === 'reversed') done += 1;
      } catch (err) {
        this.deps.log?.('custody deposit reversal left pending', {
          alert: true,
          depositId: row.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return done;
  }

  /**
   * Take one credit back. Writes `reversal_started_at` first, posts under the business key, then flips the row. A ledger refusal
   * for lack of funds is `needs_review`; any other error leaves the row credited with the start marked, and is rethrown.
   */
  private async reverse(row: Row, why: string): Promise<Row> {
    const { sql } = this.deps;
    if (row.status !== 'credited') return row;
    await sql`UPDATE pay.custody_deposits SET reversal_started_at = COALESCE(reversal_started_at, now()), updated_at = now()
               WHERE id = ${row.id} AND status = 'credited'`;
    let txId: string;
    try {
      txId = (
        await this.deps.reverseDeposit({
          userId: row.user_id,
          assetId: row.asset_id,
          amount: parseAmount(row.amount),
          networkId: row.network_id,
          txHash: row.tx_hash,
          outputIndex: row.output_index,
        })
      ).id;
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'ledger.insufficient_funds') {
        const held = await sql<Row[]>`
          UPDATE pay.custody_deposits SET status = 'needs_review', reason = 'reversal_unfunded', updated_at = now()
           WHERE id = ${row.id} AND status = 'credited' RETURNING ${sql.unsafe(COLUMNS)}`;
        this.deps.log?.('custody deposit reversal not covered: the funds are already spent', {
          alert: true,
          depositId: row.id,
          why,
        });
        return held[0] ?? (await this.reload(row.id));
      }
      throw err;
    }
    const done = await sql<Row[]>`
      UPDATE pay.custody_deposits
         SET status = 'reversed', reason = 'chain_reorg', reversed_at = now(), reversal_ledger_tx_id = ${txId}, updated_at = now()
       WHERE id = ${row.id} AND status = 'credited' RETURNING ${sql.unsafe(COLUMNS)}`;
    this.deps.log?.('custody deposit reversed', { alert: true, depositId: row.id, why });
    return done[0] ?? (await this.reload(row.id));
  }

  /**
   * Judge every open row again: the owner may have set a minimum, or the registry a confirmation count, since the transfer
   * was seen. Boot runs this once and the watcher tick runs it each poll. Returns how many rows credited.
   */
  async settleOpen(): Promise<number> {
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

  private async addressOwner(address: string): Promise<{ user_id: string; asset_id: string; network_id: string; address: string } | null> {
    const rows = await this.deps.sql<Array<{ user_id: string; asset_id: string; network_id: string; address: string }>>`
      SELECT user_id, asset_id, network_id, address FROM pay.custody_deposit_addresses
       WHERE lower(address) = ${address.toLowerCase()} LIMIT 2`;
    // Two owners of one address is a fault, not a guess: nothing is credited until a person looks.
    if (rows.length > 1) throw new Error('pay.deposit_address_ambiguous');
    return rows[0] ?? null;
  }

  /** Insert the row, or read the one that is there and apply the new confirmation depth. A different amount is `needs_review`. */
  private async upsert(
    input: ChainDeposit & { txHash: string },
    owner: { user_id: string; asset_id: string; network_id: string; address: string },
    unknownAsset: boolean,
  ): Promise<Row> {
    const { sql } = this.deps;
    const amount = formatAmount(input.amount);
    const conf = Math.max(0, Math.trunc(input.confirmations));
    const first = unknownAsset ? 'rejected' : conf > 0 ? 'confirming' : 'detected';
    const blockHeight = input.blockHeight === null || input.blockHeight === undefined ? null : input.blockHeight.toString();
    const blockHash = input.blockHash ? input.blockHash.toLowerCase() : null;
    return sql.begin(async (tx) => {
      const inserted = await tx<Row[]>`
        INSERT INTO pay.custody_deposits
          (user_id, asset_id, network_id, address, tx_hash, output_index, amount, confirmations, status, reason, block_height, block_hash)
        VALUES (${owner.user_id}, ${input.assetId}, ${owner.network_id}, ${owner.address}, ${input.txHash}, ${input.outputIndex},
                ${amount}, ${conf}, ${first}, ${unknownAsset ? 'unknown_asset' : null}, ${blockHeight}, ${blockHash})
        ON CONFLICT (asset_id, network_id, tx_hash, output_index) DO NOTHING
        RETURNING ${sql.unsafe(COLUMNS)}`;
      if (inserted[0]) return inserted[0];
      const existing = (
        await tx<Row[]>`
          SELECT ${sql.unsafe(COLUMNS)} FROM pay.custody_deposits
           WHERE asset_id = ${input.assetId} AND network_id = ${owner.network_id} AND tx_hash = ${input.txHash}
             AND output_index = ${input.outputIndex} FOR UPDATE`
      )[0]!;
      if (!OPEN.has(existing.status) || existing.credit_started_at) return existing;
      if (parseAmount(existing.amount) !== input.amount) {
        const flagged = await tx<Row[]>`
          UPDATE pay.custody_deposits SET status = 'needs_review', reason = 'amount_mismatch', updated_at = now()
           WHERE id = ${existing.id} RETURNING ${sql.unsafe(COLUMNS)}`;
        this.deps.log?.('custody deposit amount changed between sightings', { alert: true, depositId: existing.id });
        return flagged[0]!;
      }
      const blockMoved = blockHash !== null && blockHash !== existing.block_hash;
      if (conf <= existing.confirmations && !blockMoved) return existing;
      const moved = await tx<Row[]>`
        UPDATE pay.custody_deposits
           SET confirmations = ${conf}, status = 'confirming',
               block_height = COALESCE(${blockHeight}, block_height), block_hash = COALESCE(${blockHash}, block_hash), updated_at = now()
         WHERE id = ${existing.id} RETURNING ${sql.unsafe(COLUMNS)}`;
      return moved[0]!;
    });
  }

  /** Decide an open row: wait, mark below minimum, or credit. Anything else is returned as it is. */
  private async settle(row: Row): Promise<Row> {
    if (!OPEN.has(row.status)) return row;
    const { sql } = this.deps;
    if (row.credit_started_at) return this.credit(row, row.confirmations_required ?? 0, row.minimum_deposit ?? '');
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

    if (await this.siblingHoldsCredit(row)) {
      this.deps.log?.('custody deposit not credited: another row of the same transaction already holds a credit', {
        alert: true,
        depositId: row.id,
        txHash: row.tx_hash,
      });
      return row;
    }
    return this.credit(row, required, minimum);
  }

  /**
   * One on-chain transfer must not be credited twice because a re-mine gave it another index. A row of the same transaction to the
   * same address and asset that holds a credit read from another block (a re-mine) blocks the new one until a person looks. Several
   * outputs of one transaction share a block and are all credited.
   */
  private async siblingHoldsCredit(row: Row): Promise<boolean> {
    const found = await this.deps.sql<{ id: string }[]>`
      SELECT id FROM pay.custody_deposits
       WHERE network_id = ${row.network_id} AND tx_hash = ${row.tx_hash} AND lower(address) = ${row.address.toLowerCase()}
         AND asset_id = ${row.asset_id} AND id <> ${row.id}
         AND (status IN ('credited', 'needs_review') OR credit_started_at IS NOT NULL AND status <> 'reversed')
         AND block_hash IS NOT NULL AND ${row.block_hash}::text IS NOT NULL AND block_hash <> ${row.block_hash}::text
       LIMIT 1`;
    return found.length > 0;
  }

  /** Mark the credit started (with the judging figures), post under the business key, then flip. Retried as it is after a crash. */
  private async credit(row: Row, required: number, minimum: string): Promise<Row> {
    const { sql } = this.deps;
    const amount = parseAmount(row.amount);
    if (!row.credit_started_at) {
      const started = await sql<Row[]>`
        UPDATE pay.custody_deposits
           SET credit_started_at = now(), reason = NULL, confirmations_required = ${required}, minimum_deposit = ${minimum}, updated_at = now()
         WHERE id = ${row.id} AND status IN ('detected', 'confirming') RETURNING ${sql.unsafe(COLUMNS)}`;
      if (!started[0]) return this.reload(row.id);
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
    return credited[0] ?? (await this.reload(row.id));
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
