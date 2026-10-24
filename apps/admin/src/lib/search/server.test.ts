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

afterEach(() => {
  reads.loadRead.mockReset();
  reads.ledger.mockReset();
  vi.unstubAllEnvs();
});

describe('cross-desk search fan-out', () => {
  it('a ledger that cannot answer refuses only its own section; identity’s answer still shows', async () => {
    reads.loadRead.mockImplementation(async (_ctx: unknown, spec: { id: string }) => ({
      id: spec.id,
      asOf: '2026-10-24T07:00:00.000Z',
      part: { kind: 'ok', data: { shape: 'list', rows: [], pageFull: false, nextCursor: null } },
    }));
    reads.ledger.mockResolvedValue({ ok: false, code: 'admin.upstream_unavailable', status: 503 });
    const answer = await crossSearch(founder as never, searchPlan('ana@example.com'));
    expect(answer.ledger).toMatchObject({ kind: 'lookup', outcome: { ok: false, code: 'admin.upstream_unavailable' } });
    expect(answer.accounts).toMatchObject({ kind: 'search', outcome: { part: { kind: 'ok' } } });
    expect(answer.payments).toMatchObject({ kind: 'not-asked' });
  });

  it('identity and svc-bank failing leave the ledger’s transaction on the page', async () => {
    reads.loadRead.mockImplementation(async (_ctx: unknown, spec: { id: string }) => failed(spec.id));
    reads.ledger.mockResolvedValue({ ok: true, answer: { found: false, businessKey: 'deposit:x:abcdefgh' } });
    const answer = await crossSearch(founder as never, searchPlan('deposit:x:abcdefgh'));
    expect(answer.ledger).toMatchObject({ kind: 'lookup', outcome: { ok: true } });
    expect(answer.payments).toMatchObject({ kind: 'transfer', outcome: { part: { kind: 'failed' } } });
    expect(reads.loadRead).toHaveBeenCalledWith(
      founder,
      expect.objectContaining({ id: 'pay.transfer-detail', input: { id: 'deposit:x:abcdefgh' } }),
    );
  });

  it('a module switched off on this console is not asked, and its section says so', async () => {
    vi.stubEnv('ADMIN_MODULES', 'accounts');
    reads.loadRead.mockImplementation(async (_ctx: unknown, spec: { id: string }) => failed(spec.id));
    const answer = await crossSearch(founder as never, searchPlan('deposit:x:abcdefgh'));
    expect(answer.ledger).toEqual({ kind: 'module-off', module: 'ledger' });
    expect(answer.payments).toEqual({ kind: 'module-off', module: 'pay-ops' });
    expect(reads.ledger).not.toHaveBeenCalled();
  });
});
