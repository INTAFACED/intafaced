import { founderChangeHash } from '@intafaced/contracts/founder-change-hash';
import { merchantControlChangeInputSchema } from '@intafaced/contracts';
import { SESSION_SCOPES, type Principal } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ControlService } from './control/service.js';
import { createPayNamespaces } from './namespaces/index.js';
import { controlConfigureInputSchema, tierDefinitionSchema } from './control/schemas.js';

// tooling/scripts/local-test-world.mjs (populate) defines and assigns the LOCAL TEST risk tiers through the two founders. The
// confirming founder must send the hash of the change they were shown, so populate keeps its own copy of the hasher and of the
// change targets. Compute both on the same inputs, and parse populate's tiers and requests with svc-pay's own schemas, so the next
// field svc-pay binds or requires turns this red instead of drifting.
const populatePath = new URL('../../../tooling/scripts/local-test-world.mjs', import.meta.url).href;

interface Populate {
  MERCHANT_TIERS: Array<{ assign: boolean; tier: Record<string, unknown> }>;
  tierChangeHash: (target: unknown, expectedVersion: string) => string;
  defineTierTarget: (tier: unknown) => unknown;
  assignTierTarget: (merchantId: string, tierId: string) => unknown;
  tierDefineRequestId: (tierId: string, expectedVersion: string) => string;
  tierAssignRequestId: (merchantId: string, tierId: string, expectedVersion: string) => string;
}

const merchantId = '44444444-4444-4444-8444-444444444444';
const MERCHANT_COUNT = 2;

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

  it('sends changes svc-pay accepts, and the target the router stores is the one populate hashed', async () => {
    const populate = (await import(/* @vite-ignore */ populatePath)) as Populate;
    // The real founderAdmin router with a stub control room that records the target it is asked to store.
    const userId = randomUUID();
    const principal: Principal = {
      userId,
      sub: userId,
      sid: randomUUID(),
      scopes: [...SESSION_SCOPES],
      mfa: true,
      tier: 'full',
      expiresAt: new Date(Date.now() + 60_000),
    };
    const ctx: Context = { principal, service: null, region: 'DE', requestId: randomUUID() };
    const targets: unknown[] = [];
    const submit = vi.fn(
      async (founderId: string, input: { requestId: string; target: { scope: string; merchantId?: string }; expectedVersion: string }) => {
        targets.push(input.target);
        return {
          requestId: input.requestId,
          scope: input.target.scope,
          scopeId: 'x',
          merchantId: input.target.merchantId ?? null,
          outcome: 'pending_second_approval',
          actorUserId: founderId,
          version: BigInt(input.expectedVersion),
          occurredAt: new Date(),
        };
      },
    );
    const control = {
      changes: { submit },
      profile: async (id: string) => ({
        merchantId: id,
        tierId: null,
        archetypeId: null,
        caps: null,
        pricing: null,
        reserve: null,
        version: '0',
        updatedAt: null,
      }),
    } as unknown as ControlService;
    const caller = createPayNamespaces({ founderAuthority: async () => userId, control }).createCaller(ctx) as unknown as {
      founderAdmin: {
        control: { configure: { submit: (input: unknown) => Promise<unknown> } };
        changes: { submit: (input: unknown) => Promise<unknown> };
      };
    };

    for (const { tier } of populate.MERCHANT_TIERS) {
      // Exactly the inputs populate sends: the raw tier, not a parsed copy.
      await caller.founderAdmin.control.configure.submit({
        requestId: populate.tierDefineRequestId(String(tier.id), '0'),
        change: { kind: 'upsert_tier', tier },
        reason: 'LOCAL TEST: define tier',
        expectedVersion: '0',
      });
      expect(tierDefinitionSchema.parse(tier)).toBeDefined();
      expect(
        controlConfigureInputSchema.parse({
          requestId: randomUUID(),
          change: { kind: 'upsert_tier', tier },
          reason: 'LOCAL TEST',
          expectedVersion: '0',
        }),
      ).toBeDefined();
      expect(founderChangeHash(targets.at(-1), '0')).toBe(populate.tierChangeHash(populate.defineTierTarget(tier), '0'));

      await caller.founderAdmin.changes.submit({
        requestId: populate.tierAssignRequestId(merchantId, String(tier.id), '0'),
        merchantId,
        change: { kind: 'set_tier', tierId: tier.id, archetypeId: 'standard' },
        reason: 'LOCAL TEST: assign tier',
        expectedVersion: '0',
      });
      expect(
        merchantControlChangeInputSchema.safeParse({
          requestId: randomUUID(),
          merchantId,
          change: { kind: 'set_tier', tierId: tier.id, archetypeId: 'standard' },
          reason: 'LOCAL TEST',
          expectedVersion: '0',
        }).success,
      ).toBe(true);
      expect(founderChangeHash(targets.at(-1), '0')).toBe(
        populate.tierChangeHash(populate.assignTierTarget(merchantId, String(tier.id)), '0'),
      );
    }
    expect(submit).toHaveBeenCalledTimes(MERCHANT_COUNT * 2);
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
