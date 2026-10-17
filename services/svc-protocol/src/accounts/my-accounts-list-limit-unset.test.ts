/**
 * Unit card — myAccounts refuses unpublished page size (never invent 50 / all.length)
 *
 * 1. Promise: omit / null / NaN / inf / 0 / negative / garbage throws
 *    protocol.my_accounts_list_limit_unset. Owner-explicit 50 still pages.
 * 2. Break: myAccounts with no page size dumps every smart account for the caller.
 * 3. Done bar: unset throws MyAccountsListLimitUnsetError; 50 is allowed; cap 200
 * 4. Class N
 * 5. Paths: my-accounts-list-limit.ts, registry.ts, postgres-store.ts, router.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import {
  assertMyAccountsListLimit,
  MY_ACCOUNTS_LIST_LIMIT_CAP,
  MyAccountsListLimitUnsetError,
  PROTOCOL_MY_ACCOUNTS_LIST_LIMIT_UNSET,
} from './my-accounts-list-limit.js';
import { AccountRegistry, MemoryAccountStore } from './registry.js';
import { createProtocolRouter } from '../router.js';
import type { ProtocolRouterDeps } from '../router.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = 'a-protocol-my-accounts-list-limit-test-edge-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const CHAIN_ID = 31337;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const FACTORY = '0x2222222222222222222222222222222222222222' as Address;
const IMPLEMENTATION = '0x3333333333333333333333333333333333333333' as Address;

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-protocol' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['protocol:read'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signed(p: Principal = principal()) {
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-signed',
  });
}

function stubDeps(overrides: Partial<Record<string, unknown>> = {}): ProtocolRouterDeps {
  return {
    chain: {
      config: { chainId: CHAIN_ID, factory: ZERO, implementation: ZERO },
      isDeployed: async () => false,
    },
    registry: { accountsOf: async () => [] },
    relay: {
      buildDeployment: () => ({
        to: FACTORY,
        data: '0xdead',
        value: 0n,
        summary: 'deploy',
      }),
    },
    relayEnabled: () => true,
    ammFactoryAddress: () => ZERO,
    swapSlippageBps: () => null,
    ...overrides,
  } as unknown as ProtocolRouterDeps;
}

describe('assertMyAccountsListLimit', () => {
  it('refuses unset / null / NaN / inf / 0 / negative / garbage — never invents 50', () => {
    for (const limit of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1, '50', {}, []]) {
      expect(() => assertMyAccountsListLimit(limit)).toThrow(MyAccountsListLimitUnsetError);
    }
    try {
      assertMyAccountsListLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(MyAccountsListLimitUnsetError);
      expect((e as MyAccountsListLimitUnsetError).code).toBe(PROTOCOL_MY_ACCOUNTS_LIST_LIMIT_UNSET);
      expect((e as MyAccountsListLimitUnsetError).message).toMatch(/never invent 50/);
      expect((e as MyAccountsListLimitUnsetError).message).not.toMatch(/default 50|50-row|all\.length/i);
    }
  });

  it('owner-explicit 50 is allowed and caps at 200', () => {
    expect(assertMyAccountsListLimit(50)).toBe(50);
    expect(assertMyAccountsListLimit(1)).toBe(1);
    expect(assertMyAccountsListLimit(MY_ACCOUNTS_LIST_LIMIT_CAP)).toBe(MY_ACCOUNTS_LIST_LIMIT_CAP);
    expect(assertMyAccountsListLimit(MY_ACCOUNTS_LIST_LIMIT_CAP + 1)).toBe(MY_ACCOUNTS_LIST_LIMIT_CAP);
  });
});

describe('myAccounts limit unset refuse', () => {
  it('router does not dump accounts when myAccounts omits limit', () => {
    const src = readFileSync(join(HERE, '../router.ts'), 'utf8');
    const start = src.indexOf('myAccounts: scopedProcedure');
    const end = src.indexOf('amm: router({', start);
    const fn = src.slice(start, end === -1 ? undefined : end);
    expect(fn).toContain('assertMyAccountsListLimit(input?.limit)');
    expect(fn).toContain('limit: z.number().int().min(1).max(MY_ACCOUNTS_LIST_LIMIT_CAP).optional()');
    expect(fn).toContain('.optional()');
    expect(fn).not.toMatch(/\?\? 50/);
    expect(fn).not.toMatch(/limit = 50/);
    expect(fn).not.toMatch(/\.default\(/);
    expect(fn).not.toMatch(/accountsOf\(ctx\.principal\.userId\)\s*;/);
    expect(fn).toContain('registry.accountsOf(ctx.principal.userId, limit)');
  });

  it('postgres findByUser applies SQL LIMIT on the public door', () => {
    const src = readFileSync(join(HERE, '../db/postgres-store.ts'), 'utf8');
    const start = src.indexOf('async findByUser');
    const end = src.indexOf('async findByAddress', start);
    const fn = src.slice(start, end === -1 ? undefined : end);
    expect(fn).toContain('assertMyAccountsListLimit(limit)');
    expect(fn).toContain('.limit(published)');
    expect(fn).not.toMatch(/all\.length/);
    expect(fn).not.toMatch(/\?\? 50/);
  });

  it('omit / empty input refuses PRECONDITION_FAILED — never dumps both accounts', async () => {
    const store = new MemoryAccountStore();
    const registry = new AccountRegistry(store, { chainId: CHAIN_ID, factory: FACTORY, implementation: IMPLEMENTATION });
    await store.upsert({
      userId: USER,
      chainId: CHAIN_ID,
      address: '0x1111111111111111111111111111111111111111',
      owner: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      userSalt: `0x${'00'.repeat(32)}` as Hex,
      deployed: false,
      verifiedAt: new Date(),
    });
    await store.upsert({
      userId: USER,
      chainId: CHAIN_ID,
      address: '0x2222222222222222222222222222222222222222',
      owner: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      userSalt: `0x${'00'.repeat(31)}01` as Hex,
      deployed: false,
      verifiedAt: new Date(),
    });
    await store.upsert({
      userId: USER,
      chainId: CHAIN_ID,
      address: '0x3333333333333333333333333333333333333333',
      owner: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      userSalt: `0x${'00'.repeat(31)}02` as Hex,
      deployed: false,
      verifiedAt: new Date(),
    });

    const caller = createProtocolRouter(stubDeps({ registry })).createCaller(signed());

    await expect(caller.myAccounts()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(PROTOCOL_MY_ACCOUNTS_LIST_LIMIT_UNSET),
    });
    await expect(caller.myAccounts({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('never invent 50'),
    });

    const page = await caller.myAccounts({ limit: 2 });
    expect(page).toHaveLength(2);

    const explicit50 = await caller.myAccounts({ limit: 50 });
    expect(explicit50).toHaveLength(3);
  });

  it('empty accounts with a published limit is [] — empty is not a failure', async () => {
    const store = new MemoryAccountStore();
    const registry = new AccountRegistry(store, { chainId: CHAIN_ID, factory: FACTORY, implementation: IMPLEMENTATION });
    const caller = createProtocolRouter(stubDeps({ registry })).createCaller(signed());
    await expect(caller.myAccounts({ limit: 50 })).resolves.toEqual([]);
  });

  it('MemoryAccountStore.findByUser refuses unset and slices a published window', async () => {
    const store = new MemoryAccountStore();
    await store.upsert({
      userId: USER,
      chainId: CHAIN_ID,
      address: '0x1111111111111111111111111111111111111111',
      owner: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      userSalt: `0x${'00'.repeat(32)}` as Hex,
      deployed: false,
      verifiedAt: null,
    });
    await store.upsert({
      userId: USER,
      chainId: CHAIN_ID,
      address: '0x2222222222222222222222222222222222222222',
      owner: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      userSalt: `0x${'00'.repeat(31)}01` as Hex,
      deployed: false,
      verifiedAt: null,
    });
    await store.upsert({
      userId: USER,
      chainId: CHAIN_ID,
      address: '0x3333333333333333333333333333333333333333',
      owner: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      userSalt: `0x${'00'.repeat(31)}02` as Hex,
      deployed: false,
      verifiedAt: null,
    });

    await expect(store.findByUser(USER, CHAIN_ID, undefined as unknown as number)).rejects.toMatchObject({
      code: PROTOCOL_MY_ACCOUNTS_LIST_LIMIT_UNSET,
    });
    await expect(store.findByUser(USER, CHAIN_ID, 2)).resolves.toHaveLength(2);
  });
});
