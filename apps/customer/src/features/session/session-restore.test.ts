import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionController, createSessionRefresher, mapRefreshResult, requestLogout, type LockManagerLike } from './session-restore';

const USER = '11111111-1111-4111-8111-111111111111';
const SECRET = 'rt-secret-that-must-never-reach-the-page';
type Call = { url: string; init: RequestInit };

const session = (token: string, expiresInMs = 900_000) => ({
  userId: USER,
  accessToken: token,
  expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
});
const ok = (data: unknown) => new Response(JSON.stringify({ result: { data } }), { status: 200 });
const refusal = (status: number, code: string) =>
  new Response(JSON.stringify({ error: { message: code, data: { intafacedCode: code } } }), { status });

function fakeFetch(answer: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return answer(call, calls.length);
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}
/** A Web Locks stand-in shared by several "tabs": exclusive, first come first served. */
function fakeLocks() {
  let tail: Promise<unknown> = Promise.resolve();
  const names: string[] = [];
  const manager: LockManagerLike = {
    request(name, callback) {
      names.push(name);
      const run = tail.then(callback, callback);
      tail = run.catch(() => undefined);
      return run as never;
    },
  };
  return { manager, names };
}
const headers = (call: Call) => (call.init.headers ?? {}) as Record<string, string>;

describe('boot refresh request', () => {
  it('posts to identity auth.refresh with credentials included, an empty body and no bearer', async () => {
    const { calls, fetcher } = fakeFetch(() => ok(session('a1')));
    const outcome = await createSessionRefresher({ fetch: fetcher, locks: null }).refresh();
    expect(outcome).toMatchObject({ kind: 'session', session: { accessToken: 'a1', userId: USER } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/identity/trpc/auth.refresh');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.credentials).toBe('include');
    expect(calls[0]!.init.body).toBe('{}');
    expect(headers(calls[0]!).authorization).toBeUndefined();
  });
  it('ignores a refreshToken in the reply: it is not in the session object', async () => {
    const { fetcher } = fakeFetch(() => ok({ ...session('a1'), refreshToken: SECRET }));
    const outcome = await createSessionRefresher({ fetch: fetcher, locks: null }).refresh();
    expect(outcome.kind).toBe('session');
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
    if (outcome.kind === 'session') expect('refreshToken' in outcome.session).toBe(false);
  });
});

describe('refresh error mapping', () => {
  const cases: Array<[string, () => Response | Promise<Response>, string]> = [
    ['401 auth.session_invalid', () => refusal(401, 'auth.session_invalid'), 'signed_out'],
    ['401 auth.session_reused', () => refusal(401, 'auth.session_reused'), 'signed_out'],
    ['403 edge.origin_not_allowed', () => refusal(403, 'edge.origin_not_allowed'), 'signed_out'],
    ['403 auth.account_frozen', () => refusal(403, 'auth.account_frozen'), 'signed_out'],
    ['503 gateway', () => new Response('', { status: 503 }), 'unavailable'],
    ['500 with body', () => refusal(500, 'internal'), 'unavailable'],
    ['network failure', () => Promise.reject(new TypeError('offline')), 'unavailable'],
    ['200 with the wrong shape', () => ok({ hello: 'world' }), 'unavailable'],
    ['200 without the tRPC envelope', () => new Response(JSON.stringify(session('x')), { status: 200 }), 'unavailable'],
  ];
  for (const [label, answer, kind] of cases)
    it(label + ' is ' + kind, async () => {
      const { fetcher } = fakeFetch(answer);
      expect((await createSessionRefresher({ fetch: fetcher, locks: null }).refresh()).kind).toBe(kind);
    });
  it('carries the service code for a refusal', async () => {
    const { fetcher } = fakeFetch(() => refusal(401, 'auth.session_reused'));
    expect(await createSessionRefresher({ fetch: fetcher, locks: null }).refresh()).toEqual({
      kind: 'signed_out',
      code: 'auth.session_reused',
    });
  });
  it('treats an unreadable expiry as no answer, not as a session', () => {
    expect(mapRefreshResult({ ok: true, data: { ...session('a'), expiresAt: 'nonsense' } })).toEqual({ kind: 'unavailable' });
  });
});

describe('single flight', () => {
  it('shares one request between callers in the same tab, then allows a new one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { calls, fetcher } = fakeFetch(async (_call, n) => {
      await gate;
      return ok(session('t' + n));
    });
    const refresher = createSessionRefresher({ fetch: fetcher, locks: null });
    const first = refresher.refresh();
    const second = refresher.refresh();
    release();
    expect(await first).toBe(await second);
    expect(calls).toHaveLength(1);
    await refresher.refresh();
    expect(calls).toHaveLength(2);
  });
  it('serialises two tabs through one Web Lock so their requests never overlap', async () => {
    const { manager, names } = fakeLocks();
    let active = 0,
      peak = 0;
    const { calls, fetcher } = fakeFetch(async (_call, n) => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return ok(session('tab' + n));
    });
    const tabA = createSessionRefresher({ fetch: fetcher, locks: manager });
    const tabB = createSessionRefresher({ fetch: fetcher, locks: manager });
    const outcomes = await Promise.all([tabA.refresh(), tabB.refresh()]);
    expect(outcomes.map((o) => o.kind)).toEqual(['session', 'session']);
    expect(calls).toHaveLength(2);
    expect(peak).toBe(1);
    expect(new Set(names)).toEqual(new Set(['ifc-session-refresh']));
  });
  it('still refreshes once where Web Locks is missing', async () => {
    const { calls, fetcher } = fakeFetch(() => ok(session('a')));
    const refresher = createSessionRefresher({ fetch: fetcher, locks: null });
    await Promise.all([refresher.refresh(), refresher.refresh()]);
    expect(calls).toHaveLength(1);
  });
  it('falls back to a direct refresh when the lock cannot be taken, and never runs twice', async () => {
    const blocked: LockManagerLike = { request: () => Promise.reject(new DOMException('denied', 'SecurityError')) };
    const { calls, fetcher } = fakeFetch(() => ok(session('a')));
    expect((await createSessionRefresher({ fetch: fetcher, locks: blocked }).refresh()).kind).toBe('session');
    expect(calls).toHaveLength(1);
    const late: LockManagerLike = {
      request: async (_name, callback) => {
        await callback();
        throw new Error('lock released badly');
      },
    };
    const again = fakeFetch(() => ok(session('b')));
    expect((await createSessionRefresher({ fetch: again.fetcher, locks: late }).refresh()).kind).toBe('unavailable');
    expect(again.calls).toHaveLength(1);
  });
});

describe('session controller', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  function build(
    answer: (call: Call, n: number) => Response | Promise<Response>,
    logout = vi.fn(async () => ({ ok: true as const, data: { ok: true as const } })),
  ) {
    const net = fakeFetch(answer);
    const controller = createSessionController({ refresher: createSessionRefresher({ fetch: net.fetcher, locks: null }), logout });
    return { ...net, controller, logout };
  }

  it('starts restoring, and a valid cookie becomes an in-memory session', async () => {
    const { controller, calls } = build(() => ok(session('boot')));
    expect(controller.getState()).toEqual({ session: null, restoring: true });
    await controller.start();
    expect(controller.getState().restoring).toBe(false);
    expect(controller.getState().session?.accessToken).toBe('boot');
    expect(calls).toHaveLength(1);
    controller.stop();
  });
  it('runs the boot refresh once however often it is started (StrictMode mounts twice)', async () => {
    const { controller, calls } = build(() => ok(session('boot')));
    await Promise.all([controller.start(), controller.start()]);
    expect(calls).toHaveLength(1);
    controller.stop();
  });
  it.each([
    ['session_invalid', () => refusal(401, 'auth.session_invalid')],
    ['session_reused', () => refusal(401, 'auth.session_reused')],
    ['403', () => refusal(403, 'edge.origin_not_allowed')],
    ['outage', () => new Response('', { status: 503 })],
  ])('boot %s ends signed out without a session and stops waiting', async (_label, answer) => {
    const { controller } = build(answer);
    await controller.start();
    expect(controller.getState()).toEqual({ session: null, restoring: false });
    controller.stop();
  });
  it('a sign-in during the boot refresh wins over the late answer', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { controller } = build(async () => {
      await gate;
      return ok(session('late-cookie-session'));
    });
    const booting = controller.start();
    controller.commit(session('typed-password'));
    release();
    await booting;
    expect(controller.getState().session?.accessToken).toBe('typed-password');
    controller.stop();
  });
  it('a logout during the boot refresh is not undone by the late answer', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { controller } = build(async () => {
      await gate;
      return ok(session('late'));
    });
    const booting = controller.start();
    controller.clear();
    release();
    await booting;
    expect(controller.getState()).toEqual({ session: null, restoring: false });
    controller.stop();
  });
  it('refreshes silently 30 seconds before the access token expires, with the cookie only', async () => {
    const { controller, calls } = build((_call, n) => ok(session('t' + n, 900_000)));
    await controller.start();
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(900_000 - 30_000 - 1_000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.init.body).toBe('{}');
    expect(calls[1]!.init.credentials).toBe('include');
    expect(controller.getState().session?.accessToken).toBe('t2');
    controller.stop();
  });
  it('silent refresh that the server refuses signs the user out; an outage keeps the session and retries', async () => {
    const refused = build((_call, n) => (n === 1 ? ok(session('t1', 60_000)) : refusal(401, 'auth.session_invalid')));
    await refused.controller.start();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(refused.controller.getState().session).toBeNull();
    refused.controller.stop();

    const outage = build((_call, n) =>
      n === 1 ? ok(session('t1', 60_000)) : n === 2 ? new Response('', { status: 503 }) : ok(session('t3', 900_000)),
    );
    await outage.controller.start();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(outage.calls).toHaveLength(2);
    expect(outage.controller.getState().session?.accessToken).toBe('t1');
    await vi.advanceTimersByTimeAsync(10_500);
    expect(outage.calls).toHaveLength(3);
    expect(outage.controller.getState().session?.accessToken).toBe('t3');
    outage.controller.stop();
  });
  it('stops the silent refresh once stopped or signed out', async () => {
    const { controller, calls } = build((_call, n) => ok(session('t' + n, 60_000)));
    await controller.start();
    controller.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toHaveLength(1);
  });
  it('logout clears memory at once, then asks the server with the cookie so it can be cleared', async () => {
    const { controller, logout } = build(() => ok(session('boot')));
    await controller.start();
    const seen: Array<string | undefined> = [];
    controller.subscribe(() => seen.push(controller.getState().session?.accessToken));
    const result = await controller.logout();
    expect(result.ok).toBe(true);
    expect(logout).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toEqual({ session: null, restoring: false });
    expect(seen).toEqual([undefined]);
    controller.stop();
  });
  it('logout waits for a refresh already in flight, so a late Set-Cookie cannot undo the clear', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const order: string[] = [];
    const logout = vi.fn(async () => {
      order.push('logout');
      return { ok: true as const, data: { ok: true as const } };
    });
    const { controller } = build(async (_call, n) => {
      if (n === 1) return ok(session('t1', 60_000));
      await gate;
      order.push('refresh-settled');
      return ok(session('t2'));
    }, logout);
    await controller.start();
    await vi.advanceTimersByTimeAsync(31_000);
    const leaving = controller.logout();
    await Promise.resolve();
    expect(logout).not.toHaveBeenCalled();
    release();
    await leaving;
    expect(order).toEqual(['refresh-settled', 'logout']);
    expect(controller.getState().session).toBeNull();
    controller.stop();
  });
  it('logout with no session does not call the server', async () => {
    const { controller, logout } = build(() => refusal(401, 'auth.session_invalid'));
    await controller.start();
    expect((await controller.logout()).ok).toBe(true);
    expect(logout).not.toHaveBeenCalled();
    controller.stop();
  });
  it('never writes to localStorage or sessionStorage, and never logs, while restoring or refreshing', async () => {
    const writes: string[] = [];
    const storage = {
      getItem: () => null,
      setItem: (k: string) => void writes.push(k),
      removeItem: () => undefined,
      clear: () => undefined,
    };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('sessionStorage', storage);
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const { controller } = build((_call, n) => ok({ ...session('t' + n, 60_000), refreshToken: SECRET }));
    await controller.start();
    await vi.advanceTimersByTimeAsync(31_000);
    await controller.logout();
    expect(writes).toEqual([]);
    expect(JSON.stringify(controller.getState())).not.toContain(SECRET);
    for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
    controller.stop();
    logs.forEach((spy) => spy.mockRestore());
  });
});

describe('logout request', () => {
  it('posts auth.logout with credentials included and an empty body', async () => {
    const { calls, fetcher } = fakeFetch(() => ok({ ok: true }));
    expect(await requestLogout({ fetch: fetcher })).toEqual({ ok: true, data: { ok: true } });
    expect(calls[0]!.url).toBe('/api/identity/trpc/auth.logout');
    expect(calls[0]!.init.credentials).toBe('include');
    expect(calls[0]!.init.body).toBe('{}');
    expect(headers(calls[0]!).authorization).toBeUndefined();
  });
});
