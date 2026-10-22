import { LedgerError, recipes, type Amount, type LedgerClient, type LedgerTx } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';

/**
 * HOLDS ON RECEIVED FUNDS: the svc-bank caller of `payReceivedHold`,
 * `payReceivedRelease` and `payReceivedReturn` (PP-money-balance-05, pay
 * ENGINE-SPEC RH-1 to RH-4). This is the smallest slice: the ledger calls,
 * driven by a stored hold row. The rule table, the procedures, four-eyes, the
 * sweeper and the hold queue come later.
 *
 * THE AMOUNT ALWAYS COMES FROM THE STORED HOLD ROW. `release` and `return` take
 * only a hold id; the amount, the recipient, the asset and the payer are read
 * from the row svc-bank wrote when the hold was placed, and `heldAmount` is that
 * same stored amount. A caller can therefore never release or return part of a
 * hold, or a different amount, which is what makes RH-2 (one outcome per hold)
 * hold end to end.
 *
 * FAILS CLOSED UNTIL THE LEDGER GRANT EXISTS. svc-ledger refuses an ungranted
 * caller (`ledger.caller_forbidden`); that surfaces as
 * `bank.received_hold_not_granted` and the stored row is left as it was, so no
 * hold is shown as placed, released or returned when the ledger did not post.
 */

/**
 * `placing`, `releasing` and `returning` are claims: the row moves into one with a conditional state write BEFORE the
 * ledger post, so two callers can never both post an outcome. A retry may only finish the step already claimed.
 */
export type ReceivedHoldState = 'pending' | 'placing' | 'held' | 'releasing' | 'released' | 'returning' | 'returned';

export interface ReceivedHoldRow {
  readonly holdId: string;
  readonly recipientUserId: string;
  readonly payerUserId: string;
  readonly assetId: string;
  /** Scaled bigint, the amount the hold was placed for. */
  readonly amount: Amount;
  readonly state: ReceivedHoldState;
}

/** Where hold rows live. The Postgres table is left for later; tests use the in-memory store. */
export interface ReceivedHoldStore {
  get(holdId: string): Promise<ReceivedHoldRow | null>;
  setState(holdId: string, from: ReceivedHoldState, to: ReceivedHoldState): Promise<boolean>;
}

const FORBIDDEN = new Set(['ledger.caller_forbidden', 'ledger.caller_unbound']);

export class ReceivedHoldService {
  constructor(
    private readonly ledger: LedgerClient,
    private readonly store: ReceivedHoldStore,
  ) {}

  async place(holdId: string): Promise<LedgerTx> {
    const row = await this.claim(holdId, 'pending', 'placing');
    return this.finish(
      row,
      'pending',
      'placing',
      'held',
      recipes.payReceivedHold({ holdId: row.holdId, userId: row.recipientUserId, assetId: row.assetId, amount: row.amount }),
    );
  }

  async release(holdId: string): Promise<LedgerTx> {
    const row = await this.claim(holdId, 'held', 'releasing');
    return this.finish(
      row,
      'held',
      'releasing',
      'released',
      recipes.payReceivedRelease({
        holdId: row.holdId,
        userId: row.recipientUserId,
        assetId: row.assetId,
        amount: row.amount,
        heldAmount: row.amount,
      }),
    );
  }

  async return(holdId: string): Promise<LedgerTx> {
    const row = await this.claim(holdId, 'held', 'returning');
    return this.finish(
      row,
      'held',
      'returning',
      'returned',
      recipes.payReceivedReturn({
        holdId: row.holdId,
        userId: row.recipientUserId,
        payerUserId: row.payerUserId,
        assetId: row.assetId,
        amount: row.amount,
        heldAmount: row.amount,
      }),
    );
  }

  /**
   * Claim the step before any post. From `from`, the conditional move to `claimed` must win; a lost move (another
   * caller claimed first) refuses. A row already in `claimed` is a retry of this same step and may finish it; any
   * other state (including the other outcome's claim) refuses.
   */
  private async claim(holdId: string, from: ReceivedHoldState, claimed: ReceivedHoldState): Promise<ReceivedHoldRow> {
    const row = await this.row(holdId);
    if (row.state === claimed) return row;
    if (row.state !== from || !(await this.store.setState(row.holdId, from, claimed))) {
      throw new BankError(
        'The hold already has its outcome, another one is in progress, or it was never placed',
        'bank.received_hold_state',
      );
    }
    return { ...row, state: claimed };
  }

  /**
   * Post under the claim, then settle it. A typed ledger refusal means nothing posted, so the claim is handed back
   * (`claimed` -> `from`). Any other failure leaves the claim: the outcome is unknown and only this step may retry,
   * under the same recipe key, which the ledger collapses.
   */
  private async finish(
    row: ReceivedHoldRow,
    from: ReceivedHoldState,
    claimed: ReceivedHoldState,
    done: ReceivedHoldState,
    request: Parameters<LedgerClient['post']>[0],
  ): Promise<LedgerTx> {
    let tx: LedgerTx;
    try {
      tx = await this.post(request);
    } catch (err) {
      if (err instanceof LedgerError || (err instanceof BankError && err.code === 'bank.received_hold_not_granted')) {
        await this.store.setState(row.holdId, claimed, from);
      }
      throw err;
    }
    if (!(await this.store.setState(row.holdId, claimed, done))) {
      throw new BankError('The hold moved while its step was posting', 'bank.received_hold_state');
    }
    return tx;
  }

  private async row(holdId: string): Promise<ReceivedHoldRow> {
    if (typeof holdId !== 'string' || holdId.trim() === '') throw new BankError('A hold id is required', 'bank.received_hold_not_found');
    const row = await this.store.get(holdId.trim());
    if (!row) throw new BankError('No such hold', 'bank.received_hold_not_found');
    return row;
  }

  private async post(request: Parameters<LedgerClient['post']>[0]): Promise<LedgerTx> {
    try {
      return await this.ledger.post(request);
    } catch (err) {
      if (err instanceof LedgerError && FORBIDDEN.has(err.code)) {
        throw new BankError('The ledger has not granted holds on received funds to this service yet', 'bank.received_hold_not_granted');
      }
      throw err;
    }
  }
}

/** In-memory store, for tests and until the table lands. */
export function memoryReceivedHoldStore(rows: ReceivedHoldRow[]): ReceivedHoldStore & { rows: ReceivedHoldRow[] } {
  return {
    rows,
    async get(holdId) {
      return rows.find((r) => r.holdId === holdId) ?? null;
    },
    async setState(holdId, from, to) {
      const i = rows.findIndex((r) => r.holdId === holdId && r.state === from);
      if (i < 0) return false;
      rows[i] = { ...rows[i]!, state: to };
      return true;
    },
  };
}
