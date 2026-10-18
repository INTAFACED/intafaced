import { randomUUID } from 'node:crypto';
import type { Principal } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { ControlError } from '../control/errors.js';
import { createConversionRouter } from '../namespaces/conversion.js';
import { ConversionService } from './service.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const API_KEY_ID = '22222222-2222-4222-8222-222222222222';

function principal(over: Partial<Principal> = {}): Principal {
  return {
    userId: OWNER,
    sub: OWNER,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes: ['pay:payout'],
    mfa: true,
    tier: 'full',
    expiresAt: new Date(Date.now() + 60_000),
    ...over,
  } as Principal;
}

function harness() {
  let lookups = 0;
  let ledgerCalls = 0;
  const sql = (() => {
    lookups += 1;
    throw new Error('database was called');
  }) as unknown as Sql;
  const service = new ConversionService({
    sql,
    ledger: {
      post: async () => {
        ledgerCalls += 1;
        throw new Error('ledger was called');
      },
    } as never,
    guards: {} as never,
    venue: {} as never,
    registries: {} as never,
    slippageBps: 0,
    placingMaxAgeMs: 1,
  });
  return {
    service,
    lookups: () => lookups,
    ledgerCalls: () => ledgerCalls,
  };
}

describe('conversion.execute refuses an API key before any lookup', () => {
  it('refuses an owner-backed key holding pay:payout and does not look up or post', async () => {
    const { service, lookups, ledgerCalls } = harness();
    const key = principal({ kid: API_KEY_ID });

    await expect(service.execute(key, { requestId: randomUUID(), quoteId: randomUUID() })).rejects.toBeInstanceOf(ControlError);
    await expect(service.execute(key, { requestId: randomUUID(), quoteId: randomUUID() })).rejects.toMatchObject({
      code: 'pay.interactive_required',
    });
    expect(lookups()).toBe(0);
    expect(ledgerCalls()).toBe(0);
  });

  it('lets an interactive MFA session with pay:payout pass the same guard', async () => {
    const { service, lookups } = harness();

    await expect(service.execute(principal(), { requestId: randomUUID(), quoteId: randomUUID() })).rejects.toThrow(/database was called/);
    expect(lookups()).toBeGreaterThan(0);
  });

  it('maps the key refusal the way merchant control maps pay.interactive_required', async () => {
    const { service, lookups, ledgerCalls } = harness();
    const caller = createConversionRouter(service).createCaller({
      principal: principal({ kid: API_KEY_ID }),
      service: null,
      region: 'DE',
      requestId: 'req-conversion-key',
    } satisfies Context);

    const refused = await caller.conversion.execute({ requestId: randomUUID(), quoteId: randomUUID() }).then(
      () => null,
      (error: { code?: string; message?: string; cause?: { code?: string } }) => ({
        code: error.code,
        message: error.message,
        cause: error.cause?.code,
      }),
    );

    expect(refused).toMatchObject({ code: 'FORBIDDEN', message: 'pay.interactive_required', cause: 'pay.interactive_required' });
    expect(lookups()).toBe(0);
    expect(ledgerCalls()).toBe(0);
  });
});
