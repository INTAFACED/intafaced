import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { founderChangeHash } from '@intafaced/contracts/founder-change-hash';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger } from '@intafaced/ledger-client';
import { PayService } from '../payment-service.js';
import { RailRegistry } from '../rails/registry.js';
import { ChangeService } from './changes.js';
import { ControlService } from './service.js';
import { ownerAccessPorts } from './access.js';
import {
  applyChange,
  FOUNDER_1,
  FOUNDER_2,
  migrations,
  openAdmin,
  OWNER_A,
  OWNER_B,
  resetControl,
  TEST_GLOBAL_RULE,
  TEST_TIER,
} from './control.testkit.js';

/** Dual-control configuration changes. TEST VALUES throughout. */
describe('dual-control configuration changes', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let sql!: TestDatabase['sql'];
  let changes!: ChangeService;
  let merchantId = '';

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
    changes = new ChangeService(sql);
  }, 120_000);

  beforeEach(async () => {
    await resetControl(sql);
    const pay = new PayService(sql, new MemoryLedger(), new RailRegistry([]), {});
    merchantId = (await pay.createMerchant({ userId: OWNER_A, pricing: { feeBps: 0 } })).id;
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  const audit = (scopeId: string) =>
    sql<Array<{ kind: string; outcome: string; actor_id: string; second_actor_id: string | null }>>`
      SELECT kind, outcome, actor_id, second_actor_id FROM pay.control_audit WHERE scope_id = ${scopeId} ORDER BY seq`;
  const hashOf = (target: Parameters<typeof founderChangeHash>[0], version: string) => founderChangeHash(target, version);
  const tierTarget = { scope: 'tier', change: { kind: 'upsert_tier', tier: TEST_TIER } } as const;

  it('nothing takes effect until a DIFFERENT founder confirms; both founders are on the audit row', async () => {
    const requestId = randomUUID();
    const submitted = await changes.submit(FOUNDER_1, {
      requestId,
      target: tierTarget,
      reason: 'create the test tier',
      expectedVersion: '0',
    });
    expect(submitted.outcome).toBe('pending_second_approval');
    expect((await sql`SELECT 1 FROM pay.control_tiers`).length).toBe(0);

    await expect(
      changes.confirm(FOUNDER_1, { requestId, decision: 'confirm', reason: 'self confirm', expectedChangeHash: hashOf(tierTarget, '0') }),
    ).rejects.toMatchObject({
      code: 'pay.dual_control_required',
    });
    expect((await sql`SELECT 1 FROM pay.control_tiers`).length).toBe(0);

    const done = await changes.confirm(FOUNDER_2, {
      requestId,
      decision: 'confirm',
      reason: 'looks right',
      expectedChangeHash: hashOf(tierTarget, '0'),
    });
    expect(done.outcome).toBe('changed');
    expect((await sql`SELECT version FROM pay.control_tiers WHERE id = ${TEST_TIER.id}`)[0]!.version).toBe('1');
    expect(await audit(TEST_TIER.id)).toEqual([
      { kind: 'control.change_submitted', outcome: 'pending_second_approval', actor_id: FOUNDER_1, second_actor_id: null },
      { kind: 'control.change_decided', outcome: 'changed', actor_id: FOUNDER_1, second_actor_id: FOUNDER_2 },
    ]);
    // A second confirm of a decided request is not applied twice.
    await expect(
      changes.confirm(FOUNDER_1, { requestId, decision: 'confirm', reason: 'again', expectedChangeHash: hashOf(tierTarget, '0') }),
    ).rejects.toMatchObject({
      code: 'pay.change_not_pending',
    });
  });

  it('a rejected change never applies; reusing a request id for something else is refused', async () => {
    const requestId = randomUUID();
    await changes.submit(FOUNDER_1, { requestId, target: tierTarget, reason: 'try', expectedVersion: '0' });
    expect(
      (
        await changes.confirm(FOUNDER_2, {
          requestId,
          decision: 'reject',
          reason: 'not agreed',
          expectedChangeHash: hashOf(tierTarget, '0'),
        })
      ).outcome,
    ).toBe('refused');
    expect((await sql`SELECT 1 FROM pay.control_tiers`).length).toBe(0);
    const other = { ...tierTarget, change: { kind: 'upsert_tier', tier: { ...TEST_TIER, name: 'other' } } } as const;
    await expect(changes.submit(FOUNDER_1, { requestId, target: other, reason: 'sneaky', expectedVersion: '0' })).rejects.toMatchObject({
      code: 'pay.request_id_reused',
    });
  });

  it('a stale version is a conflict at submit and at confirm, and is audited', async () => {
    await applyChange(changes, sql, tierTarget);
    const stale = await changes.submit(FOUNDER_1, {
      requestId: randomUUID(),
      target: { ...tierTarget, change: { kind: 'upsert_tier', tier: { ...TEST_TIER, name: 'v2' } } },
      reason: 'rename',
      expectedVersion: '0',
    });
    expect(stale.outcome).toBe('conflict');

    const a = randomUUID();
    const b = randomUUID();
    const rename = (name: string) => ({ ...tierTarget, change: { kind: 'upsert_tier', tier: { ...TEST_TIER, name } } }) as const;
    await changes.submit(FOUNDER_1, { requestId: a, target: rename('first'), reason: 'a', expectedVersion: '1' });
    await changes.submit(FOUNDER_1, { requestId: b, target: rename('second'), reason: 'b', expectedVersion: '1' });
    expect(
      (
        await changes.confirm(FOUNDER_2, {
          requestId: a,
          decision: 'confirm',
          reason: 'ok',
          expectedChangeHash: hashOf(rename('first'), '1'),
        })
      ).outcome,
    ).toBe('changed');
    expect(
      (
        await changes.confirm(FOUNDER_2, {
          requestId: b,
          decision: 'confirm',
          reason: 'ok',
          expectedChangeHash: hashOf(rename('second'), '1'),
        })
      ).outcome,
    ).toBe('conflict');
    expect((await sql`SELECT name FROM pay.control_tiers`)[0]!.name).toBe('first');
    expect((await audit(TEST_TIER.id)).map((r) => r.outcome)).toContain('conflict');
  });

  it('invalid and no-op changes are audited and never claim a change', async () => {
    const bad = await changes.submit(FOUNDER_1, {
      requestId: randomUUID(),
      target: {
        scope: 'pricing',
        change: {
          kind: 'set_pricing_layer',
          layer: 'global',
          scopeId: null,
          rules: [{ ...TEST_GLOBAL_RULE, bands: [{ fromAmount: '5', feeBps: 1, flatFee: null }] }],
        },
      },
      reason: 'first band does not start at zero',
      expectedVersion: '0',
    });
    expect(bad.outcome).toBe('refused');
    const lowFounder = await changes.submit(FOUNDER_1, {
      requestId: randomUUID(),
      target: {
        scope: 'tier',
        change: { kind: 'upsert_tier', tier: { ...TEST_TIER, founderThresholds: [{ assetCode: 'USDT', amount: '10' }] } },
      },
      reason: 'founder threshold below approval threshold',
      expectedVersion: '0',
    });
    expect(lowFounder.outcome).toBe('refused');
    const unknownTier = await changes.submit(FOUNDER_1, {
      requestId: randomUUID(),
      target: { scope: 'merchant', merchantId, change: { kind: 'set_tier', tierId: 'nope', archetypeId: null } },
      reason: 'no such tier',
      expectedVersion: '0',
    });
    expect(unknownTier.outcome).toBe('refused');
    await applyChange(changes, sql, tierTarget);
    expect(
      (await changes.submit(FOUNDER_1, { requestId: randomUUID(), target: tierTarget, reason: 'same again', expectedVersion: '1' }))
        .outcome,
    ).toBe('noop');
    expect((await sql`SELECT 1 FROM pay.control_changes WHERE status = 'pending'`).length).toBe(0);
    const outcomes = (await audit(merchantId)).map((r) => r.outcome);
    expect(outcomes).toEqual(['refused']);
  });

  it('a merchant profile reflects tier, caps override, reserve override and pricing; versions move once per change; unconfigured sections are null', async () => {
    const control = new ControlService(sql, ownerAccessPorts(sql));
    const empty = await control.profile(merchantId);
    expect(empty).toMatchObject({ tierId: null, caps: null, pricing: null, reserve: null, version: '0' });

    await applyChange(changes, sql, tierTarget);
    await applyChange(changes, sql, {
      scope: 'pricing',
      change: { kind: 'set_pricing_layer', layer: 'global', scopeId: null, rules: [TEST_GLOBAL_RULE] },
    });
    await applyChange(changes, sql, {
      scope: 'merchant',
      merchantId,
      change: { kind: 'set_tier', tierId: TEST_TIER.id, archetypeId: 'broker' },
    });
    await applyChange(changes, sql, {
      scope: 'merchant',
      merchantId,
      change: { kind: 'set_reserve', reserve: { rollingReserveBps: null, holdDays: null } },
    });
    await applyChange(changes, sql, {
      scope: 'merchant',
      merchantId,
      change: { kind: 'set_caps', caps: [{ kind: 'per_payment', assetCode: 'USDT', limit: '7' }] },
    });
    const p = await control.profile(merchantId);
    expect(p.tierId).toBe(TEST_TIER.id);
    expect(p.archetypeId).toBe('broker');
    expect(p.version).toBe('3');
    // Explicit "no reserve" on the merchant beats the tier's reserve.
    expect(p.reserve).toEqual({ rollingReserveBps: null, holdDays: null });
    expect(p.caps).toContainEqual({ kind: 'per_payment', assetCode: 'USDT', limit: '7' });
    expect(p.caps).toContainEqual({ kind: 'daily_intake', assetCode: 'USDT', limit: '300' });
    expect(p.pricing).toHaveLength(1);
    expect(p.pricing![0]!.layer).toBe('global');

    // Same engine as the live path: 100 USDT with a conversion = 2.5 + 0.3 fee, 0.4 spread, net 96.8 (hand-computed).
    const quote = await control.previewPricing({ merchantId, assetCode: 'USDT', amount: '100', conversion: true });
    expect(quote).toMatchObject({ fee: '2.8', spread: '0.4', net: '96.8', roundingMode: 'ceil', appliedLayer: 'global' });
    await expect(control.previewPricing({ merchantId, assetCode: 'USD', amount: '1' })).rejects.toMatchObject({
      code: 'pay.pricing_unconfigured',
    });
  });

  it('set_caps with no tier is refused with pay.tier_unassigned: it would change nothing, so it never records "changed"', async () => {
    const caps = { kind: 'set_caps' as const, caps: [{ kind: 'per_payment' as const, assetCode: 'USDT', limit: '7' }] };
    const requestId = randomUUID();
    await expect(
      changes.submit(FOUNDER_1, {
        requestId,
        target: { scope: 'merchant', merchantId, change: caps },
        reason: 'caps first',
        expectedVersion: '0',
      }),
    ).rejects.toMatchObject({ code: 'pay.tier_unassigned' });
    expect((await sql`SELECT 1 FROM pay.control_changes WHERE request_id = ${requestId}`).length).toBe(0);
    expect((await sql`SELECT 1 FROM pay.control_merchant_profiles WHERE merchant_id = ${merchantId}`).length).toBe(0);
    // Once the merchant has a tier the same change goes through, and the override merges per kind over the tier's caps.
    await applyChange(changes, sql, tierTarget);
    await applyChange(changes, sql, {
      scope: 'merchant',
      merchantId,
      change: { kind: 'set_tier', tierId: TEST_TIER.id, archetypeId: null },
    });
    await applyChange(changes, sql, { scope: 'merchant', merchantId, change: caps });
    const profile = await new ControlService(sql, ownerAccessPorts(sql)).profile(merchantId);
    expect(profile.caps).toContainEqual({ kind: 'per_payment', assetCode: 'USDT', limit: '7' });
    expect(profile.caps).toContainEqual({ kind: 'daily_intake', assetCode: 'USDT', limit: '300' });
  });

  describe('a confirm only applies the change its confirmer was shown (expectedChangeHash)', () => {
    let otherMerchantId = '';
    const rule = (assetCode: string, feeBps: number) => ({
      layer: 'merchant' as const,
      scopeId: '',
      assetCode,
      bands: [{ fromAmount: '0', feeBps, flatFee: null }],
      spreadBps: null,
      roundingBeneficiary: 'platform' as const,
    });
    const merchantTarget = (id: string, change: Record<string, unknown>) => ({ scope: 'merchant', merchantId: id, change }) as never;

    beforeEach(async () => {
      const pay = new PayService(sql, new MemoryLedger(), new RailRegistry([]), {});
      otherMerchantId = (await pay.createMerchant({ userId: OWNER_B, pricing: { feeBps: 0 } })).id;
      await applyChange(changes, sql, tierTarget);
    }, 30_000);

    const profileRow = (id: string) =>
      sql<
        Array<{ tier_id: string | null; archetype_id: string | null; caps_override: unknown; reserve_override: unknown; version: string }>
      >`SELECT tier_id, archetype_id, caps_override, reserve_override, version FROM pay.control_merchant_profiles WHERE merchant_id = ${id}`;
    const status = async (requestId: string) =>
      (await sql<Array<{ status: string }>>`SELECT status FROM pay.control_changes WHERE request_id = ${requestId}`)[0]!.status;

    async function stored(target: ReturnType<typeof merchantTarget>) {
      const requestId = randomUUID();
      const out = await changes.submit(FOUNDER_1, { requestId, target, reason: 'submitted for the drill', expectedVersion: '0' });
      expect(out.outcome).toBe('pending_second_approval');
      return requestId;
    }

    it('applies when the hash matches what was stored', async () => {
      const target = merchantTarget(merchantId, { kind: 'set_tier', tierId: TEST_TIER.id, archetypeId: 'psp' });
      const requestId = await stored(target);
      const done = await changes.confirm(FOUNDER_2, {
        requestId,
        decision: 'confirm',
        reason: 'matches',
        expectedChangeHash: hashOf(target, '0'),
      });
      expect(done.outcome).toBe('changed');
      expect((await profileRow(merchantId))[0]).toMatchObject({ tier_id: TEST_TIER.id, archetype_id: 'psp' });
    });

    it.each([
      [
        'a different merchant',
        () => merchantTarget(merchantId, { kind: 'set_tier', tierId: TEST_TIER.id, archetypeId: null }),
        () => merchantTarget(otherMerchantId, { kind: 'set_tier', tierId: TEST_TIER.id, archetypeId: null }),
      ],
      [
        'a different kind of change',
        () => merchantTarget(merchantId, { kind: 'set_reserve', reserve: { rollingReserveBps: null, holdDays: null } }),
        () => merchantTarget(merchantId, { kind: 'set_caps', caps: [{ kind: 'per_payment', assetCode: 'USDT', limit: '7' }] }),
      ],
      [
        'an extra pricing rule',
        () =>
          merchantTarget(merchantId, {
            kind: 'set_pricing',
            pricing: [
              { ...rule('USD', 100), scopeId: merchantId },
              { ...rule('USDT', 0), scopeId: merchantId },
            ],
          }),
        () => merchantTarget(merchantId, { kind: 'set_pricing', pricing: [{ ...rule('USD', 100), scopeId: merchantId }] }),
      ],
      [
        'a different archetype',
        () => merchantTarget(merchantId, { kind: 'set_tier', tierId: TEST_TIER.id, archetypeId: 'psp' }),
        () => merchantTarget(merchantId, { kind: 'set_tier', tierId: TEST_TIER.id, archetypeId: null }),
      ],
    ])('refuses %s and applies nothing, then still works with the right hash', async (_name, storedTarget, shownTarget) => {
      const target = storedTarget();
      const requestId = await stored(target);
      const before = [await profileRow(merchantId), await profileRow(otherMerchantId)];
      const wrong = {
        requestId,
        decision: 'confirm' as const,
        reason: 'shown something else',
        expectedChangeHash: hashOf(shownTarget(), '0'),
      };
      await expect(changes.confirm(FOUNDER_2, wrong)).rejects.toMatchObject({ code: 'pay.change_hash_mismatch' });
      // Declining with the wrong hash is refused too: a decline of something you did not see is not a decision.
      await expect(changes.confirm(FOUNDER_2, { ...wrong, decision: 'reject' })).rejects.toMatchObject({
        code: 'pay.change_hash_mismatch',
      });
      expect([await profileRow(merchantId), await profileRow(otherMerchantId)]).toEqual(before);
      expect(await status(requestId)).toBe('pending');
      expect((await audit(merchantId)).map((r) => r.kind)).toEqual(['control.change_submitted']);
      // A shape that is not a hash at all, and the right hash with the wrong version, are refused the same way.
      await expect(changes.confirm(FOUNDER_2, { ...wrong, expectedChangeHash: 'sha256:nothex' })).rejects.toMatchObject({
        code: 'pay.change_hash_mismatch',
      });
      await expect(changes.confirm(FOUNDER_2, { ...wrong, expectedChangeHash: hashOf(target, '9') })).rejects.toMatchObject({
        code: 'pay.change_hash_mismatch',
      });
      expect(await status(requestId)).toBe('pending');
      const right = await changes.confirm(FOUNDER_2, { ...wrong, reason: 'now it matches', expectedChangeHash: hashOf(target, '0') });
      expect(right.outcome).toBe('changed');
      expect(await status(requestId)).toBe('applied');
    });

    it('the hash check runs before the dual-control check and before a repeat is answered', async () => {
      const target = merchantTarget(merchantId, { kind: 'set_tier', tierId: TEST_TIER.id, archetypeId: null });
      const requestId = await stored(target);
      await expect(
        changes.confirm(FOUNDER_1, { requestId, decision: 'confirm', reason: 'self and wrong', expectedChangeHash: hashOf(target, '5') }),
      ).rejects.toMatchObject({ code: 'pay.change_hash_mismatch' });
      await changes.confirm(FOUNDER_2, { requestId, decision: 'confirm', reason: 'ok', expectedChangeHash: hashOf(target, '0') });
      await expect(
        changes.confirm(FOUNDER_2, { requestId, decision: 'confirm', reason: 'retry wrong', expectedChangeHash: hashOf(target, '5') }),
      ).rejects.toMatchObject({ code: 'pay.change_hash_mismatch' });
      expect(
        (
          await changes.confirm(FOUNDER_2, {
            requestId,
            decision: 'confirm',
            reason: 'retry right',
            expectedChangeHash: hashOf(target, '0'),
          })
        ).outcome,
      ).toBe('changed');
    });
  });
});
