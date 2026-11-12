/**
 * Test-only (kept under test/, which the ledger caller-binding scan skips): what a router-level follow needs to pass the Start copying gate (follow-gate.ts), for tests whose subject
 * is something after the follow. The owner values here are TEST content for unit tests, never a default.
 */

import { MemoryLedger, parseAmount, recipes, type AccountRef, type Balance } from '@intafaced/ledger-client';
import type { CopyTier } from '../follow-gate.js';
import type { CopyMinInvestment } from '../follow-rules.js';

/** CopyService options that open the gate: a TEST copy tier and a TEST minimum investment of 1 USDT. */
export const OPEN_FOLLOW_GATE: { readonly minTier: CopyTier; readonly minInvestment: CopyMinInvestment } = {
  minTier: 'basic',
  minInvestment: { published: true, amount: parseAmount('1') },
};

/** A ledger that funds a user's USDT through the real deposit recipe the first time their balance is read. */
export class GateOpenLedger extends MemoryLedger {
  private readonly funded = new Set<string>();

  override async balances(ownerType: AccountRef['ownerType'], ownerId: string): Promise<Balance[]> {
    if (ownerType === 'user' && !this.funded.has(ownerId)) {
      this.funded.add(ownerId);
      await this.post(
        recipes.deposit({ userId: ownerId, assetId: 'USDT', amount: parseAmount('1000000'), rail: 'test', railRef: `gate-${ownerId}` }),
      );
    }
    return super.balances(ownerType, ownerId);
  }
}
