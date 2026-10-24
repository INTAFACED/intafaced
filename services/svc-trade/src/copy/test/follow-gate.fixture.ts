/**
 * Test-only (kept under test/, which the ledger caller-binding scan skips): what a router-level follow needs to pass the Start copying gate (follow-gate.ts), for tests whose subject
 * is something after the follow. The owner values here are TEST content for unit tests, never a default.
 */

import { MemoryLedger, parseAmount, recipes, type AccountRef, type Balance } from '@intafaced/ledger-client';
import type { CopyDisclosureLaw } from '../disclosure.js';
import type { CopyTier } from '../follow-gate.js';
import { MemoryCopyFollowStore, type CopyDisclosureAcceptance } from '../follow-store.js';

const TEST_VERSION = 'TEST-gate-v1';

/** CopyService options that open the gate: a TEST copy tier and a TEST disclosure. */
export const OPEN_FOLLOW_GATE: { readonly minTier: CopyTier; readonly disclosureLaw: CopyDisclosureLaw } = {
  minTier: 'basic',
  disclosureLaw: { published: true, version: TEST_VERSION, text: 'TEST disclosure.' },
};

/** A store in which every follower has accepted the TEST disclosure. */
export class GateOpenStore extends MemoryCopyFollowStore {
  override async getDisclosureAcceptance(followerId: string, version: string): Promise<CopyDisclosureAcceptance | null> {
    const stored = await super.getDisclosureAcceptance(followerId, version);
    if (stored || version !== TEST_VERSION) return stored;
    return { followerId, version, acceptedAt: new Date(0), clientAcceptId: 'test-gate' };
  }
}

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
