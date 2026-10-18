import { founderChangeHash } from '@intafaced/contracts/founder-change-hash';
import { merchantControlChangeInputSchema } from '@intafaced/contracts';
import { describe, expect, it } from 'vitest';
import { controlConfigureInputSchema, tierDefinitionSchema } from './control/schemas.js';

// tooling/scripts/local-test-world.mjs (populate) defines and assigns the LOCAL TEST risk tiers through the two founders. The
// confirming founder must send the hash of the change they were shown, so populate keeps its own copy of the hasher and of the
// change targets. Compute both on the same inputs, and parse populate's tiers and requests with svc-pay's own schemas, so the next
// field svc-pay binds or requires turns this red instead of drifting.
const populatePath = '../../../tooling/scripts/local-test-world.mjs';

interface Populate {
  MERCHANT_TIERS: Array<{ assign: boolean; tier: Record<string, unknown> }>;
  tierChangeHash: (target: unknown, expectedVersion: string) => string;
  defineTierTarget: (tier: unknown) => unknown;
  assignTierTarget: (merchantId: string, tierId: string) => unknown;
  tierDefineRequestId: (tierId: string, expectedVersion: string) => string;
  tierAssignRequestId: (merchantId: string, tierId: string, expectedVersion: string) => string;
}

const merchantId = '44444444-4444-4444-8444-444444444444';

describe('populate tier changes match svc-pay', () => {
  it('hashes a tier definition and a tier assignment exactly as svc-pay does', async () => {
    const populate = (await import(/* @vite-ignore */ populatePath)) as Populate;
    for (const { tier } of populate.MERCHANT_TIERS) {
      for (const version of ['0', '1', '17']) {
        const target = populate.defineTierTarget(tier);
        expect(populate.tierChangeHash(target, version)).toBe(founderChangeHash(target, version));
        const assign = populate.assignTierTarget(merchantId, String(tier.id));
        expect(populate.tierChangeHash(assign, version)).toBe(founderChangeHash(assign, version));
      }
    }
  });

  it('sends changes svc-pay accepts, and the target it stores is the one populate hashed', async () => {
    const populate = (await import(/* @vite-ignore */ populatePath)) as Populate;
    for (const { tier } of populate.MERCHANT_TIERS) {
      const parsedTier = tierDefinitionSchema.parse(tier);
      const input = controlConfigureInputSchema.parse({
        requestId: populate.tierDefineRequestId(String(tier.id), '0'),
        change: { kind: 'upsert_tier', tier },
        reason: 'LOCAL TEST: define tier',
        expectedVersion: '0',
      });
      // founderAdmin.control.configure.submit stores { scope: 'tier', change: input.change }.
      expect(founderChangeHash({ scope: 'tier', change: input.change }, '0')).toBe(
        populate.tierChangeHash(populate.defineTierTarget(parsedTier), '0'),
      );
      const assign = merchantControlChangeInputSchema.parse({
        requestId: populate.tierAssignRequestId(merchantId, String(tier.id), '0'),
        merchantId,
        change: { kind: 'set_tier', tierId: tier.id, archetypeId: 'standard' },
        reason: 'LOCAL TEST: assign tier',
        expectedVersion: '0',
      });
      // founderAdmin.changes.submit stores { scope: 'merchant', merchantId, change: input.change }.
      expect(founderChangeHash({ scope: 'merchant', merchantId: assign.merchantId, change: assign.change }, '0')).toBe(
        populate.tierChangeHash(populate.assignTierTarget(merchantId, String(tier.id)), '0'),
      );
    }
  });

  it('keeps founder bars at or above approval bars, the rule svc-pay applies when a tier is defined', async () => {
    const populate = (await import(/* @vite-ignore */ populatePath)) as Populate;
    for (const { tier } of populate.MERCHANT_TIERS) {
      const parsed = tierDefinitionSchema.parse(tier);
      for (const f of parsed.founderThresholds) {
        const a = parsed.approvalThresholds.find((x) => x.assetCode === f.assetCode);
        expect(a).toBeDefined();
        expect(Number(f.amount)).toBeGreaterThanOrEqual(Number(a!.amount));
      }
    }
  });
});
