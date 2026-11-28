import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryLedger } from '@intafaced/ledger-client';
import { createFounderAuthority } from '../founder-authority.js';
import { scriptedSql } from '../scripted-sql.testkit.js';
import * as ramp from './index.js';
import * as money from './money.js';

/**
 * The B2B ramp books nothing: a credit is admitted on its own rows and svc-ledger is never asked. Every way this
 * module could post (a ledger client, an HTTP transport, a recipe, a recipe poster, the in-memory ledger, any outside
 * call) is recorded, then every module in the folder is driven: every export of money, config, access, errors and
 * socket, and every procedure of the router, through the folder's index. Which modules may import ledger-client at all
 * is ledger-import.test.ts.
 */
const posted = vi.hoisted(() => [] as string[]);

vi.mock('@intafaced/ledger-client', async (importOriginal) => {
  const real = await importOriginal<typeof import('@intafaced/ledger-client')>();
  const recipes = new Proxy(real.recipes, {
    get: (target, name: string) => {
      const recipe: unknown = Reflect.get(target, name);
      if (typeof recipe !== 'function') return recipe;
      return (...args: unknown[]) => {
        posted.push(`recipes.${name}`);
        return recipe(...args);
      };
    },
  });
  const record =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      posted.push(name);
      return fn(...args);
    };
  return {
    ...real,
    recipes,
    createHttpLedgerClient: record('createHttpLedgerClient', real.createHttpLedgerClient),
    createLedgerTransport: record('createLedgerTransport', real.createLedgerTransport),
    bankTransfer: record('bankTransfer', real.bankTransfer),
    bankTransferReversal: record('bankTransferReversal', real.bankTransferReversal),
  };
});
vi.mock('@intafaced/ledger-client/post-recipe', async (importOriginal) => {
  const real = await importOriginal<typeof import('@intafaced/ledger-client/post-recipe')>();
  return {
    ...real,
    createHttpRecipePoster: (...args: Parameters<typeof real.createHttpRecipePoster>) => {
      posted.push('createHttpRecipePoster');
      return real.createHttpRecipePoster(...args);
    },
    recipePosterOver: (...args: Parameters<typeof real.recipePosterOver>) => {
      posted.push('recipePosterOver');
      return real.recipePosterOver(...args);
    },
    postRecipeRequest: (...args: Parameters<typeof real.postRecipeRequest>) => {
      posted.push('postRecipeRequest');
      return real.postRecipeRequest(...args);
    },
  };
});

const merchantId = randomUUID();
const userId = randomUUID();
const creditId = randomUUID();
const principal: Principal = {
  userId,
  sub: userId,
  sid: randomUUID(),
  scopes: ['pay:read', 'pay:write'],
  mfa: true,
  tier: 'full',
  expiresAt: new Date(Date.now() + 60_000),
};
const ctx: Context = {
  principal,
  service: null,
  region: 'DE',
  requestId: randomUUID(),
  forwardedPrincipal: { raw: 'test-principal', signature: 'test-signature', region: 'DE' },
};
const on = { PAY_B2B_RAMP: 'on', APP_ENV: 'test' };
const line = { id: 'line-pk-1', merchant_id: merchantId, amount: '10.5', asset: 'USD', reference: 'ref-1', posted_at: new Date() };
const creditRow = { id: creditId, merchant_id: merchantId, amount: '10.5', asset: 'USD', line_id: 'stmt-1' };

describe('the B2B ramp never posts to the ledger', () => {
  const ledgerPost = vi.spyOn(MemoryLedger.prototype, 'post');
  const fetched = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the ramp called out'));
  beforeAll(() => {
    posted.length = 0;
  });
  afterAll(() => {
    ledgerPost.mockRestore();
    fetched.mockRestore();
  });

  it('every export and every router procedure, driven once, posts nothing and calls no one', async () => {
    const { sql } = scriptedSql<Sql>((call) => {
      if (call.text.includes('FROM pay.merchants')) return [];
      if (call.text.includes('FROM pay.merchant_team_members')) return [{ role: 'finance' }];
      if (call.text.includes('INSERT INTO pay.b2b_ramp_bank_lines')) return [{ id: line.id }];
      if (call.text.includes('FROM pay.b2b_ramp_bank_lines')) return [line];
      if (call.text.includes('INSERT INTO pay.b2b_ramp_credits')) return [{ id: creditId }];
      if (call.text.includes('FROM pay.b2b_ramp_credits') && call.text.includes('WHERE c.id')) return [creditRow];
      return [];
    });
    const settle = (run: () => unknown) =>
      Promise.resolve()
        .then(run)
        .catch(() => undefined);

    // money.ts
    await settle(() => money.parsePositiveAmount('10.50'));
    await settle(() => money.parsePositiveAmount('-1'));
    await settle(() => money.sameAmount('10.5', '10.50'));
    await settle(() => money.parseAsset('USD'));
    await settle(() => money.parseAsset(''));
    // config.ts, errors.ts
    for (const env of [on, { PAY_B2B_RAMP: 'off', APP_ENV: 'test' }, {}, { PAY_B2B_RAMP: 'on', APP_ENV: 'prod' }]) {
      await settle(() => ramp.loadB2bRampConfig(env));
    }
    // The constants the folder exports are plain values, nothing that could post.
    for (const value of [ramp.B2B_RAMP_FLAG, ramp.B2B_RAMP_MODE_ENV, ramp.B2B_RAMP_LICENCE_ENV, ...ramp.B2B_RAMP_DEFERRED]) {
      expect(typeof value).toBe('string');
    }
    expect(new ramp.B2bRampError('pay.b2b_ramp_off', 'refused')).toBeInstanceOf(Error);
    expect(new ramp.B2bRampBootError('unset')).toBeInstanceOf(Error);
    // access.ts
    await settle(() => ramp.postgresB2bRampAccess(sql).roleFor(userId, merchantId));
    // socket.ts
    const socket = new ramp.BankStatementReconciliation(sql, on);
    await settle(() =>
      socket.recordBankLine({
        source: 'bank_statement',
        lineId: 'stmt-1',
        merchantId,
        amount: '10.5',
        asset: 'USD',
        reference: 'ref-1',
        postedAt: line.posted_at.toISOString(),
      }),
    );
    await settle(() => socket.credit({ merchantId, bankLineId: 'stmt-1', amount: '10.5', asset: 'USD' }));
    await settle(() => socket.credit({ merchantId, bankLineId: 'stmt-1', amount: '10.4', asset: 'USD' }));
    await settle(() => socket.get(creditId));
    // router.ts: every procedure, on its real socket and access over the same database.
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ result: { data: { status: 'enabled', userId, version: '1', changedAt: '2026-10-10T00:00:00Z' } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const founderAuthority = createFounderAuthority({ identityUrl: 'https://identity.invalid', serviceSecret: 's'.repeat(32), fetcher });
    const router = ramp.createB2bRampRouter({ founderAuthority, sql, env: on });
    const caller = router.createCaller(ctx);
    const driven = {
      'b2bRamp.status': () => caller.b2bRamp.status({ merchantId }),
      'b2bRamp.credit': () => caller.b2bRamp.credit({ merchantId, bankLineId: 'stmt-1', amount: '10.5', asset: 'USD' }),
      'b2bRamp.get': () => caller.b2bRamp.get({ creditId }),
      'b2bRamp.founderStatus': () => caller.b2bRamp.founderStatus(),
    };
    expect(Object.keys(router._def.procedures).sort()).toEqual(Object.keys(driven).sort());
    for (const run of Object.values(driven)) await settle(run);
    // The credit path did run: the router admitted a credit on its own rows.
    await expect(caller.b2bRamp.credit({ merchantId, bankLineId: 'stmt-1', amount: '10.5', asset: 'USD' })).resolves.toMatchObject({
      ledgerPosted: false,
    });

    expect(posted).toEqual([]);
    expect(ledgerPost).not.toHaveBeenCalled();
    expect(fetched).not.toHaveBeenCalled();
  });
});
