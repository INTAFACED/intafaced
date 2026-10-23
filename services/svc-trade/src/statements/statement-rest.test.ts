/**
 * Ledger history and statement routes: what each answers, and how each refuses.
 *
 * Promise: the ledger page is the caller's own, with the limit and cursor they sent; a blank limit refuses rather than
 * inventing one; a statement refusal keeps its typed code and status; an unmounted door answers 503, never an empty list.
 */
import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyReply } from 'fastify';
import type { Principal } from '@intafaced/auth';
import type { LedgerPageRequest, LedgerPages } from './ledger-history.js';
import { STATEMENT_CODES, StatementError, type StatementExports } from './statement-export.js';
import { attachStatementRoutes, type StatementRestDeps } from './statement-rest.js';

const USER = '11111111-1111-4111-8111-111111111111';
const JOB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function principal(scopes = ['trade:read']): Principal {
  return { sub: USER, userId: USER, sid: 's', scopes, tier: 'basic', mfa: false, expiresAt: new Date(Date.now() + 60_000) } as Principal;
}

async function build(deps: StatementRestDeps | undefined, who: Principal | null = principal()) {
  const app = Fastify({ logger: false });
  attachStatementRoutes(app, deps, (_req, reply: FastifyReply) => {
    if (!who) void reply.code(401).send({ code: 'AuthenticationError' });
    return who;
  });
  await app.ready();
  return app;
}

function ledgerPages(seen: LedgerPageRequest[] = []): LedgerPages {
  return {
    async page(request) {
      seen.push(request);
      return {
        entries: [
          {
            entryId: '42',
            txId: 'tx-42',
            module: 'trade',
            reason: 'trade.fill',
            direction: 'debit',
            amount: '0.25',
            postedAt: new Date('2026-10-01T00:00:00.000Z'),
            assetId: 'BTC',
            orderId: null,
          },
        ],
        nextCursor: 'djIuNDI',
      };
    },
  };
}

const noExports = {} as StatementExports;

describe('GET /api/v1/ledger', () => {
  it('answers the caller’s page with the limit, asset and cursor they sent', async () => {
    const seen: LedgerPageRequest[] = [];
    const app = await build({ ledger: ledgerPages(seen), exports: noExports });
    const res = await app.inject({ method: 'GET', url: '/api/v1/ledger?limit=50&code=BTC&cursor=djIuNDM' });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual([{ userId: USER, limit: 50, assetId: 'BTC', cursor: 'djIuNDM' }]);
    expect(res.json()).toEqual({
      entries: [
        {
          id: '42',
          referenceId: 'tx-42',
          timestamp: Date.parse('2026-10-01T00:00:00.000Z'),
          datetime: '2026-10-01T00:00:00.000Z',
          currency: 'BTC',
          direction: 'in',
          amount: '0.25',
          type: 'trade.fill',
          module: 'trade',
          orderId: null,
        },
      ],
      nextCursor: 'djIuNDI',
    });
  });

  it('refuses a blank or out-of-range limit, a malformed asset or cursor, and a caller without trade:read', async () => {
    const app = await build({ ledger: ledgerPages(), exports: noExports });
    for (const q of ['', '?limit=', '?limit=0', '?limit=201', '?limit=1.5']) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/ledger${q}` });
      expect(res.statusCode, q).toBe(400);
      expect(res.json().intafacedCode).toBe('trade.ledger_limit_unset');
    }
    expect((await app.inject({ method: 'GET', url: '/api/v1/ledger?limit=5&code=btc!' })).json().intafacedCode).toBe(
      'trade.invalid_filter',
    );
    expect((await app.inject({ method: 'GET', url: '/api/v1/ledger?limit=5&cursor=a.b' })).json().intafacedCode).toBe(
      'trade.invalid_cursor',
    );
    const blind = await build({ ledger: ledgerPages(), exports: noExports }, principal([]));
    expect((await blind.inject({ method: 'GET', url: '/api/v1/ledger?limit=5' })).statusCode).toBe(403);
  });

  it('a cursor the ledger did not issue is a 400, and a ledger outage is an error, never an empty page', async () => {
    const refusing = (err: Error): LedgerPages => ({
      async page() {
        throw err;
      },
    });
    const forged = Object.assign(new Error('History cursor is not valid'), { code: 'ledger.history_cursor_invalid' });
    const app = await build({ ledger: refusing(forged), exports: noExports });
    const res = await app.inject({ method: 'GET', url: '/api/v1/ledger?limit=5&cursor=abc' });
    expect(res.statusCode).toBe(400);
    expect(res.json().intafacedCode).toBe('trade.invalid_cursor');
    const down = await build({ ledger: refusing(new Error('svc-ledger unreachable')), exports: noExports });
    expect((await down.inject({ method: 'GET', url: '/api/v1/ledger?limit=5' })).statusCode).toBe(500);
  });

  it('answers 503 when not mounted, and 401 without a principal', async () => {
    const app = await build(undefined);
    const res = await app.inject({ method: 'GET', url: '/api/v1/ledger?limit=5' });
    expect(res.statusCode).toBe(503);
    expect(res.json().intafacedCode).toBe('trade.statements_unmounted');
    const anon = await build({ ledger: ledgerPages(), exports: noExports }, null);
    expect((await anon.inject({ method: 'GET', url: '/api/v1/ledger?limit=5' })).statusCode).toBe(401);
  });
});

describe('statement routes', () => {
  const job = {
    id: JOB,
    requestKey: 'stmt-key-one',
    from: '2026-10-01T00:00:00.000Z',
    to: '2026-10-02T00:00:00.000Z',
    status: 'finished' as const,
    rows: { orders: 1, trades: 0, ledger: 2 },
    sha256: 'ab'.repeat(32),
    error: null,
    createdAt: '2026-10-20T12:00:00.000Z',
    finishedAt: '2026-10-20T12:00:00.000Z',
  };

  it('passes the request through and answers the job, then its file with the SHA-256', async () => {
    const asked: unknown[] = [];
    const exports = {
      request: async (_p: Principal, input: unknown) => {
        asked.push(input);
        return job;
      },
      get: async () => job,
      file: async () => ({ csv: 'record,id\n', sha256: job.sha256, filename: 'statement-2026-10-01-2026-10-02.csv' }),
    } as unknown as StatementExports;
    const app = await build({ ledger: ledgerPages(), exports });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/statements',
      payload: { from: job.from, to: job.to, requestKey: job.requestKey, extra: 'ignored' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(job);
    expect(asked).toEqual([{ from: job.from, to: job.to, requestKey: job.requestKey }]);
    expect((await app.inject({ method: 'GET', url: `/api/v1/statements/${JOB}` })).json()).toEqual(job);
    const file = await app.inject({ method: 'GET', url: `/api/v1/statements/${JOB}/file` });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(file.headers['content-disposition']).toBe('attachment; filename="statement-2026-10-01-2026-10-02.csv"');
    expect(file.headers['x-intafaced-sha256']).toBe(job.sha256);
    expect(file.headers['cache-control']).toBe('private, no-store');
    expect(file.body).toBe('record,id\n');
    const wrapped = await app.inject({ method: 'GET', url: `/api/v1/statements/${JOB}/file?as=json` });
    expect(wrapped.json()).toEqual({ filename: 'statement-2026-10-01-2026-10-02.csv', sha256: job.sha256, csv: 'record,id\n' });
    expect((await app.inject({ method: 'GET', url: `/api/v1/statements/${JOB}/file?as=pdf` })).statusCode).toBe(400);
  });

  it('keeps each refusal’s typed code and status', async () => {
    const refuse = (err: StatementError) => async () => {
      throw err;
    };
    const exports = {
      request: refuse(new StatementError('reused', STATEMENT_CODES.keyReused, 409)),
      get: refuse(new StatementError('none', STATEMENT_CODES.notFound, 404)),
      file: refuse(new StatementError('pending', STATEMENT_CODES.notFinished, 409)),
    } as unknown as StatementExports;
    const app = await build({ ledger: ledgerPages(), exports });
    const posted = await app.inject({ method: 'POST', url: '/api/v1/statements', payload: {} });
    expect([posted.statusCode, posted.json().intafacedCode]).toEqual([409, STATEMENT_CODES.keyReused]);
    const read = await app.inject({ method: 'GET', url: `/api/v1/statements/${JOB}` });
    expect([read.statusCode, read.json().intafacedCode]).toEqual([404, STATEMENT_CODES.notFound]);
    const file = await app.inject({ method: 'GET', url: `/api/v1/statements/${JOB}/file` });
    expect([file.statusCode, file.json().intafacedCode]).toEqual([409, STATEMENT_CODES.notFinished]);
    const unmounted = await build(undefined);
    expect((await unmounted.inject({ method: 'POST', url: '/api/v1/statements', payload: {} })).statusCode).toBe(503);
  });
});
