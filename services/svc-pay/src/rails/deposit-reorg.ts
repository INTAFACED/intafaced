import { recipes, type Amount, type LedgerClient } from '@intafaced/ledger-client';

/**
 * WAL-0070. A deposit credited from block hash H stops being spendable when
 * the node reports a different hash at that height.
 *
 * The credit itself is `recipes.deposit`. This module posts the compensating
 * row, once per deposit id: available loses the amount, and the rail boundary
 * loses the custody obligation.
 */

export interface ChainHeightHash {
  /** Hash the node currently reports at this height, or null when it has none. */
  hashAt(height: string): Promise<string | null>;
}

export interface CreditedDepositBlock {
  readonly depositId: string;
  readonly userId: string;
  readonly assetId: string;
  readonly amount: Amount;
  readonly rail: string;
  readonly railRef: string;
  /** Decimal block height the credit was read from. Not a number. */
  readonly height: string;
  /** Block hash recorded when the deposit was credited. */
  readonly blockHash: string;
}

export interface DepositReorgPost {
  readonly depositId: string;
  readonly txId: string;
}

function sameHash(recorded: string, reported: string): boolean {
  return recorded.trim().toLowerCase() === reported.trim().toLowerCase();
}

/**
 * Notes credits that name a block, then reverses one when that block is rewritten.
 */
export class DepositBlockReorg {
  private readonly credits = new Map<string, CreditedDepositBlock>();
  private readonly reversed = new Set<string>();

  constructor(
    private readonly chain: ChainHeightHash,
    private readonly ledger: LedgerClient,
  ) {}

  /** Remember a credit. The same terms again are a no-op. Different terms throw. */
  note(credit: CreditedDepositBlock): void {
    const depositId = credit.depositId.trim();
    if (!depositId) throw new Error('deposit id is required');
    const existing = this.credits.get(depositId);
    if (existing) {
      const same =
        existing.userId === credit.userId &&
        existing.assetId === credit.assetId &&
        existing.amount === credit.amount &&
        existing.rail === credit.rail &&
        existing.railRef === credit.railRef &&
        existing.height === credit.height &&
        sameHash(existing.blockHash, credit.blockHash);
      if (!same) throw new Error(`deposit ${depositId} was already noted with different terms`);
      return;
    }
    this.credits.set(depositId, { ...credit, depositId });
  }

  /**
   * Ask the node for each noted height. A different hash posts one reversing
   * entry. The same hash, or no hash, posts nothing. A deposit already reversed
   * is skipped.
   */
  async observe(): Promise<readonly DepositReorgPost[]> {
    const posted: DepositReorgPost[] = [];
    for (const credit of this.credits.values()) {
      if (this.reversed.has(credit.depositId)) continue;
      const reported = await this.chain.hashAt(credit.height);
      if (reported == null) continue;
      const next = reported.trim();
      if (next.length === 0 || sameHash(credit.blockHash, next)) continue;
      const tx = await this.ledger.post(
        recipes.depositReverse({
          depositId: credit.depositId,
          userId: credit.userId,
          assetId: credit.assetId,
          amount: credit.amount,
          rail: credit.rail,
          railRef: credit.railRef,
        }),
      );
      this.reversed.add(credit.depositId);
      posted.push({ depositId: credit.depositId, txId: tx.id });
    }
    return posted;
  }
}
