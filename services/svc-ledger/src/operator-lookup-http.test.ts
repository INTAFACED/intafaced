import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { issueAccessToken } from '@intafaced/auth';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { LOOKUP_INPUT_INVALID, LOOKUP_UNAVAILABLE, LOOKUP_UNRECORDED, registerOperatorHttp } from './operator-http.js';
import { stubApprovalConsumer } from './ledger/action-approval-consume.js';
import type { OperatorAccessEntry } from './ledger/operator-owner-balances.js';
import type { LedgerService } from './service.js';

/**
 * The object lookup on the operator port (OPS-rules-monitoring-12): one transaction by id, or the one a business key
 * booked. Treasury scope, or a founder's admin:read, with a second factor; an access row written before anything is read, and honest misses.
 */

const tokens = { secret: 'a-ledger-lookup-test-secret-long-enough', issuer: 'intafaced', audience: 'intafaced.api', accessTtlSeconds: 900 };
const OPERATOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONFIRM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

async function bearer(scopes: string[], mfa = true): Promise<string> {
  const { token } = await issueAccessToken(
    { userId: OPERATOR, sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', scopes, tier: 'basic', mfa },
    tokens,
  );
  return `Bearer ${token}`;
}

/** TEST amounts only. A memory book with one deposit, and the access rows the routes wrote. */
async function seeded(opts: { failAccess?: boolean; failRead?: boolean; lie?: boolean } = {}) {
  const book = new MemoryLedger();
  const deposit = recipes.deposit({ userId: USER, assetId: 'USDT', amount: parseAmount('10.5'), rail: 'test', railRef: 'lookup-1' });
  const tx = await book.post(deposit);
  const access: OperatorAccessEntry[] = [];
  let reads = 0;
  const ledger = {
    recordOperatorAccess: async (entry: OperatorAccessEntry) => {
      if (opts.failAccess) throw new Error('access log down');
      access.push(entry);
    },
    getTx: async (id: string) => {
      reads += 1;
      if (opts.failRead) throw new Error('connection terminated: secret-host:5432');
      return book.getTx(id);
    },
    getTxByKey: async (key: string) => {
      reads += 1;
      if (opts.failRead) throw new Error('connection terminated: secret-host:5432');
      return opts.lie ? book.getTx(tx.id) : book.getTxByKey(key);
    },
  } as unknown as LedgerService;
  const app: FastifyInstance = Fastify({ logger: false });
  registerOperatorHttp(app, ledger, tokens, stubApprovalConsumer(CONFIRM));
  await app.ready();
  return { app, deposit, tx, access, reads: () => reads };
}

describe('GET /operator/transactions/:txId', () => {
  it('answers one transaction with its postings as decimal strings, after writing an access row', async () => {
    const { app, tx, deposit, access } = await seeded();
    const res = await app.inject({
      method: 'GET',
      url: `/operator/transactions/${tx.id}`,
      headers: { authorization: await bearer(['admin:treasury']) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ txId: tx.id, businessKey: deposit.idempotencyKey, module: deposit.module, hash: tx.hash });
    expect(body.postings.map((p: { amount: string }) => p.amount)).toContain('10.5');
    expect(access).toEqual([
      { actorId: OPERATOR, ownerType: 'transaction', ownerId: tx.id, requestId: expect.any(String), action: 'transaction.read' },
    ]);
    await app.close();
  });

  it('answers 404 ledger.tx_not_found for an id with no transaction, still recorded', async () => {
    const { app, access } = await seeded();
    const id = '99999999-9999-4999-8999-999999999999';
    const res = await app.inject({
      method: 'GET',
      url: `/operator/transactions/${id}`,
      headers: { authorization: await bearer(['admin:treasury']) },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'ledger.tx_not_found' });
    expect(access).toHaveLength(1);
    await app.close();
  });

  it('refuses an id that is not a UUID before recording or reading', async () => {
    const { app, access, reads } = await seeded();
    const res = await app.inject({
      method: 'GET',
      url: '/operator/transactions/not-a-uuid',
      headers: { authorization: await bearer(['admin:treasury']) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: LOOKUP_INPUT_INVALID });
    expect(access).toHaveLength(0);
    expect(reads()).toBe(0);
    await app.close();
  });

  it('refuses the lookup when its access row cannot be written, and reads nothing', async () => {
    const { app, tx, reads } = await seeded({ failAccess: true });
    const res = await app.inject({
      method: 'GET',
      url: `/operator/transactions/${tx.id}`,
      headers: { authorization: await bearer(['admin:treasury']) },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: LOOKUP_UNRECORDED });
    expect(res.body).not.toContain(tx.hash);
    expect(reads()).toBe(0);
    await app.close();
  });
});

describe('GET /operator/trace', () => {
  it('traces a business key to its transaction, after writing an access row', async () => {
    const { app, tx, deposit, access } = await seeded();
    const url = `/operator/trace?businessKey=${encodeURIComponent(deposit.idempotencyKey)}`;
    const res = await app.inject({ method: 'GET', url, headers: { authorization: await bearer(['admin:treasury']) } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ found: true, businessKey: deposit.idempotencyKey, txId: tx.id });
    expect(access).toEqual([
      {
        actorId: OPERATOR,
        ownerType: 'business_key',
        ownerId: deposit.idempotencyKey,
        requestId: expect.any(String),
        action: 'trace.read',
      },
    ]);
    await app.close();
  });

  it('answers found:false for a key that never booked', async () => {
    const { app } = await seeded();
    const res = await app.inject({
      method: 'GET',
      url: '/operator/trace?businessKey=never%3Abooked%3A1',
      headers: { authorization: await bearer(['admin:treasury']) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ found: false, businessKey: 'never:booked:1' });
    await app.close();
  });

  it('refuses a missing, blank or over-long key before recording or reading', async () => {
    const { app, access, reads } = await seeded();
    const auth = { authorization: await bearer(['admin:treasury']) };
    for (const url of ['/operator/trace', '/operator/trace?businessKey=%20%20', `/operator/trace?businessKey=${'k'.repeat(513)}`]) {
      const res = await app.inject({ method: 'GET', url, headers: auth });
      expect(res.statusCode, url).toBe(400);
      expect(res.json()).toMatchObject({ code: LOOKUP_INPUT_INVALID });
    }
    expect(access).toHaveLength(0);
    expect(reads()).toBe(0);
    await app.close();
  });

  it('refuses the trace when its access row cannot be written, and reads nothing', async () => {
    const { app, deposit, reads } = await seeded({ failAccess: true });
    const url = `/operator/trace?businessKey=${encodeURIComponent(deposit.idempotencyKey)}`;
    const res = await app.inject({ method: 'GET', url, headers: { authorization: await bearer(['admin:treasury']) } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: LOOKUP_UNRECORDED });
    expect(reads()).toBe(0);
    await app.close();
  });
});

describe('a recorded lookup the ledger cannot answer', () => {
  it('is 503 lookup_unavailable with a fixed message, never a 400 and never the driver text', async () => {
    const { app, tx, deposit, access } = await seeded({ failRead: true });
    const auth = { authorization: await bearer(['admin:treasury']) };
    for (const url of [`/operator/transactions/${tx.id}`, `/operator/trace?businessKey=${encodeURIComponent(deposit.idempotencyKey)}`]) {
      const res = await app.inject({ method: 'GET', url, headers: auth });
      expect(res.statusCode, url).toBe(503);
      expect(res.json()).toMatchObject({ code: LOOKUP_UNAVAILABLE });
      expect(res.body).not.toContain('secret-host');
    }
    expect(access).toHaveLength(2);
    await app.close();
  });

  it('refuses a trace the book answered with a transaction booked under another key (500, typed)', async () => {
    const { app, tx } = await seeded({ lie: true });
    const res = await app.inject({
      method: 'GET',
      url: '/operator/trace?businessKey=other%3Akey',
      headers: { authorization: await bearer(['admin:treasury']) },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: 'ledger.trace_inconsistent' });
    expect(res.body).not.toContain(tx.hash);
    await app.close();
  });
});

describe('who may look up', () => {
  it('refuses no credential, treasury without a second factor, and a scope that is neither, recording and reading nothing', async () => {
    const { app, tx, deposit, access, reads } = await seeded();
    const urls = [`/operator/transactions/${tx.id}`, `/operator/trace?businessKey=${encodeURIComponent(deposit.idempotencyKey)}`];
    for (const url of urls) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      expect(
        (await app.inject({ method: 'GET', url, headers: { authorization: await bearer(['admin:treasury'], false) } })).statusCode,
      ).toBe(401);
      expect(
        (await app.inject({ method: 'GET', url, headers: { authorization: await bearer(['ledger:read', 'market:ops']) } })).statusCode,
      ).toBe(403);
    }
    expect(access).toHaveLength(0);
    expect(reads()).toBe(0);
    await app.close();
  });

  it('takes a founder sign-in with admin:read and a second factor, and records the lookup under that founder', async () => {
    const { app, tx, deposit, access } = await seeded();
    const authorization = await bearer(['admin:read']);
    const byId = await app.inject({ method: 'GET', url: `/operator/transactions/${tx.id}`, headers: { authorization } });
    expect(byId.statusCode).toBe(200);
    expect(byId.json()).toMatchObject({ txId: tx.id });
    const byKey = await app.inject({
      method: 'GET',
      url: `/operator/trace?businessKey=${encodeURIComponent(deposit.idempotencyKey)}`,
      headers: { authorization },
    });
    expect(byKey.statusCode).toBe(200);
    expect(access.map((row) => [row.actorId, row.action])).toEqual([
      [OPERATOR, 'transaction.read'],
      [OPERATOR, 'trace.read'],
    ]);
    await app.close();
  });

  it('refuses admin:read without a second factor, or on an API key, recording and reading nothing', async () => {
    const { app, tx, access, reads } = await seeded();
    const url = `/operator/transactions/${tx.id}`;
    const noMfa = await app.inject({ method: 'GET', url, headers: { authorization: await bearer(['admin:read'], false) } });
    expect(noMfa.statusCode).toBe(401);
    expect(noMfa.json().code).toBe('mfa.required');
    const { token } = await issueAccessToken(
      {
        userId: OPERATOR,
        sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        scopes: ['admin:read'],
        tier: 'basic',
        mfa: true,
        apiKeyId: 'ifc_key',
      },
      tokens,
    );
    const key = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
    expect(key.statusCode).toBe(401);
    expect(key.json().code).toBe('scope.interactive_only');
    expect(access).toHaveLength(0);
    expect(reads()).toBe(0);
    await app.close();
  });

  it('keeps every other operator route on admin:treasury: admin:read with a second factor cannot freeze or read the freeze', async () => {
    const { app } = await seeded();
    const authorization = await bearer(['admin:read']);
    expect((await app.inject({ method: 'GET', url: '/operator/freeze', headers: { authorization } })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/freeze',
          headers: { authorization },
          payload: { reason: 'a founder trying to halt with a read scope', confirmOperatorId: CONFIRM },
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/operator/assets', headers: { authorization } })).statusCode).toBe(403);
    await app.close();
  });
});
