import type { Sql } from 'postgres';
import { formatAmount, parseAmount, recipes, type Amount, type LedgerClient } from '@intafaced/ledger-client';
import {
  PAY_CUSTODY_DEPOSIT_PENDING_STATUSES,
  type PayCustodyDepositReason,
  type PayCustodyDepositRecord,
  type PayCustodyDepositRecordsInput,
  type PayCustodyDepositRecordsReply,
  type PayCustodyDepositStatus,
} from '@intafaced/contracts';
import type { RegistryReader } from '../../registries/read-api.js';
import { postPayLedger } from '../../ledger-receipt.js';

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
 *   issued for is `rejected` and logged as an alert. `held_for_screening` and `reversed` are W-deposit-06.
 */

export const CUSTODY_DEPOSIT_RAIL = 'crypto-native';

/** One transfer to a watched address, as the chain saw it. */
export interface ChainDeposit {
  readonly address: string;
  readonly txHash: string;
  readonly outputIndex: number;
  readonly assetId: string;
  readonly amount: Amount;
  readonly confirmations: number;
}

export type ChainDepositOutcome =
  | { readonly state: 'unmatched' }
  | { readonly state: 'recorded'; readonly status: PayCustodyDepositStatus; readonly reason: PayCustodyDepositReason | null };

export interface CustodyDepositBookDeps {
  readonly sql: Sql;
  readonly ledger: Pick<LedgerClient, 'post' | 'balance'>;
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
}

const COLUMNS =
  'id, user_id, asset_id, network_id, address, tx_hash, output_index, amount, confirmations, confirmations_required, minimum_deposit, status, reason, detected_at, credited_at, credit_started_at';
const ASSET_RE = /^[A-Za-z0-9]{1,16}$/;
const OPEN = new Set<PayCustodyDepositStatus>(PAY_CUSTODY_DEPOSIT_PENDING_STATUSES);

export class CustodyDepositBook {
  /** Keys of rows that can no longer change by a chain observation, so a poll does not read them again. */
  private readonly settled = new Map<string, ChainDepositOutcome>();

  constructor(private readonly deps: CustodyDepositBookDeps) {}

  /** Record (and, if it is due, credit) one transfer. `unmatched` means the address is not one issued to a customer. */
  async receive(input: ChainDeposit): Promise<ChainDepositOutcome> {
    const txHash = input.txHash.toLowerCase();
    const memoKey = `${input.address.toLowerCase()}:${txHash}:${input.outputIndex}:${input.assetId}:${input.amount}`;
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
    const judged = await this.settle(row);
    const outcome: ChainDepositOutcome = { state: 'recorded', status: judged.status, reason: judged.reason };
    if (!OPEN.has(judged.status)) this.settled.set(memoKey, outcome);
    return outcome;
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
    return sql.begin(async (tx) => {
      const inserted = await tx<Row[]>`
        INSERT INTO pay.custody_deposits (user_id, asset_id, network_id, address, tx_hash, output_index, amount, confirmations, status, reason)
        VALUES (${owner.user_id}, ${input.assetId}, ${owner.network_id}, ${owner.address}, ${input.txHash}, ${input.outputIndex},
                ${amount}, ${conf}, ${first}, ${unknownAsset ? 'unknown_asset' : null})
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
      if (conf <= existing.confirmations) return existing;
      const moved = await tx<Row[]>`
        UPDATE pay.custody_deposits SET confirmations = ${conf}, status = 'confirming', updated_at = now()
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

    return this.credit(row, required, minimum);
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
    const railRef = `${row.network_id}:${row.tx_hash}:${row.output_index}`;
    const tx = await postPayLedger(
      this.deps.ledger as LedgerClient,
      recipes.deposit({ userId: row.user_id, assetId: row.asset_id, amount, rail: CUSTODY_DEPOSIT_RAIL, railRef }),
    );
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
