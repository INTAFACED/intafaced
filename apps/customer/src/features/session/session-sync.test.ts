import { describe, expect, it } from 'vitest';
import { createSessionSync, type SessionSync } from './session-sync';

/**
 * The browser side of "a reload keeps you signed in": cookie-only refresh, rotation, and several tabs.
 *
 * The stand-in edge keeps one cookie jar for the whole "browser" and models what matters about
 * svc-identity's `auth.refresh`: each refresh retires the token it was given, and a retired token
 * shown again revokes the whole family. The request reads the cookie when it is SENT, as a browser
 * does, which is what makes a simultaneous refresh from two tabs a real race here.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const tick = (ms = 3) => new Promise((resolve) => setTimeout(resolve, ms));
let counter = 0;
const token = (prefix: string) => `${prefix}-${++counter}-${Math.random().toString(36).slice(2)}`;

class FakeEdge {
  jar: string | null = null;
  live = new Map<string, string>();
  retired = new Map<string, string>();
  revokedFamilies = new Set<string>();
  refreshes = 0;
  reuseDetected = 0;
  logouts = 0;
  down = false;
  /** Answer every call 403 with this code (a region or network gate, or a session refusal). */
  forbid: string | null = null;
  /** Rotate on the server, then drop the answer on the floor (an aborted request). */
  loseNext = false;
  seen: Array<{ url: string; headers: Record<string, string> }> = [];

  /** A person signs in: the edge sets the cookie. Returns the session body the page gets. */
  signIn() {
    return this.mint(token('family'));
  }
  private mint(family: string) {
    const refresh = token('rt');
    this.live.set(refresh, family);
    this.jar = refresh;
    return { accessToken: token('at'), expiresAt: new Date(Date.now() + 900_000).toISOString(), userId: USER };
  }
  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const cookieAtSend = this.jar; // the browser attaches the cookie when it sends
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    this.seen.push({ url: String(url), headers });
    await tick();
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    const refusal = (code: string, status = 401) =>
      json(status, { error: { message: code, code: -32001, data: { code: 'UNAUTHORIZED', httpStatus: status, intafacedCode: code } } });
    if (this.down) return json(503, { error: 'down' });
    if (this.forbid) return refusal(this.forbid, 403);
    if (headers['x-session-request'] !== '1') return refusal('session.csrf_header_missing', 403);
    if (String(url).endsWith('/session/logout')) {
      this.logouts += 1;
      if (cookieAtSend) {
        const family = this.live.get(cookieAtSend);
        if (family) this.revokedFamilies.add(family);
      }
      this.jar = null;
      return json(200, { result: { data: { ok: true } } });
    }
    this.refreshes += 1;
    if (!cookieAtSend) return refusal('session.no_cookie');
    if (this.retired.has(cookieAtSend)) {
      this.reuseDetected += 1;
      this.revokedFamilies.add(this.retired.get(cookieAtSend)!);
      this.jar = null;
      return refusal('auth.session_reused');
    }
    const family = this.live.get(cookieAtSend);
    if (!family || this.revokedFamilies.has(family)) {
      this.jar = null;
      return refusal('auth.session_invalid');
    }
    this.live.delete(cookieAtSend);
    this.retired.set(cookieAtSend, family);
    const minted = this.mint(family);
    if (this.loseNext) {
      this.loseNext = false;
      throw new TypeError('aborted');
    }
    return json(200, { result: { data: minted } });
  };
}

/** One lock per name, granted in order: what navigator.locks gives tabs of one browser profile. */
function lockManager() {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    request<T>(_name: string, callback: () => Promise<T>): Promise<T> {
      const run = tail.then(callback, callback);
      tail = run.catch(() => undefined);
      return run;
    },
  };
}
/** BroadcastChannel stand-in: a message reaches every OTHER instance on the same name, asynchronously. */
function channelHub() {
  const members = new Set<{ onmessage: ((event: { data: unknown }) => void) | null }>();
  return (name: string) => {
    void name;
    const me = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage(data: unknown) {
        for (const other of members) if (other !== me) queueMicrotask(() => other.onmessage?.({ data: structuredClone(data) }));
      },
      close() {
        members.delete(me);
      },
    };
    members.add(me);
    return me;
  };
}
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

function browser(options: { tabs: number; coordinated?: boolean; edge?: FakeEdge; leaseOnly?: boolean }) {
  const edge = options.edge ?? new FakeEdge();
  const locks = lockManager();
  const hub = channelHub();
  const storage = memoryStorage();
  const tabs: SessionSync[] = Array.from({ length: options.tabs }, () =>
    createSessionSync({
      fetch: edge.fetch as typeof fetch,
      locks: options.coordinated === false || options.leaseOnly ? null : locks,
      channel: options.coordinated === false ? null : hub,
      // No lock, no channel and no shared storage: nothing for the lease fallback to use either.
      storage: () => (options.coordinated === false ? null : storage),
      peerWaitMs: 10,
    }),
  );
  return { edge, tabs, storage, hub };
}

describe('reload keeps you signed in', () => {
  it('a fresh page with only the cookie gets a session, and the cookie rotates', async () => {
    const { edge, tabs } = browser({ tabs: 1 });
    edge.signIn();
    const before = edge.jar;
    const outcome = await tabs[0]!.refresh();
    expect(outcome).toMatchObject({ kind: 'session', refreshed: true });
    expect(edge.jar).not.toBe(before);
    // Reload again, and again: still signed in.
    expect((await tabs[0]!.refresh()).kind).toBe('session');
    expect((await tabs[0]!.refresh()).kind).toBe('session');
    expect(edge.reuseDetected).toBe(0);
  });

  it('with no cookie the visitor is signed out, and the hint is cleared', async () => {
    const { tabs, storage } = browser({ tabs: 1 });
    storage.setItem('intafaced.customer.session-hint.v1', '1');
    expect((await tabs[0]!.refresh()).kind).toBe('signed-out');
    expect(tabs[0]!.mightBeSignedIn()).toBe(false);
  });

  it('a visitor who never signed in is not made to wait for a refresh', () => {
    const { tabs, edge } = browser({ tabs: 1 });
    expect(tabs[0]!.mightBeSignedIn()).toBe(false);
    expect(edge.refreshes).toBe(0);
  });

  it('an announced sign-in leaves the hint that makes the next load try the cookie', () => {
    const { tabs } = browser({ tabs: 1 });
    tabs[0]!.announce({ accessToken: 'a', expiresAt: new Date(Date.now() + 900_000).toISOString(), userId: USER });
    expect(tabs[0]!.mightBeSignedIn()).toBe(true);
  });

  it('storage that cannot be read still lets the page try', () => {
    const tab = createSessionSync({
      fetch: (async () => new Response('{}')) as typeof fetch,
      locks: null,
      channel: null,
      storage: () => {
        throw new Error('blocked');
      },
    });
    expect(tab.mightBeSignedIn()).toBe(true);
    expect(() => tab.announce({ accessToken: 'a', expiresAt: new Date(Date.now() + 900_000).toISOString(), userId: USER })).not.toThrow();
  });

  it('an outage is reported as unavailable and does not sign anyone out', async () => {
    const { edge, tabs } = browser({ tabs: 2 });
    edge.signIn();
    edge.down = true;
    expect((await tabs[0]!.refresh()).kind).toBe('unavailable');
    expect(edge.jar).not.toBeNull();
    edge.down = false;
    expect((await tabs[0]!.refresh()).kind).toBe('session');
  });
});

describe('a stolen access token cannot refresh', () => {
  it('the refresh request carries no bearer token and no refresh token in its body, only the cookie marker header', async () => {
    const { edge, tabs } = browser({ tabs: 1 });
    edge.signIn();
    await tabs[0]!.refresh();
    const sent = edge.seen[0]!;
    expect(sent.url).toBe('/api/identity/session/refresh');
    expect(sent.headers.authorization).toBeUndefined();
    expect(sent.headers['x-session-request']).toBe('1');
  });

  it('without the cookie the edge refuses, whatever the page holds', async () => {
    const { tabs } = browser({ tabs: 1 });
    tabs[0]!.announce({ accessToken: 'stolen-but-valid-looking', expiresAt: new Date(Date.now() + 900_000).toISOString(), userId: USER });
    expect((await tabs[0]!.refresh({ staleToken: 'stolen-but-valid-looking' })).kind).toBe('signed-out');
  });
});

describe('rotation reuse is detected, and honest tabs never trigger it', () => {
  it('a retired cookie shown again (a thief in another browser) is refused and reuse is counted', async () => {
    const { edge, tabs } = browser({ tabs: 1 });
    edge.signIn();
    const stale = edge.jar!;
    await tabs[0]!.refresh();
    const thief = createSessionSync({ fetch: edge.fetch as typeof fetch, locks: null, channel: null, storage: () => memoryStorage() });
    edge.jar = stale;
    expect((await thief.refresh()).kind).toBe('signed-out');
    expect(edge.reuseDetected).toBe(1);
    expect(edge.jar).toBeNull();
  });

  it('NEGATIVE CONTROL: two tabs with no coordination race, and identity revokes everything', async () => {
    const { edge, tabs } = browser({ tabs: 2, coordinated: false });
    edge.signIn();
    const outcomes = await Promise.all([tabs[0]!.refresh(), tabs[1]!.refresh()]);
    expect(edge.reuseDetected).toBe(1);
    expect(outcomes.map((o) => o.kind).sort()).toEqual(['session', 'signed-out']);
    // The winner's brand-new session is worthless too: the whole family is revoked.
    const winner = outcomes.find((o) => o.kind === 'session') as { session: { accessToken: string } };
    edge.jar = [...edge.live.keys()][0] ?? null;
    expect((await tabs[0]!.refresh({ staleToken: winner.session.accessToken })).kind).toBe('signed-out');
  });
});

describe('two tabs do not race', () => {
  it('both tabs loading at once cause ONE rotation and both end up signed in with the same session', async () => {
    const { edge, tabs } = browser({ tabs: 2 });
    edge.signIn();
    const outcomes = await Promise.all([tabs[0]!.refresh(), tabs[1]!.refresh()]);
    await tick();
    expect(edge.refreshes).toBe(1);
    expect(edge.reuseDetected).toBe(0);
    expect(outcomes.map((o) => o.kind)).toEqual(['session', 'session']);
    const [a, b] = outcomes as [{ session: { accessToken: string } }, { session: { accessToken: string } }];
    expect(a.session.accessToken).toBe(b.session.accessToken);
  });

  it('five tabs and a StrictMode double call still cause one rotation', async () => {
    const { edge, tabs } = browser({ tabs: 5 });
    edge.signIn();
    const calls = tabs.flatMap((tab) => [tab.refresh(), tab.refresh()]);
    const outcomes = await Promise.all(calls);
    expect(edge.refreshes).toBe(1);
    expect(edge.reuseDetected).toBe(0);
    expect(outcomes.every((o) => o.kind === 'session')).toBe(true);
  });

  it('a tab whose timer fires after another tab refreshed adopts that session instead of rotating again', async () => {
    const { edge, tabs } = browser({ tabs: 2 });
    const first = edge.signIn();
    tabs[0]!.announce(first);
    tabs[1]!.announce(first);
    await tick();
    // Tab 0 renews first.
    const renewed = await tabs[0]!.refresh({ staleToken: first.accessToken });
    await tick();
    expect(renewed).toMatchObject({ kind: 'session', refreshed: true });
    const callsBefore = edge.refreshes;
    // Tab 1's own timer now fires with the token it still holds.
    const adopted = await tabs[1]!.refresh({ staleToken: first.accessToken });
    expect(adopted).toMatchObject({ kind: 'session', refreshed: false });
    expect((adopted as { session: { accessToken: string } }).session.accessToken).toBe(
      (renewed as { session: { accessToken: string } }).session.accessToken,
    );
    expect(edge.refreshes).toBe(callsBefore);
    expect(edge.reuseDetected).toBe(0);
  });

  it('other tabs hear a sign-in and the rotated session', async () => {
    const { edge, tabs } = browser({ tabs: 2 });
    edge.signIn();
    const heard: Array<{ type: string; token?: string }> = [];
    tabs[1]!.subscribe((m) => heard.push({ type: m.type, ...(m.type === 'session' ? { token: m.session.accessToken } : {}) }));
    const outcome = (await tabs[0]!.refresh()) as { session: { accessToken: string } };
    await tick();
    expect(heard).toEqual([{ type: 'session', token: outcome.session.accessToken }]);
  });

  it('ignores a malformed message instead of trusting it', async () => {
    const { tabs, hub } = browser({ tabs: 1 });
    const heard: string[] = [];
    tabs[0]!.subscribe((m) => heard.push(m.type));
    const stranger = hub('same-name');
    stranger.postMessage({ type: 'session', session: { accessToken: '', expiresAt: 'soon', userId: 'nobody' } });
    stranger.postMessage({ type: 'something-else' });
    stranger.postMessage('text');
    await tick();
    expect(heard).toEqual([]);
  });
});

describe('logout', () => {
  it('revokes at the edge, clears the cookie, signs the other tabs out, and the old cookie is worthless', async () => {
    const { edge, tabs, storage } = browser({ tabs: 2 });
    edge.signIn();
    await tabs[0]!.refresh();
    const cookie = edge.jar!;
    const heard: string[] = [];
    tabs[1]!.subscribe((m) => heard.push(m.type));
    const result = await tabs[0]!.logout();
    await tick();
    expect(result).toEqual({ ok: true, data: { ok: true } });
    expect(edge.logouts).toBe(1);
    expect(edge.jar).toBeNull();
    expect(heard).toEqual(['signed-out']);
    expect(storage.getItem('intafaced.customer.session-hint.v1')).toBeNull();
    // A copy of the cookie someone kept is dead.
    edge.jar = cookie;
    expect((await tabs[1]!.refresh()).kind).toBe('signed-out');
  });

  it('works with nothing in memory (after a reload the cookie is all the page has)', async () => {
    const { edge, tabs } = browser({ tabs: 1 });
    edge.signIn();
    await tabs[0]!.logout();
    expect(edge.logouts).toBe(1);
    expect(edge.jar).toBeNull();
  });

  it('reports an unconfirmed revocation when the edge is down so the app can say so', async () => {
    const { edge, tabs } = browser({ tabs: 1 });
    edge.signIn();
    edge.down = true;
    expect((await tabs[0]!.logout()).ok).toBe(false);
  });
});

describe('refusals that are not about the session do not sign anyone out', () => {
  it('a 403 from a region or network gate leaves the hint, the cookie and the other tabs alone', async () => {
    const { edge, tabs, storage } = browser({ tabs: 2 });
    edge.signIn();
    storage.setItem('intafaced.customer.session-hint.v1', '1');
    const heard: string[] = [];
    tabs[1]!.subscribe((m) => heard.push(m.type));
    edge.forbid = 'edge.geo_blocked';
    expect((await tabs[0]!.refresh()).kind).toBe('unavailable');
    await tick();
    expect(heard).toEqual([]);
    expect(tabs[0]!.mightBeSignedIn()).toBe(true);
    expect(edge.jar).not.toBeNull();
  });

  it('a 403 that names the session does sign out', async () => {
    const { edge, tabs } = browser({ tabs: 1 });
    edge.signIn();
    edge.forbid = 'session.cross_site';
    expect((await tabs[0]!.refresh()).kind).toBe('signed-out');
  });

  it('a response lost after rotation is reported as unavailable, not as a sign-out', async () => {
    const { edge, tabs } = browser({ tabs: 1 });
    edge.signIn();
    edge.loseNext = true;
    expect((await tabs[0]!.refresh()).kind).toBe('unavailable');
  });
});

describe('a failed logout is remembered and finished on the next load', () => {
  it('keeps the pending flag, still tries on load, and says nothing is restored while it is pending', async () => {
    const { edge, tabs, storage } = browser({ tabs: 1 });
    edge.signIn();
    edge.down = true;
    expect((await tabs[0]!.logout()).ok).toBe(false);
    expect(tabs[0]!.mightBeSignedIn()).toBe(true); // the page must look at it on the next load
    expect(storage.getItem('intafaced.customer.session-logout-pending.v1')).toBe('1');
    // Next load while still down: stays unavailable, never restores the session.
    expect((await tabs[0]!.restore()).kind).toBe('unavailable');
    expect(edge.jar).not.toBeNull();
    // Edge is back: the load finishes the sign-out instead of restoring.
    edge.down = false;
    const refreshesBefore = edge.refreshes;
    expect((await tabs[0]!.restore()).kind).toBe('signed-out');
    expect(edge.refreshes).toBe(refreshesBefore);
    expect(edge.jar).toBeNull();
    expect(storage.getItem('intafaced.customer.session-logout-pending.v1')).toBeNull();
  });

  it('signing in again drops the pending flag', async () => {
    const { tabs, storage } = browser({ tabs: 1 });
    storage.setItem('intafaced.customer.session-logout-pending.v1', '1');
    tabs[0]!.announce({ accessToken: 'a', expiresAt: new Date(Date.now() + 900_000).toISOString(), userId: USER });
    expect(storage.getItem('intafaced.customer.session-logout-pending.v1')).toBeNull();
  });
});

describe('without Web Locks', () => {
  it('a storage lease still makes two tabs loading at once cause one rotation', async () => {
    const { edge, tabs } = browser({ tabs: 3, leaseOnly: true });
    edge.signIn();
    const outcomes = await Promise.all(tabs.map((tab) => tab.refresh()));
    expect(edge.reuseDetected).toBe(0);
    expect(edge.refreshes).toBe(1);
    expect(outcomes.every((o) => o.kind === 'session')).toBe(true);
  });
});

describe('a new tab asks the others before rotating', () => {
  it('adopts a live session from an open tab without touching the cookie', async () => {
    const { edge, tabs } = browser({ tabs: 2 });
    const first = edge.signIn();
    tabs[0]!.announce(first);
    const before = edge.jar;
    const outcome = await tabs[1]!.refresh();
    expect(outcome).toMatchObject({ kind: 'session', refreshed: false });
    expect(edge.refreshes).toBe(0);
    expect(edge.jar).toBe(before);
  });
});
