import { describe, expect, it } from 'vitest';
import { assetIdSchema, type AssetId } from './asset-id.js';
import type { WithdrawalAllowanceInput } from './withdrawal-allowance.js';

// `tsc -p tsconfig.json` compiles this file: if the brand is dropped, each
// `@ts-expect-error` below has nothing to expect and the typecheck fails.
describe('asset ids are their own type', () => {
  it('an account or user id passed where an asset id is wanted does not compile', () => {
    const accountId: string = '7d1f1f8e-5b0e-4a5e-9a51-2a3f0c9d8b11';
    const userId: string = 'b2c7d3e4-0f1a-4b5c-8d9e-1f2a3b4c5d6e';
    const take = (assetId: AssetId): AssetId => assetId;

    // @ts-expect-error an account id is not an asset id
    take(accountId);
    // @ts-expect-error a user id swapped into the asset field does not compile
    const swapped: WithdrawalAllowanceInput = { userId, assetId: userId };

    const allowed: WithdrawalAllowanceInput = { userId, assetId: assetIdSchema.parse('USDC') };
    expect(take(allowed.assetId)).toBe('USDC');
    expect(swapped.userId).toBe(userId);
  });

  it('the brand changes no runtime behaviour: it accepts what a string accepts', () => {
    expect(assetIdSchema.parse('USDC')).toBe('USDC');
    expect(assetIdSchema.safeParse(42).success).toBe(false);
  });
});
