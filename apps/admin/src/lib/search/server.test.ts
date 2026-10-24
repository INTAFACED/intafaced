import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchPlan } from './cross-search';

vi.mock('server-only', () => ({}));
const reads = vi.hoisted(() => ({ loadRead: vi.fn(), ledger: vi.fn() }));
vi.mock('@/lib/ops-desk/server', () => ({ loadRead: reads.loadRead }));
vi.mock('@/lib/ledger/lookup-server', () => ({ readLedgerLookup: reads.ledger }));

const { crossSearch } = await import('./server');

const founder = {
  session: { userId: '11111111-1111-4111-8111-111111111111', accessToken: 't', refreshToken: 'r', expiresAt: '', issuedAt: '', csrf: '' },
  config: { origin: 'https://admin.example', edgeUrl: 'http://edge:4000', key: Buffer.alloc(32, 1) },
};
const failed = (id: string) => ({ id, asOf: '2026-10-24T07:00:00.000Z', part: { kind: 'failed', message: 'down', code: null } });
const empty = (id: string) => ({
  id,
  asOf: '2026-10-24T07:00:00.000Z',
  part: { kind: 'ok', data: { shape: 'list', rows: [], pageFull: false, nextCursor: null } },
});

afterEach(() => {
  reads.loadRead.mockReset();
  reads.ledger.mockReset();
  vi.unstubAllEnvs();
});

describe('cross-desk search fan-out', () => {
  it('a ledger that cannot answer refuses only its own section; identity’s answer still shows', async () => {
    reads.loadRead.mockImplementation(async (_ctx: unknown, spec: { id: string }) => empty(spec.id));
    reads.ledger.mockResolvedValue({ ok: false, code: 'admin.upstream_unavailable', status: 503 });
    const answer = await crossSearch(founder as never, searchPlan('pgq_deposit'));
    expect(answer.ledger).toMatchObject({ kind: 'lookup', outcome: { ok: false, code: 'admin.upstream_unavailable' } });
    expect(answer.accounts).toMatchObject({ kind: 'search', outcome: { part: { kind: 'ok' } } });
  });

  it('identity failing leaves the ledger’s answer on the page, and no transfer record is read with the search', async () => {
    reads.loadRead.mockImplementation(async (_ctx: unknown, spec: { id: string }) => failed(spec.id));
    reads.ledger.mockResolvedValue({ ok: true, answer: { found: false, businessKey: 'pgq_deposit' } });
    const answer = await crossSearch(founder as never, searchPlan('pgq_deposit'));
    expect(answer.accounts).toMatchObject({ kind: 'search', outcome: { part: { kind: 'failed' } } });
    expect(answer.ledger).toMatchObject({ kind: 'lookup', outcome: { ok: true } });
    // svc-bank logs every transfer record it hands out, so the search only offers it; the page reads it on a click.
    expect(answer.payments).toEqual({ kind: 'transfer', id: 'pgq_deposit' });
    expect(reads.loadRead).toHaveBeenCalledTimes(1);
  });

  it('a UUID opens the customer record without an identity read and looks the transaction up by id', async () => {
    reads.ledger.mockResolvedValue({ ok: false, code: 'ledger.tx_not_found', status: 404 });
    const id = '33333333-3333-4333-8333-333333333333';
    const answer = await crossSearch(founder as never, searchPlan(id));
    expect(answer.accounts).toEqual({ kind: 'record', userId: id });
    expect(reads.ledger).toHaveBeenCalledWith(founder, { txId: id });
    expect(reads.loadRead).not.toHaveBeenCalled();
  });

  it('an email is searched by identity only: the ledger is never sent it', async () => {
    reads.loadRead.mockImplementation(async (_ctx: unknown, spec: { id: string }) => empty(spec.id));
    const answer = await crossSearch(founder as never, searchPlan('ana@example.com'));
    expect(answer.ledger).toMatchObject({ kind: 'not-asked' });
    expect(answer.payments).toMatchObject({ kind: 'not-asked' });
    expect(reads.ledger).not.toHaveBeenCalled();
  });

  it('a module switched off on this console is not asked, and its section says so', async () => {
    vi.stubEnv('ADMIN_MODULES', 'accounts');
    reads.loadRead.mockImplementation(async (_ctx: unknown, spec: { id: string }) => failed(spec.id));
    const answer = await crossSearch(founder as never, searchPlan('deposit:x:abcdefgh'));
    expect(answer.ledger).toEqual({ kind: 'module-off', module: 'ledger' });
    expect(answer.payments).toEqual({ kind: 'module-off', module: 'pay-ops' });
    expect(reads.ledger).not.toHaveBeenCalled();
    vi.stubEnv('ADMIN_MODULES', 'ledger');
    reads.ledger.mockResolvedValue({ ok: true, answer: { found: false, businessKey: 'pgq' } });
    expect((await crossSearch(founder as never, searchPlan('pgq'))).accounts).toEqual({ kind: 'module-off', module: 'accounts' });
    expect(reads.loadRead).not.toHaveBeenCalled();
  });
});
