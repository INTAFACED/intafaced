import type { Principal } from '@intafaced/auth';
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { ConversionError } from './conversion/errors.js';
import { ConversionService } from './conversion/service.js';

describe('sandbox conversion execute', () => {
  it('refuses a sandbox key before any database or ledger call', async () => {
    const sql = (() => {
      throw new Error('database was called');
    }) as unknown as Sql;
    const service = new ConversionService({
      sql,
      ledger: {
        post: async () => {
          throw new Error('ledger was called');
        },
      } as never,
      guards: {} as never,
      venue: {} as never,
      registries: {} as never,
      slippageBps: 0,
      placingMaxAgeMs: 1,
    });
    const principal = {
      userId: '11111111-1111-4111-8111-111111111111',
      key_env: 'sandbox',
      scopes: ['pay:payout'],
    } as Principal;

    await expect(service.execute(principal, { requestId: 'req-sandbox', quoteId: 'quote-1' })).rejects.toBeInstanceOf(ConversionError);
    await expect(service.execute(principal, { requestId: 'req-sandbox', quoteId: 'quote-1' })).rejects.toMatchObject({
      code: 'pay.sandbox_live_account_refused',
      trpc: 'FORBIDDEN',
    });
  });
});
