import { describe, expect, it } from 'vitest';
import { createFounderSessionPool, SESSION_RENEW_BUFFER_MS } from './recon-controls.mjs';

const ACCESS_TTL_MS = 15 * 60_000;

/**
 * Fake founder console whose cookies expire 15 minutes after sign-in, matching apps/admin/src/lib/founder-session.ts
 * and svc-identity's 900 s access token TTL.
 */
function fakeConsole(clock) {
  const opened = [];
  const signIns = [];
  const expiresByPage = new Map();

  const openPage = async (_browser, key) => {
    const page = { key, id: opened.length + 1 };
    opened.push(page);
    return page;
  };
  const signIn = async (page, key) => {
    signIns.push({ key, at: clock.now });
    expiresByPage.set(page, clock.now + ACCESS_TTL_MS);
  };
  const readSession = async (page) => {
    const exp = expiresByPage.get(page);
    if (!exp || exp <= clock.now) return { status: 401, body: { code: 'admin.session_required' } };
    return { status: 200, body: { expiresAt: new Date(exp).toISOString() } };
  };
  return { opened, signIns, expiresByPage, openPage, signIn, readSession };
}

describe('createFounderSessionPool', () => {
  it('reuses both founders’ pages while more than the renewal buffer remains', async () => {
    const clock = { now: Date.parse('2026-11-24T13:20:01Z') };
    const env = fakeConsole(clock);
    const pool = createFounderSessionPool({ ...env, now: () => clock.now });

    const first = await pool.founders({});
    expect(env.opened).toHaveLength(2);
    expect(env.signIns.map((s) => s.key)).toEqual(['a', 'b']);

    // 8 minutes later (7 minutes left > 6-minute buffer): no extra sign-in, same pages kept.
    clock.now += 8 * 60_000;
    const second = await pool.founders({});
    expect(second).toEqual(first);
    expect(env.opened).toHaveLength(2);
    expect(env.signIns).toHaveLength(2);
  });

  it('renews a kept session before the 15-minute access token expires, preventing /login redirects in late steps', async () => {
    const clock = { now: Date.parse('2026-11-24T13:20:01Z') };
    const env = fakeConsole(clock);
    const pool = createFounderSessionPool({ ...env, now: () => clock.now });

    const first = await pool.founders({});

    // Advance to the exact boundary where remaining lifetime enters the buffer (15m - 6m = 9m elapsed).
    clock.now += ACCESS_TTL_MS - SESSION_RENEW_BUFFER_MS;
    const renewed = await pool.founders({});
    expect(renewed).toEqual(first);
    expect(env.opened).toHaveLength(2);
    expect(env.signIns).toHaveLength(4);

    // At 15m 16s after step #1, both founders still hold a live session from the renewal.
    clock.now = Date.parse('2026-11-24T13:35:17Z');
    expect((await env.readSession(renewed.a)).status).toBe(200);
    expect((await env.readSession(renewed.b)).status).toBe(200);
  });

  it('also renews if a session has already passed its expiry', async () => {
    const clock = { now: Date.parse('2026-11-24T13:37:48Z') };
    const env = fakeConsole(clock);
    const pool = createFounderSessionPool({ ...env, now: () => clock.now });

    const first = await pool.founders({});
    clock.now += 17 * 60_000 + 7_000;
    expect((await env.readSession(first.a)).status).toBe(401);

    const renewed = await pool.founders({});
    expect(renewed).toEqual(first);
    expect(env.signIns).toHaveLength(4);
    expect((await env.readSession(renewed.a)).status).toBe(200);
    expect((await env.readSession(renewed.b)).status).toBe(200);
  });

  it('fails immediately with status and code when /api/session refuses after sign-in', async () => {
    const clock = { now: Date.parse('2026-11-24T13:20:01Z') };
    const env = fakeConsole(clock);
    const pool = createFounderSessionPool({
      ...env,
      readSession: async () => ({ status: 401, body: { code: 'admin.session_required' } }),
      now: () => clock.now,
    });

    await expect(pool.founders({})).rejects.toThrow(
      "founder a's session expiry could not be read from /api/session (401 admin.session_required)",
    );
  });
});
