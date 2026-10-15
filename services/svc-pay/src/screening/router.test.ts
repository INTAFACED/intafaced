import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { Context } from '@intafaced/contracts';
import { createScreeningRouter } from './router.js';
import { PayScreeningService } from './service.js';

describe('screening review operator API', () => {
  it('exposes durable cases with fixture labels only to compliance operators', async () => {
    const settlementId = randomUUID(),
      merchantId = randomUUID(),
      userId = randomUUID();
    const sql = vi.fn(async () => [
      {
        settlement_id: settlementId,
        attempt: 0,
        merchant_id: merchantId,
        provider: 'fixture-test-data',
        fixture: true,
        created_at: new Date('2026-10-15T00:00:00Z'),
      },
    ]) as unknown as Sql;
    const router = createScreeningRouter(new PayScreeningService({ sql }));
    const ctx: Context = {
      principal: {
        userId,
        sub: userId,
        sid: randomUUID(),
        scopes: ['admin:compliance'],
        mfa: true,
        tier: 'full',
        expiresAt: new Date(Date.now() + 60_000),
      },
      service: null,
      region: 'AA',
      requestId: randomUUID(),
    };
    await expect(router.createCaller(ctx).screening.reviews({ limit: 10 })).resolves.toEqual([
      { settlementId, attempt: 0, merchantId, provider: 'fixture-test-data', fixture: true, createdAt: '2026-10-15T00:00:00.000Z' },
    ]);
    await expect(
      router.createCaller({ ...ctx, principal: { ...ctx.principal!, scopes: ['pay:read'] } }).screening.reviews({ limit: 10 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
