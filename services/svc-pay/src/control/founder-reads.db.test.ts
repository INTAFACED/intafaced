import { founderChangeHash } from '@intafaced/contracts/founder-change-hash';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, transaction, type TestDatabase } from '@intafaced/db';
import { MemoryLedger } from '@intafaced/ledger-client';
import type { Context } from '@intafaced/contracts';
import { PayService } from '../payment-service.js';
import { MerchantControlError } from '../merchant-account-controls.js';
import { RailRegistry } from '../rails/registry.js';
import { writeAudit } from './audit.js';
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
  principal,
  resetControl,
  TEST_GLOBAL_RULE,
  TEST_TIER,
} from './control.testkit.js';
import { createPayNamespaces } from '../namespaces/index.js';

/**
 * Founder reads of the control room: audit history (including captured_over_cap),
 * pending control changes, and the fact that a merchant session cannot call them.
 */
describe('founder control reads', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let sql!: TestDatabase['sql'];
  let merchantA = '';
  const FOUNDERS = new Set([FOUNDER_1, FOUNDER_2]);

  const founderAuthority = async (ctx: Context): Promise<string> => {
    const p = ctx.principal;
    if (ctx.service || !p || !p.mfa || (p as { kid?: string }).kid || !FOUNDERS.has(p.userId))
      throw new MerchantControlError('operator.denied');
    return p.userId;
  };
  const ctxOf = (userId: string): Context => ({
    principal: principal(userId),
    service: null,
    region: 'DE',
    requestId: randomUUID(),
  });
  type Call = (input: unknown) => Promise<unknown>;
  const at = (caller: unknown, path: string): Call => path.split('.').reduce((n, k) => (n as Record<string, unknown>)[k], caller) as Call;
  const caller = (userId: string) =>
    createPayNamespaces({ founderAuthority, control: new ControlService(sql, ownerAccessPorts(sql)) }).createCaller(ctxOf(userId));
  const failure = async (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (e: { code: string; cause?: { code?: string } }) => ({ code: e.code, cause: e.cause?.code }),
    );

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await resetControl(sql);
    const pay = new PayService(sql, new MemoryLedger(), new RailRegistry([]), {});
    merchantA = (await pay.createMerchant({ userId: OWNER_A, pricing: { feeBps: 0 } })).id;
    const changes = new ChangeService(sql);
    await applyChange(changes, sql, { scope: 'tier', change: { kind: 'upsert_tier', tier: TEST_TIER } });
    await applyChange(changes, sql, {
      scope: 'pricing',
      change: { kind: 'set_pricing_layer', layer: 'global', scopeId: null, rules: [TEST_GLOBAL_RULE] },
    });
    await applyChange(changes, sql, {
      scope: 'merchant',
      merchantId: merchantA,
      change: { kind: 'set_tier', tierId: TEST_TIER.id, archetypeId: null },
    });
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function flagOverCap(merchantId: string, paymentId = randomUUID()) {
    await transaction(sql, async (tx) => {
      await writeAudit(tx, {
        scope: 'merchant',
        scopeId: merchantId,
        merchantId,
        kind: 'payment.captured_over_cap',
        outcome: 'flagged',
        actorId: 'system:capture_guard',
        reason: 'captured payment exceeded: daily_intake',
        after: { paymentId, assetCode: 'USDT', amount: '10', exceeded: ['daily_intake'] },
      });
    });
    return paymentId;
  }

  it('audit history pages newest-first and filters by merchant, kind and an inclusive date range', async () => {
    const f1 = caller(FOUNDER_1);
    const ids = [await flagOverCap(merchantA), await flagOverCap(merchantA), await flagOverCap(merchantA)];
    const other = await flagOverCap(randomUUID());

    const collected: string[] = [];
    let cursor: string | undefined;
    for (let n = 0; n < 5; n += 1) {
      const page = (await at(
        f1,
        'founderAdmin.control.audit.list',
      )({
        limit: 2,
        kind: 'payment.captured_over_cap',
        merchantId: merchantA,
        ...(cursor ? { cursor } : {}),
      })) as { entries: Array<{ seq: string; kind: string; after: { paymentId?: string } }>; nextCursor: string | null };
      expect(page.entries.length).toBeLessThanOrEqual(2);
      expect(page.entries.every((e) => e.kind === 'payment.captured_over_cap')).toBe(true);
      collected.push(...page.entries.map((e) => e.after.paymentId!));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(collected).toEqual([...ids].reverse());
    expect(collected).not.toContain(other);

    const past = (await at(
      f1,
      'founderAdmin.control.audit.list',
    )({
      limit: 10,
      kind: 'payment.captured_over_cap',
      from: '2020-01-01T00:00:00.000Z',
      to: '2020-01-02T00:00:00.000Z',
    })) as { entries: unknown[] };
    expect(past.entries).toEqual([]);

    const now = new Date();
    const window = (await at(
      f1,
      'founderAdmin.control.audit.list',
    )({
      limit: 10,
      kind: 'payment.captured_over_cap',
      merchantId: merchantA,
      from: new Date(now.getTime() - 60_000).toISOString(),
      to: new Date(now.getTime() + 60_000).toISOString(),
    })) as { entries: unknown[] };
    expect(window.entries).toHaveLength(3);

    // A prefix is not a match.
    const prefix = (await at(f1, 'founderAdmin.control.audit.list')({ limit: 10, kind: 'payment.captured' })) as { entries: unknown[] };
    expect(prefix.entries).toEqual([]);

    const reversed = await failure(
      at(
        f1,
        'founderAdmin.control.audit.list',
      )({
        limit: 10,
        from: '2026-02-01T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000Z',
      }),
    );
    expect(reversed).toMatchObject({ code: 'BAD_REQUEST', cause: 'pay.control_invalid' });
  });

  it('pending changes name the first founder and the hash the second founder must send, then leave the list', async () => {
    const f1 = caller(FOUNDER_1);
    const f2 = caller(FOUNDER_2);
    const tierIds: string[] = [];
    for (const name of ['a', 'b', 'c']) {
      const requestId = randomUUID();
      tierIds.push(requestId);
      const tier = { ...TEST_TIER, id: `pend-${name}`, name: `TEST VALUE ${name}` };
      const submitted = (await at(
        f1,
        'founderAdmin.control.configure.submit',
      )({
        requestId,
        change: { kind: 'upsert_tier', tier },
        reason: 'queue a tier',
        expectedVersion: '0',
      })) as { outcome: string };
      expect(submitted.outcome).toBe('pending_second_approval');
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let n = 0; n < 5; n += 1) {
      const page = (await at(f1, 'founderAdmin.changes.pending')({ limit: 2, scope: 'tier', ...(cursor ? { cursor } : {}) })) as {
        changes: Array<{ requestId: string; makerUserId: string; scope: string }>;
        nextCursor: string | null;
      };
      expect(page.changes.every((c) => c.scope === 'tier' && c.makerUserId === FOUNDER_1)).toBe(true);
      seen.push(...page.changes.map((c) => c.requestId));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(tierIds);

    const version = (
      await sql<
        Array<{ version: string }>
      >`SELECT version::text AS version FROM pay.control_merchant_profiles WHERE merchant_id = ${merchantA}`
    )[0]!.version;
    const requestId = randomUUID();
    const target = {
      scope: 'merchant' as const,
      merchantId: merchantA,
      change: { kind: 'set_tier' as const, tierId: TEST_TIER.id, archetypeId: 'psp' as const },
    };
    await at(
      f1,
      'founderAdmin.changes.submit',
    )({
      requestId,
      merchantId: merchantA,
      change: target.change,
      reason: 'switch archetype',
      expectedVersion: version,
    });
    const pending = (await at(f2, 'founderAdmin.changes.pending')({ limit: 10, merchantId: merchantA })) as {
      changes: Array<{ requestId: string; changeHash: string; makerUserId: string }>;
    };
    const row = pending.changes.find((c) => c.requestId === requestId);
    expect(row).toMatchObject({ makerUserId: FOUNDER_1, changeHash: founderChangeHash(target, version) });
    const otherMerchant = (await at(f2, 'founderAdmin.changes.pending')({ limit: 10, merchantId: randomUUID() })) as { changes: unknown[] };
    expect(otherMerchant.changes).toEqual([]);

    const confirmed = (await at(
      f2,
      'founderAdmin.changes.confirm',
    )({
      requestId,
      decision: 'confirm',
      reason: 'agreed',
      expectedChangeHash: row!.changeHash,
    })) as { outcome: string };
    expect(confirmed.outcome).toBe('changed');
    const after = (await at(f1, 'founderAdmin.changes.pending')({ limit: 10, merchantId: merchantA })) as { changes: unknown[] };
    expect(after.changes).toEqual([]);
  });

  it('a merchant session cannot read the audit or the pending changes', async () => {
    const merchant = caller(OWNER_A);
    for (const [path, input] of [
      ['founderAdmin.control.audit.list', { limit: 10 }],
      ['founderAdmin.changes.pending', { limit: 10 }],
    ] as const) {
      expect(await failure(at(merchant, path)(input))).toMatchObject({ code: 'FORBIDDEN' });
    }
  });
});
