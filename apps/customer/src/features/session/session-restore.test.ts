import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REFRESH_RETRY_MS,
  REFRESH_TIMEOUT_MS,
  createSessionController,
  createSessionRefresher,
  mapRefreshResult,
  requestLogout,
  type ChannelLike,
  type LockManagerLike,
} from './session-restore';

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
    const outcome = await createSessionRefresher({ fetch: fetcher, locks: null, retryDelayMs: 0 }).refresh();
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
    const outcome = await createSessionRefresher({ fetch: fetcher, locks: null, retryDelayMs: 0 }).refresh();
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
    ['400 from an identity service without cookie refresh', () => refusal(400, 'BAD_REQUEST'), 'refused'],
    ['404 no route', () => refusal(404, 'edge.no_route'), 'refused'],
    ['501 not supported', () => refusal(501, 'NOT_IMPLEMENTED'), 'refused'],
    ['429 rate limited', () => refusal(429, 'TOO_MANY_REQUESTS'), 'unavailable'],
    ['425 too early', () => new Response('', { status: 425 }), 'unavailable'],
    ['408 request timeout', () => new Response('', { status: 408 }), 'unavailable'],
    ['503 gateway', () => new Response('', { status: 503 }), 'unavailable'],
    ['500 with body', () => refusal(500, 'internal'), 'unavailable'],
    ['network failure', () => Promise.reject(new TypeError('offline')), 'unavailable'],
    ['200 with the wrong shape', () => ok({ hello: 'world' }), 'unavailable'],
    ['200 without the tRPC envelope', () => new Response(JSON.stringify(session('x')), { status: 200 }), 'unavailable'],
  ];
  for (const [label, answer, kind] of cases)
    it(label + ' is ' + kind, async () => {
      const { fetcher } = fakeFetch(answer);
      expect((await createSessionRefresher({ fetch: fetcher, locks: null, retryDelayMs: 0 }).refresh()).kind).toBe(kind);
    });
  it('carries the service code for a refusal', async () => {
    const { fetcher } = fakeFetch(() => refusal(401, 'auth.session_reused'));
    expect(await createSessionRefresher({ fetch: fetcher, locks: null, retryDelayMs: 0 }).refresh()).toEqual({
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
    const refresher = createSessionRefresher({ fetch: fetcher, locks: null, retryDelayMs: 0 });
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
    const tabA = createSessionRefresher({ fetch: fetcher, locks: manager, retryDelayMs: 0 });
    const tabB = createSessionRefresher({ fetch: fetcher, locks: manager, retryDelayMs: 0 });
    const outcomes = await Promise.all([tabA.refresh(), tabB.refresh()]);
    expect(outcomes.map((o) => o.kind)).toEqual(['session', 'session']);
    expect(calls).toHaveLength(2);
    expect(peak).toBe(1);
    expect(new Set(names)).toEqual(new Set(['ifc-session-refresh']));
  });
  it('still refreshes once where Web Locks is missing', async () => {
    const { calls, fetcher } = fakeFetch(() => ok(session('a')));
    const refresher = createSessionRefresher({ fetch: fetcher, locks: null, retryDelayMs: 0 });
    await Promise.all([refresher.refresh(), refresher.refresh()]);
    expect(calls).toHaveLength(1);
  });
  it('falls back to a direct refresh when the lock cannot be taken, and never runs twice', async () => {
    const blocked: LockManagerLike = { request: () => Promise.reject(new DOMException('denied', 'SecurityError')) };
    const { calls, fetcher } = fakeFetch(() => ok(session('a')));
    expect((await createSessionRefresher({ fetch: fetcher, locks: blocked, retryDelayMs: 0 }).refresh()).kind).toBe('session');
    expect(calls).toHaveLength(1);
    const late: LockManagerLike = {
      request: async (_name, callback) => {
        await callback();
        throw new Error('lock released badly');
      },
    };
    const again = fakeFetch(() => ok(session('b')));
    expect((await createSessionRefresher({ fetch: again.fetcher, locks: late, retryDelayMs: 0 }).refresh()).kind).toBe('unavailable');
    expect(again.calls).toHaveLength(1);
  });
});

describe('session controller', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  // retryDelayMs 0: the refresher's own in-grace retry is tested separately; here an outage costs exactly two calls.
  function build(
    answer: (call: Call, n: number) => Response | Promise<Response>,
    logout = vi.fn(async () => ({ ok: true as const, data: { ok: true as const } })),
  ) {
    const net = fakeFetch(answer);
    const controller = createSessionController({
      refresher: createSessionRefresher({ fetch: net.fetcher, locks: null, retryDelayMs: 0 }),
      logout,
      openChannel: () => null,
    });
    return { ...net, controller, logout };
  }

  it('starts restoring, and a valid cookie becomes an in-memory session', async () => {
    const { controller, calls } = build(() => ok(session('boot')));
    expect(controller.getState()).toEqual({ session: null, restoring: true, restoreFailed: false, notice: null });
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
  ])('boot %s ends signed out without a session and stops waiting', async (_label, answer) => {
    const { controller } = build(answer);
    await controller.start();
    expect(controller.getState()).toMatchObject({ session: null, restoring: false, restoreFailed: false });
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
    expect(controller.getState()).toMatchObject({ session: null, restoring: false });
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

    // One silent attempt = two calls (the refresher's own retry). Then the pauses grow: 5 s, 10 s, 20 s.
    const outage = build((_call, n) =>
      n === 1 ? ok(session('t1', 60_000)) : n <= 7 ? new Response('', { status: 503 }) : ok(session('t8', 900_000)),
    );
    await outage.controller.start();
    await vi.advanceTimersByTimeAsync(31_050);
    expect(outage.calls).toHaveLength(3);
    expect(outage.controller.getState().session?.accessToken).toBe('t1');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(outage.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(outage.calls).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(outage.calls).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(outage.calls).toHaveLength(7);
    await vi.advanceTimersByTimeAsync(18_000);
    expect(outage.calls).toHaveLength(7);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(outage.calls).toHaveLength(8);
    expect(outage.controller.getState().session?.accessToken).toBe('t8');
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
    expect(controller.getState()).toMatchObject({ session: null, restoring: false });
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

describe('lost reply recovery (server reuse grace is 10 s)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('gives up on a silent request after 5 s, not 15 s, and retries once 1.5 s later', async () => {
    expect([REFRESH_TIMEOUT_MS, REFRESH_RETRY_MS]).toEqual([5_000, 1_500]);
    const sent: number[] = [];
    const t0 = Date.now();
    const aborted: boolean[] = [];
    const fetcher = (async (_url: string, init: RequestInit) => {
      sent.push(Date.now() - t0);
      if (sent.length > 1) return ok(session('recovered'));
      return new Promise<Response>((_resolve, reject) =>
        init.signal?.addEventListener('abort', () => {
          aborted.push(true);
          reject(new DOMException('aborted', 'AbortError'));
        }),
      );
    }) as unknown as typeof fetch;
    const pending = createSessionRefresher({ fetch: fetcher, locks: null }).refresh();
    await vi.advanceTimersByTimeAsync(4_900);
    expect(aborted).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(aborted).toEqual([true]);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await pending).toMatchObject({ kind: 'session', session: { accessToken: 'recovered' } });
    expect(sent).toEqual([0, 6_500]);
    // 6.5 s after the first send: inside the 10 s grace.
    expect(sent[1]!).toBeLessThan(10_000);
  });
  it('retries only once per flight, and not after a definite answer', async () => {
    const down = fakeFetch(() => new Response('', { status: 503 }));
    const flight = createSessionRefresher({ fetch: down.fetcher, locks: null }).refresh();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await flight).toEqual({ kind: 'unavailable' });
    expect(down.calls).toHaveLength(2);
    const refused = fakeFetch(() => refusal(401, 'auth.session_invalid'));
    await createSessionRefresher({ fetch: refused.fetcher, locks: null }).refresh();
    expect(refused.calls).toHaveLength(1);
  });
});

describe('server-ended sessions and boot outages', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  function build(answer: (n: number) => Response) {
    const net = fakeFetch((_call, n) => answer(n));
    const controller = createSessionController({
      refresher: createSessionRefresher({ fetch: net.fetcher, locks: null, retryDelayMs: 0 }),
      openChannel: () => null,
    });
    return { ...net, controller };
  }
  it.each([
    ['auth.session_reused', 401, 'reused'],
    ['auth.account_frozen', 403, 'frozen'],
  ])('boot %s is surfaced as a notice', async (code, status, notice) => {
    const { controller } = build(() => refusal(status, code));
    await controller.start();
    expect(controller.getState()).toEqual({ session: null, restoring: false, restoreFailed: false, notice });
    controller.commit(session('signed-in-again'));
    expect(controller.getState().notice).toBeNull();
    controller.stop();
  });
  it('a definite refusal at boot (old identity answers 400) is signed out, not an outage, and is not retried', async () => {
    const { controller, calls } = build(() => refusal(400, 'BAD_REQUEST'));
    await controller.start();
    expect(controller.getState()).toEqual({ session: null, restoring: false, restoreFailed: false, notice: null });
    expect(calls).toHaveLength(1);
    controller.stop();
  });
  it('a definite refusal mid-session keeps the session and backs off, like an outage', async () => {
    const { controller, calls } = build((n) =>
      n === 1 ? ok(session('t1', 60_000)) : n <= 3 ? refusal(400, 'BAD_REQUEST') : ok(session('t4', 900_000)),
    );
    await controller.start();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(calls).toHaveLength(2);
    expect(controller.getState().session?.accessToken).toBe('t1');
    await vi.advanceTimersByTimeAsync(5_500);
    expect(calls).toHaveLength(3);
    expect(controller.getState().session?.accessToken).toBe('t1');
    await vi.advanceTimersByTimeAsync(10_500);
    expect(controller.getState().session?.accessToken).toBe('t4');
    controller.stop();
  });
  it('an ordinary session_invalid carries no notice', async () => {
    const { controller } = build(() => refusal(401, 'auth.session_invalid'));
    await controller.start();
    expect(controller.getState().notice).toBeNull();
    controller.stop();
  });
  it('a silent refresh answered with session_reused signs out with the notice', async () => {
    const { controller } = build((n) => (n === 1 ? ok(session('t1', 60_000)) : refusal(401, 'auth.session_reused')));
    await controller.start();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(controller.getState()).toMatchObject({ session: null, notice: 'reused' });
    controller.stop();
  });
  it('a boot outage keeps the cookie and offers Retry; Retry restores', async () => {
    const { controller, calls } = build((n) => (n <= 2 ? new Response('', { status: 503 }) : ok(session('back'))));
    await controller.start();
    expect(controller.getState()).toEqual({ session: null, restoring: false, restoreFailed: true, notice: null });
    const retrying = controller.retryRestore();
    expect(controller.getState()).toMatchObject({ restoring: true, restoreFailed: false });
    await retrying;
    expect(controller.getState().session?.accessToken).toBe('back');
    expect(calls).toHaveLength(3);
    controller.stop();
  });
});

describe('tabs talking over the session channel', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  /** BroadcastChannel stand-in: a message reaches every other open channel, never the sender. */
  function bus() {
    const open = new Set<ChannelLike>();
    return () => {
      const channel: ChannelLike = {
        onmessage: null,
        postMessage(message) {
          for (const other of open) if (other !== channel) other.onmessage?.({ data: message });
        },
        close() {
          open.delete(channel);
        },
      };
      open.add(channel);
      return channel;
    };
  }
  function tab(open: () => ChannelLike, answer: (n: number) => Response) {
    const net = fakeFetch((_call, n) => answer(n));
    const logout = vi.fn(async () => ({ ok: true as const, data: { ok: true as const } }));
    const controller = createSessionController({
      refresher: createSessionRefresher({ fetch: net.fetcher, locks: null, retryDelayMs: 0 }),
      logout,
      openChannel: open,
    });
    return { ...net, controller, logout };
  }
  it('logout in one tab signs the other tab out without a second server call', async () => {
    const open = bus();
    const a = tab(open, () => ok(session('a'))),
      b = tab(open, () => ok(session('b')));
    await Promise.all([a.controller.start(), b.controller.start()]);
    await a.controller.logout();
    expect(b.controller.getState().session).toBeNull();
    expect(a.logout).toHaveBeenCalledTimes(1);
    expect(b.logout).not.toHaveBeenCalled();
    a.controller.stop();
    b.controller.stop();
  });
  it('shares a rotated access token for the same user, so the other tab does not refresh itself', async () => {
    const open = bus();
    const a = tab(open, (n) => (n === 1 ? ok(session('a1', 60_000)) : ok(session('a2-rotated', 900_000))));
    const b = tab(open, () => refusal(401, 'auth.session_invalid'));
    b.controller.commit(session('b-own', 900_000));
    await Promise.all([a.controller.start(), b.controller.start()]);
    await vi.advanceTimersByTimeAsync(31_050);
    expect(a.controller.getState().session?.accessToken).toBe('a2-rotated');
    expect(b.controller.getState().session?.accessToken).toBe('a2-rotated');
    expect(b.calls).toHaveLength(0);
    a.controller.stop();
    b.controller.stop();
  });
  it('adopts a newer token for the same user and ignores another user, an older expiry and junk', async () => {
    const open = bus();
    const a = tab(open, () => ok(session('a', 900_000)));
    const outside = open();
    await a.controller.start();
    const send = (data: unknown) => outside.postMessage(data);
    send({ type: 'session', session: { ...session('stranger'), userId: '22222222-2222-4222-8222-222222222222' } });
    send({ type: 'session', session: session('older', 1_000) });
    send({ type: 'session', session: { accessToken: 'x' } });
    send({ type: 'nonsense' });
    send('text');
    expect(a.controller.getState().session?.accessToken).toBe('a');
    send({ type: 'session', session: session('newer', 1_800_000) });
    expect(a.controller.getState().session?.accessToken).toBe('newer');
    a.controller.stop();
  });
  it('does not broadcast a refresh token, and closes its channel on stop', async () => {
    const posted: unknown[] = [];
    let closed = false;
    const spy: ChannelLike = { onmessage: null, postMessage: (m) => void posted.push(m), close: () => void (closed = true) };
    const a = tab(
      () => spy,
      (n) => ok({ ...session('a' + n, 60_000), refreshToken: SECRET }),
    );
    await a.controller.start();
    await vi.advanceTimersByTimeAsync(31_000);
    await a.controller.logout();
    expect(posted.map((m) => (m as { type: string }).type)).toEqual(['session', 'logout']);
    expect(JSON.stringify(posted)).not.toContain(SECRET);
    a.controller.stop();
    expect(closed).toBe(true);
  });
});

describe('logout that the server did not confirm', () => {
  it('can be asked again, and reports the failure', async () => {
    const logout = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'unreachable', message: 'down' })
      .mockResolvedValueOnce({ ok: true, data: { ok: true } });
    const net = fakeFetch(() => ok(session('a')));
    const controller = createSessionController({
      refresher: createSessionRefresher({ fetch: net.fetcher, locks: null, retryDelayMs: 0 }),
      logout,
      openChannel: () => null,
    });
    await controller.start();
    expect((await controller.logout()).ok).toBe(false);
    expect(controller.getState().session).toBeNull();
    expect((await controller.retryLogout()).ok).toBe(true);
    expect(logout).toHaveBeenCalledTimes(2);
    controller.stop();
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
