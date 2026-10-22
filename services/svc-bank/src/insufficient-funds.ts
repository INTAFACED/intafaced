import { InsufficientFundsError, LedgerError, add, formatAmount, parseAmount, type LedgerClient } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { BankError } from './errors.js';

/**
 * RC-wallet-09: the figures behind a refused spend, so the customer is told
 * what they have, what is held and what sits in Earn, instead of a bare
 * "Insufficient balance.".
 *
 * Reads only, and only the caller's own user book and earn rows. Every figure
 * is a decimal string; bigint in memory. A failed read is NEVER a zero:
 *   · the balance read fails -> no figures at all (plain refusal);
 *   · the earn read fails    -> `inEarn: null`, the other two still shown.
 */
export interface SpendFigures {
  readonly assetId: string;
  readonly available: string;
  readonly onHold: string;
  /** null when the earn read failed: unknown, not zero. */
  readonly inEarn: string | null;
}

export class BankInsufficientFundsError extends BankError {
  constructor(
    message: string,
    /** null when the balance read failed: the refusal carries no figures. */
    readonly figures: SpendFigures | null,
    override readonly cause?: unknown,
  ) {
    super(message, 'bank.insufficient_funds');
    this.name = 'BankInsufficientFundsError';
  }

  /** Read by the tRPC error formatter (`spendFiguresOf`). Absent when the balance read failed. */
  get data(): SpendFigures | undefined {
    return this.figures ?? undefined;
  }
}

export function isLedgerInsufficientFunds(err: unknown): boolean {
  return err instanceof InsufficientFundsError || (err instanceof LedgerError && err.code === 'ledger.insufficient_funds');
}

export class SpendFiguresReader {
  constructor(
    private readonly sql: Sql,
    private readonly ledger: Pick<LedgerClient, 'balances'>,
  ) {}

  async read(userId: string, assetId: string): Promise<SpendFigures | null> {
    let available = 0n;
    let onHold = 0n;
    try {
      for (const row of await this.ledger.balances('user', userId)) {
        if (row.account.assetId !== assetId) continue;
        if (row.account.kind === 'available') available = add(available, row.amount);
        else if (row.account.kind === 'hold') onHold = add(onHold, row.amount);
      }
    } catch {
      return null;
    }
    let inEarn: string | null;
    try {
      const rows = await this.sql<{ principal: string }[]>`
        SELECT principal::text AS principal FROM bank.earn_positions
         WHERE user_id = ${userId} AND asset_id = ${assetId} AND status = 'active'
      `;
      let total = 0n;
      for (const r of rows) total = add(total, parseAmount(r.principal));
      inEarn = formatAmount(total);
    } catch {
      inEarn = null;
    }
    return { assetId, available: formatAmount(available), onHold: formatAmount(onHold), inEarn };
  }

  /**
   * Turn a ledger insufficient-funds refusal from a spend door into
   * `bank.insufficient_funds` with the caller's figures. Any other error is
   * returned unchanged.
   */
  async refusal(err: unknown, userId: string, assetId: string): Promise<unknown> {
    if (!isLedgerInsufficientFunds(err)) return err;
    const figures = await this.read(userId, assetId);
    return new BankInsufficientFundsError(`Insufficient ${assetId}.`, figures, err);
  }
}
