/**
 * BK-acct-01 and BK-pots-01: the account terms, the currencies on an account, and the owner's limit on spaces.
 * Enters through the router. Uses TEST_DATABASE_URL. Does not start Docker.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { createBankServices, memoryRecipientState, type BankServiceOptions } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankRouter } from '../router.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'c'.repeat(32);
const ADA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const SID = '99999999-9999-4999-8999-999999999999';

/** Labelled TEST terms, in the owner's shape. */
const TEST_TERMS = {
  tier: 'TEST base tier',
  version: 'test-1',
  currency: 'USDT',
  monthlyFee: '0',
  minimumBalance: '0',
  overdraftFee: null,
  included: ['TEST spaces', 'TEST transfers between your spaces'],
};

function principal(userId: string, scopes: string[]): Principal {
  return { sub: userId, userId, sid: SID, scopes, tier: 'full', mfa: true, expiresAt: new Date(Date.now() + 60_000) } as Principal;
}

const codeOf = (err: unknown) => (err as { cause?: { code?: string } }).cause?.code;

describe('account home (BK-acct-01) and the space limit (BK-pots-01)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;

  beforeAll(async () => {
    const raw = process.env.TEST_DATABASE_URL?.trim();
    if (!raw) throw new Error('TEST_DATABASE_URL is unset. This suite does not start Docker.');
    const url = new URL(raw);
    if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
    db = await createTestDatabase({ service: 'bank', url: url.toString(), migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await sql`TRUNCATE bank.spaces RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
  });

  function as(userId: string, options: BankServiceOptions = {}) {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
      ...options,
    });
    const raw = encodePrincipal(principal(userId, ['bank:read', 'bank:write']));
    const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
    const api = createBankRouter(bank).createCaller(
      edge({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: `req-${randomUUID()}`,
      }),
    );
    return { bank, api };
  }

  const fund = (userId: string, assetId: string, amount: string, ref = randomUUID()) =>
    ledger.post(recipes.deposit({ userId, assetId, amount: parseAmount(amount), rail: 'test', railRef: ref }));

  const primaries = (userId: string) =>
    sql<Array<{ asset_id: string; removed: boolean }>>`
      SELECT asset_id, removed_at IS NOT NULL AS removed FROM bank.spaces WHERE user_id = ${userId} AND kind = 'primary' ORDER BY asset_id
    `;

  describe('accounts.features', () => {
    it('refuses bank.account_terms_unset while the owner has published nothing, and for terms out of shape', async () => {
      for (const accountTerms of [undefined, '', '   ', 'not json', JSON.stringify({ ...TEST_TERMS, monthlyFee: 'free' })]) {
        const err = await as(ADA, { accountTerms })
          .api.accounts.features()
          .catch((e: unknown) => e);
        expect(codeOf(err)).toBe('bank.account_terms_unset');
      }
    });

    it('returns the published terms exactly, figures as decimal strings', async () => {
      const terms = { ...TEST_TERMS, monthlyFee: '2.50', overdraftFee: '0' };
      expect(await as(ADA, { accountTerms: JSON.stringify(terms) }).api.accounts.features()).toEqual(terms);
    });
  });

  describe('currencies', () => {
    const allowed = { accountCurrencies: 'USDT, USDC,BTC' };

    it('adds a currency from the owner list once, however often it is asked', async () => {
      const { api } = as(ADA, allowed);
      const first = await api.currencies.add({ assetId: 'usdc' });
      const second = await api.currencies.add({ assetId: 'USDC' });
      expect(second).toEqual(first);
      expect(first).toMatchObject({ assetId: 'USDC', balance: '0' });
      expect(await primaries(ADA)).toEqual([{ asset_id: 'USDC', removed: false }]);
      const listed = await api.currencies.list();
      expect(listed.currencies.map((c) => c.assetId)).toEqual(['USDC']);
      expect(listed.addable).toEqual(['USDT', 'BTC']);
    });

    it('refuses an asset not on the owner list, and every add while the list is blank', async () => {
      expect(
        codeOf(
          await as(ADA, allowed)
            .api.currencies.add({ assetId: 'DOGE' })
            .catch((e: unknown) => e),
        ),
      ).toBe('bank.asset_unknown');
      const blank = as(ADA);
      expect(codeOf(await blank.api.currencies.add({ assetId: 'USDT' }).catch((e: unknown) => e))).toBe('bank.account_currencies_unset');
      expect(await primaries(ADA)).toEqual([]);
      // The list still shows what the account holds and says why nothing can be added.
      await fund(ADA, 'USDT', '5');
      expect(await blank.api.currencies.list()).toMatchObject({
        currencies: [{ assetId: 'USDT', balance: '5' }],
        addable: null,
        addableBlocker: 'bank.account_currencies_unset',
      });
    });

    it('refuses bank.currency_in_use while the currency holds a balance, and moves nothing', async () => {
      const { api } = as(ADA, allowed);
      await fund(ADA, 'USDT', '100');
      await api.currencies.add({ assetId: 'USDT' });
      const err = await api.currencies.remove({ assetId: 'USDT' }).catch((e: unknown) => e);
      expect(codeOf(err)).toBe('bank.currency_in_use');
      expect((await api.currencies.list()).currencies).toMatchObject([{ assetId: 'USDT', balance: '100' }]);
      expect(await primaries(ADA)).toEqual([{ asset_id: 'USDT', removed: false }]);
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    it('refuses while all of it is held for an open order, with nothing available', async () => {
      const { api } = as(ADA, allowed);
      await fund(ADA, 'BTC', '1');
      await ledger.post(recipes.orderHold({ userId: ADA, assetId: 'BTC', amount: parseAmount('1'), orderId: 'order-1' }));
      await api.currencies.add({ assetId: 'BTC' });
      expect(codeOf(await api.currencies.remove({ assetId: 'BTC' }).catch((e: unknown) => e))).toBe('bank.currency_in_use');
    });

    it('refuses while a named space uses the currency, live and empty or archived and funded', async () => {
      const { bank, api } = as(ADA, { ...allowed, spaceLimit: '5' });
      await api.currencies.add({ assetId: 'USDC' });
      const pot = await api.spaces.create({ assetId: 'USDC', name: 'Trip' });
      expect(codeOf(await api.currencies.remove({ assetId: 'USDC' }).catch((e: unknown) => e))).toBe('bank.currency_in_use');

      await fund(ADA, 'USDC', '30');
      const main = await bank.spaces.ensurePrimary(ADA, 'USDC');
      await api.transfers.create({ transferId: 'pot-in-1', fromSpaceId: main.id, toSpaceId: pot.id, amount: '30' });
      await api.spaces.archive({ spaceId: pot.id });
      expect(codeOf(await api.currencies.remove({ assetId: 'USDC' }).catch((e: unknown) => e))).toBe('bank.currency_in_use');
    });

    it('removes an empty currency, shows it again once money arrives, and an add brings back the same space', async () => {
      const { api } = as(ADA, allowed);
      const added = await api.currencies.add({ assetId: 'USDC' });
      expect(await api.currencies.remove({ assetId: 'USDC' })).toEqual({ assetId: 'USDC', removed: true });
      expect(await api.currencies.remove({ assetId: 'USDC' })).toEqual({ assetId: 'USDC', removed: true });
      expect((await api.currencies.list()).currencies).toEqual([]);
      expect((await api.spaces.list({ limit: 50 })).map((s) => s.assetId)).toEqual([]);

      await fund(ADA, 'USDC', '7');
      expect((await api.currencies.list()).currencies).toEqual([{ assetId: 'USDC', spaceId: added.spaceId, balance: '7' }]);

      await fund(ADA, 'BTC', '0.5');
      await api.currencies.list();
      await sql`UPDATE bank.spaces SET removed_at = now() WHERE user_id = ${ADA} AND asset_id = 'USDC'`;
      expect((await api.spaces.list({ limit: 50 })).map((s) => s.assetId)).toEqual(['BTC', 'USDC']);
      expect(await api.currencies.add({ assetId: 'USDC' })).toEqual({ assetId: 'USDC', spaceId: added.spaceId, balance: '7' });
    });

    it('touches only the caller’s own currencies', async () => {
      await as(BOB, allowed).api.currencies.add({ assetId: 'USDC' });
      await as(ADA, allowed).api.currencies.remove({ assetId: 'USDC' });
      expect(await primaries(BOB)).toEqual([{ asset_id: 'USDC', removed: false }]);
    });
  });

  describe('spaces.create inside the owner limit', () => {
    it('refuses bank.space_limit_unset while the limit is blank, and makes no space', async () => {
      for (const spaceLimit of [undefined, '', '0', '-1', '2.5', 'ten']) {
        const err = await as(ADA, { spaceLimit })
          .api.spaces.create({ assetId: 'USDT', name: 'Trip' })
          .catch((e: unknown) => e);
        expect(codeOf(err)).toBe('bank.space_limit_unset');
      }
      expect(await sql`SELECT id FROM bank.spaces WHERE kind = 'named'`).toHaveLength(0);
    });

    it('refuses bank.space_limit_reached at the limit with the number; archived spaces do not count until restored', async () => {
      const { api } = as(ADA, { spaceLimit: '2' });
      const a = await api.spaces.create({ assetId: 'USDT', name: 'A' });
      await api.spaces.create({ assetId: 'BTC', name: 'B' });
      const full = await api.spaces.create({ assetId: 'USDT', name: 'C' }).catch((e: unknown) => e);
      expect(codeOf(full)).toBe('bank.space_limit_reached');
      expect((full as Error).message).toContain('2');

      await api.spaces.archive({ spaceId: a.id });
      const c = await api.spaces.create({ assetId: 'USDT', name: 'C' });
      expect(codeOf(await api.spaces.unarchive({ spaceId: a.id }).catch((e: unknown) => e))).toBe('bank.space_limit_reached');
      await api.spaces.archive({ spaceId: c.id });
      expect(await api.spaces.unarchive({ spaceId: a.id })).toEqual({ archived: false });
      // Another customer's spaces never use up this one's room.
      expect(await as(BOB, { spaceLimit: '2' }).api.spaces.create({ assetId: 'USDT', name: 'A' })).toMatchObject({ name: 'A' });
    });

    it('makes one space when two creates race for the last place', async () => {
      const { api } = as(ADA, { spaceLimit: '1' });
      const results = await Promise.allSettled([
        api.spaces.create({ assetId: 'USDT', name: 'One' }),
        api.spaces.create({ assetId: 'USDT', name: 'Two' }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(codeOf(refused?.reason)).toBe('bank.space_limit_reached');
      expect(await sql`SELECT id FROM bank.spaces WHERE user_id = ${ADA} AND kind = 'named'`).toHaveLength(1);
    });
  });
});
