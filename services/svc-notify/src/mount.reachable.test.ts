/**
 * Unit card — svc-notify is REACHABLE over HTTP, not merely constructible
 * 1. Promise: README "Edge path" — a client reaches these procedures at
 *    `GET /trpc/<procedure>` on this service. Doctrine: reachability gate
 * 2. Break: the tRPC plugin is registered at the wrong prefix, the context
 *    factory stops reading the edge headers, or a procedure exists on the router
 *    and is not served — every one of which `createCaller` is blind to
 * 3. Done bar: a real socket, a real request, a real 200/401 per procedure
 * 4. Class N
 * 5. Paths: svc-notify
 * 6. RED: change the plugin prefix, or drop `createContext`
 * 7. Collision: none
 *
 * WHY THIS FILE EXISTS ALONGSIDE `router.mount.test.ts`.
 *
 * That file proves AUTHORISATION — self-only reads, forged principals refused —
 * and it does so through `createCaller`, which is the right tool for the job it
 * does. What it cannot see is whether anything serves the router: `createCaller`
 * invokes procedures in-process, so it is green on a service whose HTTP mount was
 * never registered, mounted at the wrong prefix, or wired to a context factory
 * that ignores the edge signature.
 *
 * That is not a hypothetical failure in this repository. svc-notify's own history
 * is a COMPLETE `bankMarginCalled` consumer that parked at every boot for weeks,
 * and D-S-13's second correction records a gate going green on two subscribers
 * that had never run. Both were caught by asking "is it mounted", not "does it
 * work". So this file asks over a socket.
 *
 * A real listener rather than `app.inject()`, for the same reason
 * `channels/gateway-wire.test.ts` runs a real `node:http` server: the recording
 * should be the request the operating system delivered.
 */

import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { retainRawBody, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createGuestIngressContext } from './guests/context.js';
import { createNotifyRouter, type NotifyRouter } from './router.js';
import { NotifyService } from './notify-service.js';
import { MemoryNotifyStore } from './store.js';
import { MemoryDeliveryStore, MemoryTargetStore } from './channel-store.js';
import { channelsFromEnv } from './channels/registry.js';
import { NotificationDispatcher } from './dispatch.js';
import { AlertService } from './alerts/service.js';
import { MemoryAlertStore } from './alerts/store.js';
import type { MarkSource } from './alerts/types.js';
import { createDarkWhaleMarkSource } from './alerts/whale-mark.js';

const here = dirname(fileURLToPath(import.meta.url));

/** The prefix this file proves. `index.ts` must ship the same one — see below. */
const PREFIX = '/trpc';

const SECRET = 'a-notify-reachability-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';

/** The production default: no mark feed, so every evaluation refuses. */
const darkMarks: MarkSource = {
  kind: 'dark',
  async quote() {
    return { kind: 'unavailable', reason: 'dark', detail: 'no mark source configured' };
  },
};

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['notify:read', 'notify:write'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

/** The headers svc-edge puts on a forwarded request. */
function edgeHeaders(p: Principal = principal()): Record<string, string> {
  const raw = encodePrincipal(p);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

interface Mounted {
  readonly app: FastifyInstance;
  readonly base: string;
  readonly notifyStore: MemoryNotifyStore;
  readonly alerts: AlertService | null;
}

const running: FastifyInstance[] = [];

/**
 * The service's HTTP surface, assembled the way `index.ts` assembles it.
 *
 * Same plugin, same prefix, same context factory. Real services (memory-backed
 * stores), not stubs — a stub could satisfy a route that serves nothing useful.
 */
async function mount(options: { marks?: MarkSource; whaleMarks?: MarkSource; withAlerts?: boolean } = {}): Promise<Mounted> {
  const notifyStore = new MemoryNotifyStore();
  const targets = new MemoryTargetStore();
  const deliveries = new MemoryDeliveryStore();
  // No gateway credentials — the state every deployment is in until an owner
  // provisions them. All three out-of-app channels register as unconfigured.
  const channels = channelsFromEnv({ NOTIFY_GATEWAY_TIMEOUT_MS: 5_000 });
  const dispatcher = new NotificationDispatcher(channels, targets, deliveries, { maxAttempts: 3, outOfAppEnabled: true });
  const notify = new NotifyService(notifyStore, { fanoutEnabled: true }, { targets, deliveries, channels, dispatcher });
  const alerts =
    options.withAlerts === false
      ? null
      : new AlertService(new MemoryAlertStore(), options.marks ?? darkMarks, notify, options.whaleMarks ?? createDarkWhaleMarkSource());
  const appRouter = createNotifyRouter(notify, alerts ?? undefined);
  const edgeContext = createGuestIngressContext({ edgeSecret: SECRET });
  const app = Fastify({ logger: false, maxParamLength: 5_000 });
  retainRawBody(app);
  await app.register(fastifyTRPCPlugin, {
    prefix: PREFIX,
    trpcOptions: {
      router: appRouter,
      createContext: ({ req }) => edgeContext(req),
    } satisfies FastifyTRPCPluginOptions<NotifyRouter>['trpcOptions'],
  });

  await app.listen({ host: '127.0.0.1', port: 0 });
  running.push(app);
  const { port } = app.server.address() as AddressInfo;
  return { app, base: `http://127.0.0.1:${port}`, notifyStore, alerts };
}

afterEach(async () => {
  while (running.length > 0) await running.pop()!.close();
});

/** A tRPC single-call response, unwrapped. Throws nothing — the test asserts. */
async function call(
  base: string,
  procedure: string,
  init: { method?: 'GET' | 'POST'; headers?: Record<string, string>; input?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const method = init.method ?? 'GET';
  const url =
    method === 'GET' && init.input !== undefined
      ? `${base}${PREFIX}/${procedure}?input=${encodeURIComponent(JSON.stringify(init.input))}`
      : `${base}${PREFIX}/${procedure}`;

  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...(method === 'POST' ? { body: JSON.stringify(init.input ?? {}) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
}

/** The `result.data` of a successful single call. */
function data(body: unknown): unknown {
  return (body as { result?: { data?: unknown } }).result?.data;
}

describe('svc-notify serves its router over a real socket', () => {
  it('answers health on the mounted prefix', async () => {
    const { base } = await mount();
    const res = await call(base, 'health');
    expect(res.status).toBe(200);
    expect(data(res.body)).toEqual({
      ok: true,
      service: 'svc-notify',
      fanoutEnabled: true,
      venueIncident: {
        allFine: false,
        matching: 'unwired',
        code: null,
        incidentSilence: false,
        allClear: false,
      },
    });
  });

  it('serves the inbox to an edge-signed caller', async () => {
    const { base } = await mount();
    const res = await call(base, 'notify.list', { headers: edgeHeaders(), input: { limit: 20 } });
    expect(res.status).toBe(200);
    expect(data(res.body)).toEqual({ items: [], nextCursor: null });
  });

  it('refuses an unsigned caller at the HTTP boundary, not merely in the router', async () => {
    const { base } = await mount();
    const res = await call(base, 'notify.list');
    expect(res.status).toBe(401);
  });

  it('refuses a self-asserted principal that never passed through the edge', async () => {
    const { base } = await mount();
    const raw = encodePrincipal(principal());
    // The principal header without its signature — what a caller reaching this
    // port directly could forge.
    const res = await call(base, 'notify.list', { headers: { 'x-intafaced-principal': raw, 'x-intafaced-region': 'DE' } });
    expect(res.status).toBe(401);
  });

  /**
   * WHICH CHANNELS ACTUALLY DELIVER, asserted over the wire.
   *
   * One does. Three are wired to a transport and have no credentials, so they
   * refuse by name and say which variables an owner must set. That is the honest
   * state and this test pins it: a future edit that reports `available: true` for
   * a channel with no gateway would tell a user their margin call has a route it
   * does not have.
   */
  it('names in-app as the only channel that can deliver, and says what the other three need', async () => {
    const { base } = await mount();
    const res = await call(base, 'notify.channels', { headers: edgeHeaders() });
    expect(res.status).toBe(200);
    const channels = data(res.body) as readonly {
      channel: string;
      configured: boolean;
      available: boolean;
      reason: string | null;
      requires: string[];
      socket: string | null;
    }[];

    expect(channels.find((c) => c.channel === 'inapp')).toMatchObject({
      configured: true,
      available: true,
      reason: null,
      requires: [],
      socket: null,
    });

    for (const channel of ['email', 'push', 'sms'] as const) {
      expect(channels.find((c) => c.channel === channel)).toMatchObject({
        configured: false,
        available: false,
        reason: 'channel.not_configured',
        requires: [`NOTIFY_${channel.toUpperCase()}_GATEWAY_URL`, `NOTIFY_${channel.toUpperCase()}_GATEWAY_TOKEN`],
        socket: `socket.notify-${channel}`,
      });
    }
  });
});

/**
 * THE HALF THAT MAKES THE HALF ABOVE MEAN ANYTHING.
 *
 * Everything above assembles a mount and proves requests reach it. On its own
 * that proves a mount THIS FILE built — and a green result would read as evidence
 * for the mount `index.ts` ships, which it never examined. That is the recurring
 * defect shape D-S-13's second correction counts five times, and writing a
 * reachability test without this block would be the sixth.
 *
 * `index.ts` connects to Postgres and NATS at module scope and cannot be
 * imported, so the tie is made by reading it: same plugin, same prefix, same
 * context factory. Change either side and one of these fails.
 */
describe('the mount proven above is the mount index.ts ships', () => {
  const index = readFileSync(join(here, 'index.ts'), 'utf8');

  it('registers the same tRPC plugin at the same prefix this file requested', () => {
    expect(index).toMatch(/fastifyTRPCPlugin/);
    expect(index).toMatch(new RegExp(`prefix: '${PREFIX}'`));
  });

  it('passes the original request to the signed edge and exact-body ops context', () => {
    // A mount that served the router without this would answer every caller as
    // whoever they claimed to be.
    expect(index).toMatch(/createContext:/);
    expect(index).toMatch(/createGuestIngressContext/);
    expect(index).toMatch(/createContext: \(\{ req \}\) => edgeContext\(req\)/);
    expect(index).toMatch(/EDGE_PRINCIPAL_SECRET/);
  });
});

describe('the alert surface tells the truth over the wire', () => {
  it('a watchlist read carries the fact that no watch on it can fire', async () => {
    const { base } = await mount();
    const res = await call(base, 'notify.alerts', { headers: edgeHeaders(), input: { limit: 20 } });
    expect(res.status).toBe(200);
    expect(data(res.body)).toEqual({
      items: [],
      evaluation: { markSource: 'dark', canFire: false, code: 'alert.price_unavailable' },
    });
  });

  it('notify.alerts omit is PRECONDITION_FAILED — never dumps every watch', async () => {
    const { base } = await mount();
    const omitted = await call(base, 'notify.alerts', { headers: edgeHeaders() });
    expect(omitted.status).not.toBe(200);
    expect(JSON.stringify(omitted.body)).toContain('notify.alerts_list_limit_unset');
    const empty = await call(base, 'notify.alerts', { headers: edgeHeaders(), input: {} });
    expect(empty.status).not.toBe(200);
    expect(JSON.stringify(empty.body)).toContain('notify.alerts_list_limit_unset');
  });

  it('creating a watch returns the watch AND that it cannot cross yet — in one answer', async () => {
    const { base } = await mount();
    const res = await call(base, 'notify.createAlert', {
      method: 'POST',
      headers: edgeHeaders(),
      input: { marketId: 'BTC-USD', direction: 'above', targetPrice: '100' },
    });
    expect(res.status).toBe(200);
    const created = data(res.body) as { alert: { status: string; targetPrice: string }; evaluation: { canFire: boolean } };
    expect(created.alert.status).toBe('active');
    // Decimal string on the wire — never a JSON number.
    expect(created.alert.targetPrice).toBe('100');
    // The whole point: `active` never travels without this.
    expect(created.evaluation).toEqual({ markSource: 'dark', canFire: false, code: 'alert.price_unavailable' });
  });

  it('a watch created over HTTP is the one the sweep picks up', async () => {
    const { base, alerts, notifyStore } = await mount();
    await call(base, 'notify.createAlert', {
      method: 'POST',
      headers: edgeHeaders(),
      input: { marketId: 'BTC-USD', direction: 'above', targetPrice: '100' },
    });

    // The sweep that `index.ts` drives, run once by hand against the same
    // service instance the route wrote into. Dark source: refused, not fired,
    // and nothing lands in the inbox.
    const report = await alerts!.evaluateDueAlerts();
    expect(report).toMatchObject({ markets: 1, fired: 0, refused: 1, refusals: { 'alert.price_unavailable': 1 } });
    expect(await notifyStore.unreadCount(USER)).toBe(0);

    const list = await call(base, 'notify.alerts', { headers: edgeHeaders(), input: { limit: 20 } });
    const listed = data(list.body) as { items: readonly { status: string }[] };
    // Still active. A refused evaluation must never read as a fired watch.
    expect(listed.items[0]!.status).toBe('active');
  });

  it('createAlert kind=intelligence refuses alert.kind_unpublished and never stores a live watch', async () => {
    const { base, notifyStore } = await mount();
    const res = await call(base, 'notify.createAlert', {
      method: 'POST',
      headers: edgeHeaders(),
      input: { kind: 'intelligence', marketId: 'BTC-USD', direction: 'above', targetPrice: '100' },
    });
    expect(res.status).not.toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).toContain('alert.kind_unpublished');
    expect(text).not.toMatch(/"status"\s*:\s*"fired"/);
    expect(await notifyStore.unreadCount(USER)).toBe(0);

    const listed = await call(base, 'notify.alerts', { headers: edgeHeaders(), input: { limit: 20 } });
    expect(data(listed.body)).toMatchObject({ items: [] });
  });

  it('evaluateAlert kind=intelligence refuses alert.kind_unpublished and never fires', async () => {
    const { base, notifyStore } = await mount();
    const evaluated = await call(base, 'notify.evaluateAlert', {
      method: 'POST',
      headers: edgeHeaders(),
      input: { kind: 'intelligence' },
    });
    expect(evaluated.status).toBe(200);
    const body = data(evaluated.body) as {
      alert: { status: string } | null;
      outcome: { kind: string; code?: string };
    };
    expect(body.alert).toBeNull();
    expect(body.outcome).toMatchObject({ kind: 'refuse', code: 'alert.kind_unpublished' });
    expect(body.outcome.kind).not.toBe('fire');
    expect(await notifyStore.unreadCount(USER)).toBe(0);
  });

  it('createAlert kind=whale stores a watch; dark evaluate refuses alerts.whale_mark_dark and never fires', async () => {
    const { base, notifyStore } = await mount();
    const res = await call(base, 'notify.createAlert', {
      method: 'POST',
      headers: edgeHeaders(),
      input: { kind: 'whale', marketId: 'BTC-USD', direction: 'above', targetPrice: '1000' },
    });
    expect(res.status).toBe(200);
    const created = data(res.body) as {
      alert: { id: string; kind: string; status: string; targetPrice: string };
      evaluation: { markSource: string; canFire: boolean; code: string | null };
    };
    expect(created.alert.kind).toBe('whale');
    expect(created.alert.status).toBe('active');
    expect(created.alert.targetPrice).toBe('1000');
    expect(created.evaluation).toEqual({ markSource: 'dark', canFire: false, code: 'alerts.whale_mark_dark' });

    const evaluated = await call(base, 'notify.evaluateAlert', {
      method: 'POST',
      headers: edgeHeaders(),
      input: { id: created.alert.id },
    });
    expect(evaluated.status).toBe(200);
    const body = data(evaluated.body) as {
      alert: { status: string; kind: string } | null;
      outcome: { kind: string; code?: string };
    };
    expect(body.alert?.kind).toBe('whale');
    expect(body.alert?.status).toBe('active');
    expect(body.outcome).toMatchObject({ kind: 'refuse', code: 'alerts.whale_mark_dark' });
    expect(body.outcome.kind).not.toBe('fire');
    expect(await notifyStore.unreadCount(USER)).toBe(0);

    const listed = await call(base, 'notify.alerts', { headers: edgeHeaders(), input: { limit: 20 } });
    const listedBody = data(listed.body) as { items: readonly { kind: string; status: string }[] };
    expect(listedBody.items).toHaveLength(1);
    expect(listedBody.items[0]).toMatchObject({ kind: 'whale', status: 'active' });
  });

  it('createAlert kind=whale fires when a live whale flow mark is injected', async () => {
    const liveWhale: MarkSource = {
      kind: 'live',
      async quote() {
        return { kind: 'ok', price: '2500', at: new Date() };
      },
    };
    const { base, notifyStore } = await mount({ whaleMarks: liveWhale });
    const res = await call(base, 'notify.createAlert', {
      method: 'POST',
      headers: edgeHeaders(),
      input: { kind: 'whale', marketId: 'BTC-USD', direction: 'above', targetPrice: '1000' },
    });
    expect(res.status).toBe(200);
    const created = data(res.body) as { alert: { id: string }; evaluation: { canFire: boolean } };
    expect(created.evaluation.canFire).toBe(true);

    const evaluated = await call(base, 'notify.evaluateAlert', {
      method: 'POST',
      headers: edgeHeaders(),
      input: { id: created.alert.id },
    });
    expect(evaluated.status).toBe(200);
    const body = data(evaluated.body) as {
      outcome: { kind: string; markPrice?: string };
      alert: { status: string } | null;
    };
    expect(body.outcome).toEqual({ kind: 'fire', markPrice: '2500' });
    expect(body.alert?.status).toBe('fired');
    expect(await notifyStore.unreadCount(USER)).toBe(1);
  });

  it.each(['funding', 'liquidation_proximity'] as const)(
    'createAlert kind=%s stores a sourced watch; dark evaluate refuses and never fires',
    async (kind) => {
      const { base, notifyStore } = await mount();
      const res = await call(base, 'notify.createAlert', {
        method: 'POST',
        headers: edgeHeaders(),
        input: { kind, marketId: 'BTC-USD', direction: 'above', targetPrice: '100' },
      });
      expect(res.status).toBe(200);
      const created = data(res.body) as {
        alert: { id: string; kind: string; status: string; targetPrice: string };
        evaluation: { markSource: string; canFire: boolean; code: string | null };
      };
      expect(created.alert.kind).toBe(kind);
      expect(created.alert.status).toBe('active');
      expect(created.alert.targetPrice).toBe('100');
      expect(created.evaluation).toEqual({ markSource: 'dark', canFire: false, code: 'alert.price_unavailable' });

      const evaluated = await call(base, 'notify.evaluateAlert', {
        method: 'POST',
        headers: edgeHeaders(),
        input: { id: created.alert.id },
      });
      expect(evaluated.status).toBe(200);
      const body = data(evaluated.body) as {
        alert: { status: string; kind: string } | null;
        outcome: { kind: string; code?: string };
      };
      expect(body.alert?.kind).toBe(kind);
      expect(body.alert?.status).toBe('active');
      expect(body.outcome).toMatchObject({ kind: 'refuse', code: 'alert.price_unavailable' });
      expect(body.outcome.kind).not.toBe('fire');
      expect(await notifyStore.unreadCount(USER)).toBe(0);

      const listed = await call(base, 'notify.alerts', { headers: edgeHeaders(), input: { limit: 20 } });
      const listedBody = data(listed.body) as { items: readonly { kind: string; status: string }[] };
      expect(listedBody.items).toHaveLength(1);
      expect(listedBody.items[0]).toMatchObject({ kind, status: 'active' });
    },
  );

  it('createAlert with kind=portfolio refuses unpublished and never fires', async () => {
    const { base, notifyStore } = await mount();
    const res = await call(base, 'notify.createAlert', {
      method: 'POST',
      headers: edgeHeaders(),
      input: { kind: 'portfolio' },
    });
    expect(res.status).not.toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).toContain('alert.portfolio_view_unpublished');
    expect(text).not.toMatch(/"balance"\s*:/);
    expect(await notifyStore.unreadCount(USER)).toBe(0);

    const listed = await call(base, 'notify.alerts', { headers: edgeHeaders(), input: { limit: 20 } });
    expect(data(listed.body)).toMatchObject({ items: [] });
  });

  it('evaluateAlert with kind=portfolio refuses unpublished and never fires', async () => {
    const { base, notifyStore } = await mount();
    const evaluated = await call(base, 'notify.evaluateAlert', {
      method: 'POST',
      headers: edgeHeaders(),
      input: { kind: 'portfolio' },
    });
    expect(evaluated.status).toBe(200);
    const body = data(evaluated.body) as {
      alert: unknown;
      outcome: { kind: string; code?: string };
    };
    expect(body.alert).toBeNull();
    expect(body.outcome).toMatchObject({ kind: 'refuse', code: 'alert.portfolio_view_unpublished' });
    expect(body.outcome.kind).not.toBe('fire');
    expect(await notifyStore.unreadCount(USER)).toBe(0);
  });

  it('evaluateAlert over HTTP refuses a dark port that quotes a fake last — never fired as live', async () => {
    const lyingDark: MarkSource = {
      kind: 'dark',
      async quote() {
        return { kind: 'ok', price: '999', at: new Date() };
      },
    };
    const { base, notifyStore } = await mount({ marks: lyingDark });
    const created = await call(base, 'notify.createAlert', {
      method: 'POST',
      headers: edgeHeaders(),
      input: { marketId: 'BTC-USD', direction: 'above', targetPrice: '100' },
    });
    expect(created.status).toBe(200);
    const createdBody = data(created.body) as {
      alert: { id: string; status: string };
      evaluation: { markSource: string; canFire: boolean; code: string | null };
    };
    expect(createdBody.evaluation).toEqual({
      markSource: 'dark',
      canFire: false,
      code: 'alert.price_unavailable',
    });
    expect(createdBody.alert.status).toBe('active');

    const evaluated = await call(base, 'notify.evaluateAlert', {
      method: 'POST',
      headers: edgeHeaders(),
      input: { id: createdBody.alert.id },
    });
    expect(evaluated.status).toBe(200);
    const body = data(evaluated.body) as {
      alert: { status: string } | null;
      outcome: { kind: string; code?: string };
      evaluation: { markSource: string; canFire: boolean; code: string | null };
    };
    expect(body.evaluation).toEqual({ markSource: 'dark', canFire: false, code: 'alert.price_unavailable' });
    expect(body.outcome).toMatchObject({ kind: 'refuse', code: 'alert.price_unavailable' });
    expect(body.alert?.status).toBe('active');
    expect(body.alert?.status).not.toBe('fired');
    expect(body.evaluation.markSource).not.toBe('live');
    expect(body.evaluation.canFire).toBe(false);
    expect(await notifyStore.unreadCount(USER)).toBe(0);
  });

  it('create/evaluate with no alert service refuse cannot-fire by name', async () => {
    const { base } = await mount({ withAlerts: false });
    const created = await call(base, 'notify.createAlert', {
      method: 'POST',
      headers: edgeHeaders(),
      input: { marketId: 'BTC-USD', direction: 'above', targetPrice: '100' },
    });
    expect(created.status).not.toBe(200);
    expect(JSON.stringify(created.body)).toContain('alert.price_unavailable');

    const evaluated = await call(base, 'notify.evaluateAlert', {
      method: 'POST',
      headers: edgeHeaders(),
      input: { id: '11111111-1111-4111-8111-111111111111' },
    });
    expect(evaluated.status).toBe(200);
    const body = data(evaluated.body) as {
      alert: unknown;
      outcome: { kind: string; code?: string };
      evaluation: { markSource: string; canFire: boolean; code: string | null };
    };
    expect(body.alert).toBeNull();
    expect(body.outcome).toMatchObject({ kind: 'refuse', code: 'alert.price_unavailable' });
    expect(body.evaluation).toEqual({ markSource: 'dark', canFire: false, code: 'alert.price_unavailable' });
  });
});
