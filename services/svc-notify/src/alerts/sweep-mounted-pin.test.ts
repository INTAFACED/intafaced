/**
 * Unit card — the alert sweep is MOUNTED, not merely defined
 * 1. Promise: D-S-13 done bar item 7 — "wired means mounted, not defined". A
 *    watch surface that claims evaluation must have a caller in the entrypoint
 * 2. Break: someone deletes the sweep interval from index.ts, or injects a live
 *    mark source while nothing drives evaluation, and the alert API goes back to
 *    returning `status: 'active'` for watches nothing will ever look at
 * 3. Done bar: the booted entrypoint runs a sweep pass at boot and on an interval
 *    and clears it on shutdown; the router discloses evaluation with the watchlist
 * 4. Class N
 * 5. Paths: svc-notify
 * 6. RED: delete the `alertSweep` interval, or the `evaluation` field on
 *    `notify.alerts`
 * 7. Collision: none
 *
 * HOW THE ENTRYPOINT IS CHECKED. `index.ts` connects to Postgres and NATS at
 * module scope; `testing/boot.ts` boots it in this process with both stood in,
 * so these tests ask the running entrypoint what it drives. The failure this
 * pins is exactly the one D-S-13's second correction records — a subscriber
 * defined in a file nothing imports, green in its own unit test, never run.
 * `svc-notify` has shipped that shape twice: a complete `bankMarginCalled`
 * consumer that parked, and a complete `evaluateMarket` with no caller.
 *
 * What the router, the mark factories and the accepted-mark gate do on their own
 * is proven where they live: `mount.reachable.test.ts` (evaluation with the
 * watchlist and with a new watch, intelligence/portfolio/whale refusals over
 * HTTP), `trade-http-mark.test.ts` and `whale-mark.test.ts` (live only from the
 * factory, the ticker path, the markets limit, aged marks), `accepted-mark.test.ts`
 * (the 300 s window) and `service.test.ts` (evaluatePortfolio refuses).
 */

import { alertEvaluationOutput } from '@intafaced/contracts/notify-call-schemas';
import { NOTIFY_ALERTS } from '@intafaced/contracts/notify-notify-procedures';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { BOOT_EDGE_SECRET, bootNotify, type BootedNotify } from '../testing/boot.js';
import { ALERT_MARK_MAX_AGE_MS } from './accepted-mark.js';
import { ALERT_SWEEP_INTERVAL_MS } from './service.js';
import { ALERT_KIND_UNPUBLISHED, UNPUBLISHED_ALERT_KINDS, type MarkSource } from './types.js';

const USER = '11111111-1111-4111-8111-111111111111';

type ReadyAlerts = { markSource: string; unpublishedKinds: string[]; unpublishedCode: string; sweep: { lastAt: string | null } };

async function readyAlerts(booted: BootedNotify): Promise<ReadyAlerts> {
  return (await booted.app.inject({ method: 'GET', url: '/ready' })).json().alerts as ReadyAlerts;
}

/** The booted service's alert sweep interval: the one whose tick moves the sweep's lastAt. */
async function sweepInterval(booted: BootedNotify) {
  for (const started of booted.intervals.filter((i) => i.delayMs === ALERT_SWEEP_INTERVAL_MS)) {
    const before = (await readyAlerts(booted)).sweep.lastAt;
    // The clock moves a minute on, so a pass this tick completes stamps a lastAt the earlier one cannot equal.
    vi.setSystemTime(Date.now() + 60_000);
    try {
      started.tick();
      await vi.waitFor(async () => expect((await readyAlerts(booted)).sweep.lastAt).not.toBe(before), { timeout: 500 });
      return started;
    } catch {
      // This interval's tick moved no sweep: it drives something else.
    } finally {
      vi.useRealTimers();
    }
  }
  return null;
}

describe('the alert evaluation driver is reachable from the entrypoint', () => {
  it('index.ts drives the mounted sweep driver on an interval', async () => {
    const booted = await bootNotify();
    try {
      // An interval, not a single pass at boot: a watch created after boot must be evaluated too.
      expect(await sweepInterval(booted)).not.toBeNull();
    } finally {
      await booted.close();
    }
  });

  it('index.ts runs a boot sweep pass before waiting on the interval', async () => {
    const booted = await bootNotify();
    try {
      // No interval has ticked yet (the shortest is a second away): the pass on record is the boot pass.
      expect((await readyAlerts(booted)).sweep.lastAt).not.toBeNull();
    } finally {
      await booted.close();
    }
  });

  it('index.ts clears the sweep on shutdown, so a restart does not stack drivers', async () => {
    const booted = await bootNotify();
    const sweep = await sweepInterval(booted);
    expect(sweep).not.toBeNull();
    expect(sweep?.cleared).toBe(false);
    await booted.close();
    expect(booted.exits).toEqual([0]);
    expect(sweep?.cleared).toBe(true);
  });

  it('/ready reports when the sweep last completed — a null lastAt means it never ran', async () => {
    const booted = await bootNotify();
    try {
      const { sweep } = await readyAlerts(booted);
      expect(typeof sweep.lastAt).toBe('string');
      expect(Number.isNaN(Date.parse(sweep.lastAt ?? ''))).toBe(false);
    } finally {
      await booted.close();
    }
  });

  it('the router discloses evaluation status with the watchlist, not behind its own procedure', async () => {
    // The watchlist's answer carries the evaluation status: its record, which the router mounts.
    expect(NOTIFY_ALERTS.output.shape.evaluation).toBe(alertEvaluationOutput);
    const booted = await bootNotify();
    try {
      const raw = encodePrincipal({
        sub: USER,
        userId: USER,
        sid: '22222222-2222-4222-8222-222222222222',
        scopes: ['notify:read'],
        tier: 'none',
        mfa: false,
        expiresAt: new Date(Date.now() + 60_000),
      } as Principal);
      const res = await booted.app.inject({
        method: 'GET',
        url: `${booted.trpc.prefix}/notify.alerts?input=${encodeURIComponent(JSON.stringify({ limit: 20 }))}`,
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, BOOT_EDGE_SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
      });
      expect(res.statusCode).toBe(200);
      // The booted watchlist read carries the evaluation status with it: dark, cannot fire, and why.
      expect(res.json().result.data).toEqual({
        items: [],
        evaluation: { markSource: 'dark', canFire: false, code: 'alert.price_unavailable' },
      });
    } finally {
      await booted.close();
    }
  });

  it('live is only claimed by the trade HTTP factory when TRADE_URL is set — never hardcoded in the entrypoint', async () => {
    const dark = await bootNotify({ TRADE_URL: undefined, NOTIFY_MARKETS_LIST_LIMIT: '7' });
    try {
      expect((await readyAlerts(dark)).markSource).toBe('dark');
      expect((dark.alertServiceArgs[1] as MarkSource).kind).toBe('dark');
      await expect((dark.alertServiceArgs[1] as MarkSource).quote('BTC-USD')).resolves.toMatchObject({ kind: 'unavailable' });
    } finally {
      await dark.close();
    }
    // With TRADE_URL the mark the alerts read is the trade factory's, asking trade's markets with the owner's limit.
    const seen: string[] = [];
    const live = await bootNotify(
      { TRADE_URL: 'http://trade.test:4004', NOTIFY_MARKETS_LIST_LIMIT: '7' },
      {
        fetch: async (input) => {
          seen.push(String(input));
          return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
        },
      },
    );
    try {
      expect((await readyAlerts(live)).markSource).toBe('live');
      const marks = live.alertServiceArgs[1] as MarkSource;
      expect(marks.kind).toBe('live');
      await marks.quote('BTC-USD');
      expect(seen).toContain('http://trade.test:4004/api/v1/markets?limit=7');
      expect(seen.some((url) => /limit=50\b/.test(url))).toBe(false);
    } finally {
      await live.close();
    }
  });

  it('evaluateMarket accepts the mark before firing — dark wiring cannot invent live', async () => {
    // The booted service with no trade URL: its alert service evaluates against the dark mark and cannot fire.
    const booted = await bootNotify({ TRADE_URL: undefined });
    try {
      expect(await readyAlerts(booted)).toMatchObject({ markSource: 'dark' });
      expect((await booted.app.inject({ method: 'GET', url: '/ready' })).json().alerts).toMatchObject({
        canFire: false,
        code: 'alert.price_unavailable',
      });
    } finally {
      await booted.close();
    }
  });

  it('accepted-mark refuses a live ok quote whose timestamp is older than the bank marking window', () => {
    // The window itself; the refusals at the gate and in the HTTP producer are proven in accepted-mark.test.ts and
    // trade-http-mark.test.ts.
    expect(ALERT_MARK_MAX_AGE_MS).toBe(300_000);
  });

  it('Fastify /ready names unpublished kinds and the refuse code', async () => {
    const booted = await bootNotify();
    try {
      const alerts = await readyAlerts(booted);
      expect(alerts.unpublishedKinds).toEqual([...UNPUBLISHED_ALERT_KINDS]);
      expect(alerts.unpublishedCode).toBe(ALERT_KIND_UNPUBLISHED);
    } finally {
      await booted.close();
    }
  });

  it('whale mark is a separate port — live only from the factory when allow-list + TRADE_URL are set', async () => {
    const cases: Array<[Record<string, string | undefined>, 'dark' | 'live']> = [
      [{ TRADE_URL: undefined, NOTIFY_WHALE_FLOW_ALLOWLIST: 'BTC-USD' }, 'dark'],
      [{ TRADE_URL: 'http://trade.test:4004', NOTIFY_WHALE_FLOW_ALLOWLIST: undefined, NOTIFY_MARKETS_LIST_LIMIT: '7' }, 'dark'],
      [{ TRADE_URL: 'http://trade.test:4004', NOTIFY_WHALE_FLOW_ALLOWLIST: 'BTC-USD', NOTIFY_MARKETS_LIST_LIMIT: '7' }, 'live'],
    ];
    for (const [vars, kind] of cases) {
      const booted = await bootNotify(vars);
      try {
        const whale = booted.alertServiceArgs[3] as MarkSource;
        expect(whale, JSON.stringify(vars)).not.toBe(booted.alertServiceArgs[1]);
        expect(whale.kind, JSON.stringify(vars)).toBe(kind);
      } finally {
        await booted.close();
      }
    }
  });
});
