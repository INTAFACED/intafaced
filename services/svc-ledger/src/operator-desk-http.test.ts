import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { issueAccessToken } from '@intafaced/auth';
import { LOOKUP_INPUT_INVALID, LOOKUP_UNAVAILABLE, LOOKUP_UNRECORDED, registerOperatorHttp } from './operator-http.js';
import { stubApprovalConsumer } from './ledger/action-approval-consume.js';
import {
  operatorAccountSearch,
  operatorTxList,
  type DeskReader,
  type OperatorAccountSearchInput,
  type OperatorTxListInput,
} from './ledger/operator-desk.js';
import type { LookupActor } from './ledger/operator-lookup.js';
import type { OperatorAccessEntry } from './ledger/operator-owner-balances.js';
import type { LedgerService } from './service.js';

/**
 * The ledger desk's browsing doors on the operator port (OPS-ledger-desk-01, J-ops-console-03 #1, #4, #5): the
 * transaction list, the account address search and the counts. The lookups' authority (a founder's admin:read with a
 * second factor); the list and the search write an access row before anything is read; the counts name no one.
 */

const tokens = { secret: 'a-ledger-desk-test-secret-long-enough!', issuer: 'intafaced', audience: 'intafaced.api', accessTtlSeconds: 900 };
const OPERATOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONFIRM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TX = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';

async function bearer(scopes: string[], mfa = true): Promise<string> {
  const { token } = await issueAccessToken(
    { userId: OPERATOR, sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', scopes, tier: 'basic', mfa },
    tokens,
  );
  return `Bearer ${token}`;
}

/** TEST figures only: a fake book that answers one page of each read and keeps the access rows and reads. */
async function desk(opts: { failAccess?: boolean; failRead?: boolean } = {}) {
  const access: OperatorAccessEntry[] = [];
  const lists: OperatorTxListInput[] = [];
  const searches: OperatorAccountSearchInput[] = [];
  const fail = () => {
    if (opts.failRead) throw new Error('connection terminated: secret-host:5432');
  };
  const reader: DeskReader = {
    recordOperatorAccess: async (entry: OperatorAccessEntry) => {
      if (opts.failAccess) throw new Error('access log down');
      access.push(entry);
    },
    readTransactionPage: async (input: OperatorTxListInput) => {
      lists.push(input);
      fail();
      return {
        total: '51',
        rows: [
          {
            txId: TX,
            seq: '51',
            businessKey: 'deposit:local-test:TEST-1',
            module: 'svc-wallet',
            reason: 'deposit.credit',
            postedAt: '2026-10-24T12:00:00.000Z',
            assets: ['USDT'],
            postings: '2',
          },
        ],
        nextCursor: '51',
      };
    },
    readAccountPage: async (input: OperatorAccountSearchInput) => {
      searches.push(input);
      fail();
      return {
        prefix: input.prefix,
        accounts: [
          {
            accountId: ACCOUNT,
            address: 'house:fees:trade',
            ownerType: 'house' as const,
            ownerId: 'fees:trade',
            assetId: 'USDT',
            kind: 'available',
            purpose: '',
            debits: '3.5',
            credits: '1',
            balance: '2.5',
            postings: '3',
          },
        ],
        nextCursor: null,
      };
    },
  };
  // The service records inside its desk reads; this fake does the same through the real recorded wrappers.
  const ledger = {
    deskTransactions: (actor: LookupActor, input: OperatorTxListInput) => operatorTxList(reader, actor, input),
    deskAccounts: (actor: LookupActor, input: OperatorAccountSearchInput) => operatorAccountSearch(reader, actor, input),
    readOperatorStats: async () => {
      fail();
      return {
        transactions: '51',
        postings: '102',
        accounts: '9',
        assets: '2',
        lastSeq: '51',
        lastPostedAt: '2026-10-24T12:00:00.000Z',
        asOf: '2026-10-24T12:01:00.000Z',
      };
    },
  } as unknown as LedgerService;
  const app: FastifyInstance = Fastify({ logger: false });
  registerOperatorHttp(app, ledger, tokens, stubApprovalConsumer(CONFIRM));
  await app.ready();
  return { app, access, lists, searches };
}

describe('GET /operator/transactions', () => {
  it('answers a page with the ledger’s total and a cursor, after recording the filters under the founder', async () => {
    const { app, access, lists } = await desk();
    const res = await app.inject({
      method: 'GET',
      url: '/operator/transactions?assetId=USDT&from=2026-10-24T00:00:00Z&to=2026-10-25T00:00:00Z&before=99&ignored=x',
      headers: { authorization: await bearer(['admin:read']) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: '51', nextCursor: '51', rows: [{ txId: TX, postings: '2' }] });
    expect(lists).toEqual([{ assetId: 'USDT', from: '2026-10-24T00:00:00Z', to: '2026-10-25T00:00:00Z', before: '99' }]);
    expect(access).toEqual([
      {
        actorId: OPERATOR,
        requestId: expect.any(String),
        ownerType: 'transactions',
        ownerId: 'asset=USDT from=2026-10-24T00:00:00Z to=2026-10-25T00:00:00Z before=99',
        action: 'transactions.list',
      },
    ]);
    await app.close();
  });

  it('lists with no filter, and treats an empty filter as none', async () => {
    const { app, lists } = await desk();
    const res = await app.inject({
      method: 'GET',
      url: '/operator/transactions?assetId=&from=',
      headers: { authorization: await bearer(['admin:read']) },
    });
    expect(res.statusCode).toBe(200);
    expect(lists).toEqual([{}]);
    await app.close();
  });

  it('refuses an inverted window, a time that is not ISO 8601 and a cursor it never gave, before recording or reading', async () => {
    const { app, access, lists } = await desk();
    const authorization = await bearer(['admin:read']);
    for (const url of [
      '/operator/transactions?from=2026-10-25T00:00:00Z&to=2026-10-24T00:00:00Z',
      '/operator/transactions?from=yesterday',
      '/operator/transactions?before=0',
      '/operator/transactions?before=-1',
      '/operator/transactions?before=9223372036854775808',
      `/operator/transactions?assetId=${'X'.repeat(33)}`,
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: { authorization } });
      expect(res.statusCode, url).toBe(400);
      expect(res.json()).toMatchObject({ code: LOOKUP_INPUT_INVALID });
    }
    expect(access).toHaveLength(0);
    expect(lists).toHaveLength(0);
    await app.close();
  });
});

describe('GET /operator/accounts', () => {
  it('answers volumes and the derived balance as decimal strings, after recording the prefix', async () => {
    const { app, access, searches } = await desk();
    const res = await app.inject({
      method: 'GET',
      url: '/operator/accounts?prefix=house%3Afees',
      headers: { authorization: await bearer(['admin:read']) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      prefix: 'house:fees',
      accounts: [{ address: 'house:fees:trade', debits: '3.5', credits: '1', balance: '2.5' }],
    });
    expect(searches).toEqual([{ prefix: 'house:fees' }]);
    expect(access).toEqual([
      { actorId: OPERATOR, requestId: expect.any(String), ownerType: 'address_prefix', ownerId: 'house:fees', action: 'accounts.search' },
    ]);
    await app.close();
  });

  it('refuses a prefix without a whole owner type and one character of owner id, and a cursor that is not an account', async () => {
    const { app, access, searches } = await desk();
    const authorization = await bearer(['admin:read']);
    for (const url of [
      '/operator/accounts',
      '/operator/accounts?prefix=house',
      '/operator/accounts?prefix=house%3A',
      '/operator/accounts?prefix=hou%3Afees',
      '/operator/accounts?prefix=%25%3Ax',
      `/operator/accounts?prefix=user%3A${'a'.repeat(129)}`,
      '/operator/accounts?prefix=house%3Afees&after=not-an-id',
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: { authorization } });
      expect(res.statusCode, url).toBe(400);
      expect(res.json()).toMatchObject({ code: LOOKUP_INPUT_INVALID });
    }
    expect(access).toHaveLength(0);
    expect(searches).toHaveLength(0);
    await app.close();
  });
});

describe('GET /operator/stats', () => {
  it('answers the ledger’s counts and writes no access row', async () => {
    const { app, access } = await desk();
    const res = await app.inject({ method: 'GET', url: '/operator/stats', headers: { authorization: await bearer(['admin:read']) } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      transactions: '51',
      postings: '102',
      accounts: '9',
      assets: '2',
      lastSeq: '51',
      lastPostedAt: '2026-10-24T12:00:00.000Z',
      asOf: '2026-10-24T12:01:00.000Z',
    });
    expect(access).toHaveLength(0);
    await app.close();
  });
});

describe('the desk doors refuse', () => {
  const urls = ['/operator/transactions', '/operator/accounts?prefix=house%3Afees', '/operator/stats'];

  it('no credential, a sign-in without a second factor, and a scope that is not a read of the book, reading nothing', async () => {
    const { app, access, lists, searches } = await desk();
    for (const url of urls) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
      expect(
        (await app.inject({ method: 'GET', url, headers: { authorization: await bearer(['admin:read'], false) } })).statusCode,
        url,
      ).toBe(401);
      expect((await app.inject({ method: 'GET', url, headers: { authorization: await bearer(['ledger:read']) } })).statusCode, url).toBe(
        403,
      );
    }
    expect(access).toHaveLength(0);
    expect(lists).toHaveLength(0);
    expect(searches).toHaveLength(0);
    await app.close();
  });

  it('a page whose access row cannot be written, reading nothing', async () => {
    const { app, lists, searches } = await desk({ failAccess: true });
    const authorization = await bearer(['admin:read']);
    for (const url of urls.slice(0, 2)) {
      const res = await app.inject({ method: 'GET', url, headers: { authorization } });
      expect(res.statusCode, url).toBe(503);
      expect(res.json()).toMatchObject({ code: LOOKUP_UNRECORDED });
    }
    expect(lists).toHaveLength(0);
    expect(searches).toHaveLength(0);
    await app.close();
  });

  it('a read the ledger cannot answer with 503 and a fixed message, never the driver text', async () => {
    const { app } = await desk({ failRead: true });
    const authorization = await bearer(['admin:read']);
    for (const url of urls) {
      const res = await app.inject({ method: 'GET', url, headers: { authorization } });
      expect(res.statusCode, url).toBe(503);
      expect(res.json()).toMatchObject({ code: LOOKUP_UNAVAILABLE });
      expect(res.body).not.toContain('secret-host');
    }
    await app.close();
  });
});
