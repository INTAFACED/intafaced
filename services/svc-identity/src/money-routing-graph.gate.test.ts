import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { recipes, subAccountAvailable } from '@intafaced/ledger-client';
import { partial } from '@intafaced/service-kit/testing';
import { AuthError, AuthService } from './auth/auth-service.js';
import { API_KEY_OWNERSHIP_PATH } from './auth/api-key-ownership-route.js';
import { BOOT_INTERNAL_SECRET, bootIdentity, contextWith, type SqlCall } from './boot.testkit.js';
import { subAccounts } from './db/schema.js';
import type { RankService } from './rank/rank-service.js';
import { createIdentityRouter } from './router.js';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';

/**
 * D26-P1-I1 / D-S-11 — structural seal for the identity money-routing graph.
 *
 * Product-complete is ownership + cross-leak ban + trade ownership consult.
 * These gates keep the data model from growing a KYC/sanctions bypass column
 * and keep the door/recipe surfaces wired so a future edit cannot quietly
 * drop them: each is asked what it does, the snapshots on the booted service.
 */

const here = dirname(fileURLToPath(import.meta.url));
const serviceRoot = join(here, '..');
const monorepo = join(serviceRoot, '../..');

const BANNED_SUB_ACCOUNT_COLUMNS = [
  'tier',
  'kyc_tier',
  'jurisdiction',
  'region',
  'sanctions',
  'compliance_status',
  'balance',
  'available',
  'hold',
];

const OWNER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
const SUB_A = '33333333-3333-4333-8333-333333333333';
const SUB_B = '44444444-4444-4444-8444-444444444444';
const FOREIGN = '55555555-5555-4555-8555-555555555555';
const UNKNOWN = '66666666-6666-4666-8666-666666666666';

/** The partitions the fake database holds: two of the owner's, one of a stranger's. */
const PARTITIONS = new Map([
  [SUB_A, { id: SUB_A, parent_user_id: OWNER, revoked: false, frozen: 0 }],
  [SUB_B, { id: SUB_B, parent_user_id: OWNER, revoked: false, frozen: 0 }],
  [FOREIGN, { id: FOREIGN, parent_user_id: STRANGER, revoked: false, frozen: 0 }],
]);

/** A sql that answers the sub-account and user reads from PARTITIONS and records every query. */
function partitionSql(opts: { liveCount?: number } = {}) {
  const queries: SqlCall[] = [];
  const answer = ({ text, values }: SqlCall): unknown[] => {
    if (/FROM sub_accounts WHERE id = /.test(text)) {
      const row = PARTITIONS.get(values[0] as string);
      return row ? [row] : [];
    }
    if (/count\(\*\)::text AS n FROM sub_accounts/.test(text)) return [{ n: String(opts.liveCount ?? 0) }];
    if (/FROM users WHERE id = /.test(text)) return [{ id: values[0], status: 'active' }];
    return [];
  };
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const call = { text: strings.join('?'), values };
      queries.push(call);
      return Promise.resolve(answer(call));
    },
    { begin: async (...args: unknown[]) => (args.find((a) => typeof a === 'function') as (tx: unknown) => unknown)(sql) },
  );
  return { sql: sql as never, queries };
}

const tokens = { secret: 's'.repeat(32), issuer: 'intafaced', audience: 'intafaced.api', accessTtlSeconds: 900, refreshTtlSeconds: 3600 };

function authOver(sql: never, maxSubAccounts?: number) {
  return new AuthService(
    sql,
    new MemoryEventBus('svc-identity'),
    partial<RankService>({}),
    tokens,
    undefined,
    undefined,
    undefined,
    undefined,
    maxSubAccounts,
  );
}

const code = (err: unknown) => (err as { code?: string }).code;

describe('money-routing graph gate (D26-P1-I1)', () => {
  it('sub_accounts schema has no tier/jurisdiction/balance columns (SPEC-SUBACCOUNTS §0 / §5)', () => {
    const columns = Object.entries(getTableColumns(subAccounts)).flatMap(([key, column]) => [key.toLowerCase(), column.name.toLowerCase()]);
    for (const col of BANNED_SUB_ACCOUNT_COLUMNS) {
      const camel = col.replace(/_(.)/g, (_m, c: string) => c).toLowerCase();
      expect(columns, `sub_accounts must not define ${col}`).not.toContain(col);
      expect(columns, `sub_accounts must not define ${col}`).not.toContain(camel);
    }
    // Bookkeeping columns that must remain.
    expect(columns).toContain('parent_user_id');
    expect(columns).toContain('revoked');
  });

  it('init + revoke migrations never add tier/jurisdiction columns to sub_accounts', () => {
    const init = readFileSync(join(serviceRoot, 'drizzle/0000_identity_init.sql'), 'utf8').toLowerCase();
    const revoke = readFileSync(join(serviceRoot, 'drizzle/0002_sub_accounts_revoke.sql'), 'utf8').toLowerCase();
    const subInit = init.slice(init.indexOf('create table if not exists "identity"."sub_accounts"'));
    // Column definitions only — comments may say "balances" without adding a column.
    expect(subInit).toMatch(/"parent_user_id"/);
    expect(subInit).not.toMatch(/"tier"/);
    expect(subInit).not.toMatch(/"jurisdiction"/);
    expect(subInit).not.toMatch(/"balance"/);
    expect(revoke).not.toMatch(/add column[^;]*tier/i);
    expect(revoke).not.toMatch(/add column[^;]*jurisdiction/i);
    expect(revoke).toMatch(/"revoked"/);
  });

  it('AuthService exposes ownership + transfer doors and the live-partition cap', async () => {
    // The transfer door checks each leg with the single-row ownership door: both legs are read, either foreign refuses.
    const { sql, queries } = partitionSql();
    const auth = authOver(sql, 5);
    await expect(auth.assertSubAccountTransferDoor(OWNER, SUB_A, SUB_B)).resolves.toEqual({ fromId: SUB_A, toId: SUB_B });
    expect(queries.filter((q) => /FROM sub_accounts WHERE id = /.test(q.text)).map((q) => q.values[0])).toEqual([SUB_A, SUB_B]);
    for (const [from, to] of [
      [SUB_A, FOREIGN],
      [FOREIGN, SUB_A],
      [SUB_A, UNKNOWN],
    ] as const) {
      const err = await auth.assertSubAccountTransferDoor(OWNER, from, to).catch((e: unknown) => e);
      expect(err, `${from} -> ${to}`).toBeInstanceOf(AuthError);
      expect(code(err), `${from} -> ${to}`).toBe('auth.sub_account_denied');
    }
    expect(code(await auth.assertSubAccountTransferDoor(OWNER, SUB_A, SUB_A).catch((e: unknown) => e))).toBe('auth.sub_account_same');
    expect(code(await auth.assertSubAccountTransferDoor(OWNER, SUB_A, null).catch((e: unknown) => e))).toBe('auth.sub_account_required');

    // The live-partition cap: unset refuses (no invented default), reached refuses.
    const unset = authOver(partitionSql().sql, undefined);
    expect(code(await unset.createSubAccount(OWNER, 'bot').catch((e: unknown) => e))).toBe('auth.sub_account_cap_unset');
    const full = authOver(partitionSql({ liveCount: 2 }).sql, 2);
    expect(code(await full.createSubAccount(OWNER, 'bot').catch((e: unknown) => e))).toBe('auth.sub_account_limit');
  });

  it('tRPC mounts assertOwned + assertTransferDoor under subAccounts', async () => {
    const calls: unknown[][] = [];
    const auth = partial<AuthService>({
      assertSubAccountOwned: async (...args: unknown[]) => {
        calls.push(['owned', ...args]);
        return { id: SUB_A, parentUserId: OWNER };
      },
      assertSubAccountTransferDoor: async (...args: unknown[]) => {
        calls.push(['transfer', ...args]);
        return { fromId: SUB_A, toId: SUB_B };
      },
    });
    const api = createIdentityRouter(auth, partial<RankService>({}), {}).createCaller(
      await contextWith(['identity:write'], { userId: OWNER }),
    );
    await expect(api.subAccounts.assertOwned({ subAccountId: SUB_A })).resolves.toEqual({ id: SUB_A, parentUserId: OWNER });
    await expect(api.subAccounts.assertTransferDoor({ fromSubAccountId: SUB_A, toSubAccountId: SUB_B })).resolves.toEqual({
      fromId: SUB_A,
      toId: SUB_B,
    });
    expect(calls).toEqual([
      ['owned', OWNER, SUB_A],
      ['transfer', OWNER, SUB_A, SUB_B],
    ]);
  });

  describe('the booted service serves the place gate snapshots', async () => {
    const answer = ({ text, values }: SqlCall): unknown[] | undefined => {
      if (/FROM sub_accounts WHERE id = /.test(text)) {
        const row = PARTITIONS.get(values[0] as string);
        return row ? [row] : [];
      }
      return undefined;
    };
    const { app } = await bootIdentity({}, answer);
    const signed = (url: string) =>
      app.inject({ method: 'GET', url, headers: serviceAuthHeadersForBody('svc-trade', BOOT_INTERNAL_SECRET, '') });

    it('S2S ownership snapshot stays mounted for svc-trade placeOrder gate', async () => {
      expect((await app.inject({ method: 'GET', url: `/internal/sub-accounts/${SUB_A}` })).statusCode).toBe(401);
      const unknown = await signed(`/internal/sub-accounts/${UNKNOWN}`);
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toMatchObject({ code: 'identity.sub_account_not_found' });
      const owned = await signed(`/internal/sub-accounts/${SUB_A}`);
      expect(owned.statusCode).toBe(200);
      expect(owned.json()).toMatchObject({ id: SUB_A, parentUserId: OWNER, revoked: false });
    });

    it('S2S API key ownership snapshot stays mounted for the place gate', async () => {
      expect((await app.inject({ method: 'GET', url: `${API_KEY_OWNERSHIP_PATH}/${UNKNOWN}` })).statusCode).toBe(401);
      const unknown = await signed(`${API_KEY_OWNERSHIP_PATH}/${UNKNOWN}`);
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toMatchObject({ code: 'identity.api_key_not_found' });
    });

    it('S2S session ownership snapshot stays mounted for the place gate', async () => {
      expect((await app.inject({ method: 'GET', url: `/internal/sessions/${UNKNOWN}` })).statusCode).toBe(401);
      const unknown = await signed(`/internal/sessions/${UNKNOWN}`);
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toMatchObject({ code: 'identity.session_not_found' });
    });
  });

  it('ledger transfer recipe remains the only identity.sub_account.transfer journal shape', () => {
    const post = recipes.subAccountTransfer({
      transferId: 't-1',
      fromSubAccountId: SUB_A,
      toSubAccountId: SUB_B,
      assetId: 'USDT',
      amount: 5n,
    });
    expect(post.reason).toBe('identity.sub_account.transfer');
    expect(post.idempotencyKey).toBe('identity.sub_account.transfer:t-1');
    // Both legs are the two partitions' available pots — never a user, house or hold account.
    expect(post.entries.map((e) => e.account)).toEqual(
      expect.arrayContaining([subAccountAvailable(SUB_A, 'USDT'), subAccountAvailable(SUB_B, 'USDT')]),
    );
    for (const entry of post.entries) {
      expect(entry.account).toMatchObject({ ownerType: 'subaccount', kind: 'available' });
      expect([SUB_A, SUB_B]).toContain(entry.account.ownerId);
    }
    expect(() =>
      recipes.subAccountTransfer({ transferId: 't-2', fromSubAccountId: SUB_A, toSubAccountId: SUB_A, assetId: 'USDT', amount: 5n }),
    ).toThrow(/two different partitions/);
  });

  it('svc-trade placeOrder still consults identity ownership before storing the label', () => {
    // Placement lives in svc-trade's spot/trade-service/order-place.ts since its split by area.
    const trade = readFileSync(join(monorepo, 'services/svc-trade/src/spot/trade-service/order-place.ts'), 'utf8');
    const ownership = readFileSync(join(monorepo, 'services/svc-trade/src/spot/sub-account-ownership.ts'), 'utf8');
    expect(ownership).toMatch(/assertSubAccountOwned/);
    expect(ownership).toMatch(/\/internal\/sub-accounts\//);
    expect(trade).toMatch(/assertSubAccountOwned\((?:this|svc)\.subAccounts/);
  });
});
