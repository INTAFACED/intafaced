import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import type { WalletAttempt, WalletInbound, WalletStore, WalletWithdrawal } from './wallet-pay.js';

interface WithdrawalSqlRow {
  id: string;
  user_id: string;
  asset_id: string;
  network: string;
  amount: string;
  fee: string | null;
  client_ref: string;
  destination_ref: string;
  status: WalletWithdrawal['status'];
  hold_amount: string;
  recipient: Record<string, string>;
  attempts: WalletAttempt[];
  reversed: boolean;
}

interface InboundSqlRow {
  id: string;
  user_id: string;
  asset_id: string;
  network: string;
  amount: string;
  rail_ref: string;
  acceptance_address: string | null;
  status: WalletInbound['status'];
  reason: string | null;
}

/** Durable wallet rows. The ledger remains the balance. */
export class PostgresWalletStore implements WalletStore {
  constructor(private readonly sql: Sql) {}

  async getWithdrawal(id: string): Promise<WalletWithdrawal | null> {
    const rows = await this.sql<WithdrawalSqlRow[]>`
      SELECT id, user_id, asset_id, network, amount, fee, client_ref, destination_ref, status, hold_amount, recipient, attempts, reversed
        FROM pay.wallet_withdrawals WHERE id = ${id}
    `;
    return rows[0] ? toWithdrawal(rows[0]) : null;
  }

  async getWithdrawalByClient(userId: string, clientRef: string): Promise<WalletWithdrawal | null> {
    const rows = await this.sql<WithdrawalSqlRow[]>`
      SELECT id, user_id, asset_id, network, amount, fee, client_ref, destination_ref, status, hold_amount, recipient, attempts, reversed
        FROM pay.wallet_withdrawals WHERE user_id = ${userId} AND client_ref = ${clientRef}
    `;
    return rows[0] ? toWithdrawal(rows[0]) : null;
  }

  async saveWithdrawal(row: WalletWithdrawal): Promise<void> {
    await this.sql`
      INSERT INTO pay.wallet_withdrawals (
        id, user_id, asset_id, network, amount, fee, client_ref, destination_ref, status, hold_amount, recipient, attempts, reversed
      ) VALUES (
        ${row.id}, ${row.userId}, ${row.assetId}, ${row.network},
        ${formatAmount(row.amount)}::numeric, ${row.fee === null ? null : formatAmount(row.fee)}::numeric,
        ${row.clientRef}, ${row.destinationRef}, ${row.status}, ${formatAmount(row.holdAmount)}::numeric,
        ${this.sql.json(row.recipient as never)}, ${this.sql.json(row.attempts as never)}, ${row.reversed}
      )
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        fee = EXCLUDED.fee,
        hold_amount = EXCLUDED.hold_amount,
        recipient = EXCLUDED.recipient,
        attempts = EXCLUDED.attempts,
        reversed = EXCLUDED.reversed,
        destination_ref = EXCLUDED.destination_ref
    `;
  }

  async listWithdrawals(userId: string, assetId: string): Promise<WalletWithdrawal[]> {
    const rows = await this.sql<WithdrawalSqlRow[]>`
      SELECT id, user_id, asset_id, network, amount, fee, client_ref, destination_ref, status, hold_amount, recipient, attempts, reversed
        FROM pay.wallet_withdrawals WHERE user_id = ${userId} AND asset_id = ${assetId}
    `;
    return rows.map(toWithdrawal);
  }

  async getInbound(railRef: string): Promise<WalletInbound | null> {
    const rows = await this.sql<InboundSqlRow[]>`
      SELECT id, user_id, asset_id, network, amount, rail_ref, acceptance_address, status, reason
        FROM pay.wallet_inbounds WHERE rail_ref = ${railRef}
    `;
    return rows[0] ? toInbound(rows[0]) : null;
  }

  async saveInbound(row: WalletInbound): Promise<void> {
    await this.sql`
      INSERT INTO pay.wallet_inbounds (
        id, user_id, asset_id, network, amount, rail_ref, acceptance_address, status, reason
      ) VALUES (
        ${row.id}, ${row.userId}, ${row.assetId}, ${row.network}, ${formatAmount(row.amount)}::numeric,
        ${row.railRef}, ${row.acceptanceAddress}, ${row.status}, ${row.reason}
      )
      ON CONFLICT (rail_ref) DO UPDATE SET
        status = EXCLUDED.status,
        reason = EXCLUDED.reason,
        acceptance_address = EXCLUDED.acceptance_address,
        amount = EXCLUDED.amount
    `;
  }

  async listInbounds(): Promise<WalletInbound[]> {
    const rows = await this.sql<InboundSqlRow[]>`
      SELECT id, user_id, asset_id, network, amount, rail_ref, acceptance_address, status, reason
        FROM pay.wallet_inbounds
    `;
    return rows.map(toInbound);
  }
}

function money(value: string): Amount {
  return parseAmount(value);
}

function toWithdrawal(row: WithdrawalSqlRow): WalletWithdrawal {
  return {
    id: row.id,
    userId: row.user_id,
    assetId: row.asset_id,
    network: row.network,
    amount: money(row.amount),
    fee: row.fee === null ? null : money(row.fee),
    clientRef: row.client_ref,
    destinationRef: row.destination_ref,
    status: row.status,
    holdAmount: money(row.hold_amount),
    recipient: row.recipient ?? {},
    attempts: row.attempts ?? [],
    reversed: row.reversed,
  };
}

function toInbound(row: InboundSqlRow): WalletInbound {
  return {
    id: row.id,
    userId: row.user_id,
    assetId: row.asset_id,
    network: row.network,
    amount: money(row.amount),
    railRef: row.rail_ref,
    acceptanceAddress: row.acceptance_address,
    status: row.status,
    reason: row.reason,
  };
}
