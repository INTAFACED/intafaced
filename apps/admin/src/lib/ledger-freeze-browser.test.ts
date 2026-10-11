import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const authenticatedTransport = (upstream: (url: string, init?: RequestInit) => Promise<Response>) => (url: string, init?: RequestInit) =>
  url === '/api/session' ? Promise.resolve(Response.json({ csrf: 'A'.repeat(43) })) : upstream(url, init);
const state = { frozen: false, reason: null, actor: 'reconciliation', changedAt: '2026-10-09T16:00:00.000Z' };
const envelope = { ok: true, status: 200, kind: 'reachable', state, detail: null };
beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
});
describe('browser GET and original helper guard', () => {
  it('GET is no-store, abortable, and rejects unreadable/missing state', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('not JSON', { status: 200 }));
    vi.stubGlobal('fetch', authenticatedTransport(fetchMock));
    const { fetchFreeze } = await import('./ledger-freeze-browser');
    const result = await fetchFreeze(new AbortController().signal);
    expect(result).toMatchObject({ kind: 'invalid_response', state: null });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store', signal: expect.any(AbortSignal) });
  });
  it('preserves original private input and prevents replay after timeout, later GET, and a different next input', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw Error('isolated timeout');
      return Response.json(envelope);
    });
    vi.stubGlobal('fetch', authenticatedTransport(fetchMock));
    const { postFreeze, fetchFreeze } = await import('./ledger-freeze-browser');
    const input = { frozen: true, reason: 'Original reason <script>opaque</script> & Δ' };
    const result = await postFreeze(input);
    input.reason = 'Mutated after dispatch';
    expect(result).toMatchObject({ uncertain: true, intent: { frozen: true, reason: 'Original reason <script>opaque</script> & Δ' } });
    expect(Object.isFrozen(result.intent)).toBe(true);
    expect((await fetchFreeze()).state).toEqual(state);
    expect(await postFreeze({ frozen: false })).toBe(result);
    expect(fetchMock.mock.calls.filter((x) => x[1]?.method === 'POST')).toHaveLength(1);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual(result.intent);
  });
  it('blocks a concurrent second input before the first response', async () => {
    let done!: (r: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((r) => {
          done = r;
        }),
    );
    vi.stubGlobal('fetch', authenticatedTransport(fetchMock));
    const { postFreeze } = await import('./ledger-freeze-browser');
    const first = postFreeze({ frozen: true, reason: 'Original pending incident' });
    const second = await postFreeze({ frozen: false });
    expect(second.intent).toEqual({ frozen: true, reason: 'Original pending incident' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    done(Response.json({ ok: false, code: 'action_approval.missing' }));
    const unresolved = await first;
    expect(unresolved.uncertain).toBe(true);
    expect(await postFreeze({ frozen: false })).toBe(unresolved);
  });
  it('valid HTTP200 standing state still locks original request; no substituted requested state', async () => {
    const fetchMock = vi.fn(async () => Response.json({ returnedState: state }));
    vi.stubGlobal('fetch', authenticatedTransport(fetchMock));
    const { postFreeze } = await import('./ledger-freeze-browser');
    const result = await postFreeze({ frozen: true, reason: 'Original request incident' });
    expect(result).toMatchObject({ uncertain: true, state: null, returnedState: state });
    expect(await postFreeze({ frozen: false })).toBe(result);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('an exact BFF pre-dispatch refusal can release helper guard without replaying automatically', async () => {
    const fetchMock = vi.fn(async () => Response.json({ code: 'admin.bff_gate', error: 'Gate refused' }, { status: 401 }));
    vi.stubGlobal('fetch', authenticatedTransport(fetchMock));
    const { postFreeze } = await import('./ledger-freeze-browser');
    expect((await postFreeze({ frozen: false })).uncertain).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await postFreeze({ frozen: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
