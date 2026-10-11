import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createNotifyRouter } from './router.js';
import { assertNotifyListLimit, assertOperatorDeliveriesLimit, type NotifyService } from './notify-service.js';

/**
 * THE MOUNT BOUNDARY for svc-notify (docs/decisions/mount-boundary.md).
 *
 * Context comes from `createEdgeContext` over real headers — never a hand-written
 * principal. list / markRead / markAllRead must only run for the edge-signed
 * principal; a forgeable principal here is another account's inbox.
 */

afterEach(() => vi.unstubAllEnvs());

const SECRET = 'a-notify-mount-test-edge-secret-long';
const USER = '11111111-1111-4111-8111-111111111111';
const VICTIM = '99999999-9999-4999-8999-999999999999';

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-notify' });

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

const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });

function signed(p: Principal = principal()) {
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-signed',
  });
}

function forged(p: Principal = principal()) {
  return edgeContext({
    headers: { 'x-intafaced-principal': encodePrincipal(p), 'x-intafaced-region': 'DE' },
    id: 'req-forged',
  });
}

function stubNotify(overrides: Partial<NotifyService> = {}): NotifyService {
  return {
    fanoutEnabled: true,
    create: vi.fn(),
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    unreadCount: vi.fn(async () => 0),
    markRead: vi.fn(async () => 0),
    markAllRead: vi.fn(async () => 0),
    ...overrides,
  } as unknown as NotifyService;
}

describe('svc-notify mount — authorisation', () => {
  it('strict screening refuses a signed inbox read and target mutation before service effects', async () => {
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'true');
    vi.stubEnv('INTAFACED_REGION_FAIL_CLOSED', 'true');
    vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', '');
    vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', '');
    const notify = stubNotify({ registerTarget: vi.fn() });
    const caller = createNotifyRouter(notify).createCaller(signed());
    const refusal = {
      code: 'FORBIDDEN',
      cause: {
        code: 'denied.screening_unconfigured',
        decision: { screening: { listConfigured: false, moneyGrade: 'unconfigured', readsAsScreenedClean: false } },
      },
    };
    await expect(caller.notify.list({ limit: 10 })).rejects.toMatchObject(refusal);
    await expect(caller.notify.registerTarget({ channel: 'email', address: 'a@b.c' })).rejects.toMatchObject(refusal);
    expect(notify.list).not.toHaveBeenCalled();
    expect(notify.registerTarget).not.toHaveBeenCalled();
  });

  it('refuses an anonymous caller on list, and reads nothing', async () => {
    let read = false;
    const notify = stubNotify({
      list: async () => {
        read = true;
        return { items: [], nextCursor: null };
      },
    });

    await expect(createNotifyRouter(notify).createCaller(anonymous()).notify.list()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(read).toBe(false);
  });

  it('refuses a self-asserted principal naming another user', async () => {
    let readFor: string | null = null;
    const notify = stubNotify({
      list: async ({ userId }: { userId: string }) => {
        readFor = userId;
        return { items: [], nextCursor: null };
      },
    });

    const ctx = forged(principal({ sub: VICTIM, userId: VICTIM }));
    expect(ctx.principal).toBeNull();

    await expect(createNotifyRouter(notify).createCaller(ctx).notify.list()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(readFor).toBeNull();
  });

  it('accepts an edge-signed principal and lists that principal inbox only', async () => {
    let readFor: string | null = null;
    const notify = stubNotify({
      list: async ({ userId }: { userId: string }) => {
        readFor = userId;
        return { items: [], nextCursor: null };
      },
    });

    await expect(createNotifyRouter(notify).createCaller(signed()).notify.list({ limit: 20 })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(readFor).toBe(USER);
  });

  it('notify.list omit is PRECONDITION_FAILED — never invents a 20-row page', async () => {
    const notify = stubNotify({
      list: async (query: { limit?: number }) => {
        assertNotifyListLimit(query.limit);
        return { items: [], nextCursor: null };
      },
    });
    const caller = createNotifyRouter(notify).createCaller(signed());
    await expect(caller.notify.list({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'notify.list_limit_unset',
    });
    await expect(caller.notify.list()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'notify.list_limit_unset',
    });
    await expect(caller.notify.list({ limit: 20 })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('notify.ops.deliveries omit is PRECONDITION_FAILED — never invents a 50-row page', async () => {
    const notify = stubNotify({
      operatorDeliveryOutcomes: async (limit?: number) => {
        assertOperatorDeliveriesLimit(limit);
        return [];
      },
    });
    const caller = createNotifyRouter(notify).createCaller(signed(principal({ scopes: ['admin:read'] })));
    await expect(caller.notify.ops.deliveries({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'notify.operator_deliveries_limit_unset',
    });
    await expect(caller.notify.ops.deliveries()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'notify.operator_deliveries_limit_unset',
    });
    await expect(caller.notify.operatorDeliveries()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'notify.operator_deliveries_limit_unset',
    });
    await expect(caller.notify.ops.deliveries({ limit: 50 })).resolves.toEqual([]);
    await expect(caller.notify.operatorDeliveries({ limit: 50 })).resolves.toEqual([]);
  });

  it('notify.alerts omit is PRECONDITION_FAILED — never dumps every watch', async () => {
    const caller = createNotifyRouter(stubNotify()).createCaller(signed());
    await expect(caller.notify.alerts({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'notify.alerts_list_limit_unset',
    });
    await expect(caller.notify.alerts()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'notify.alerts_list_limit_unset',
    });
    await expect(caller.notify.alerts({ limit: 20 })).resolves.toEqual({
      items: [],
      evaluation: { markSource: 'dark', canFire: false, code: 'alert.price_unavailable' },
    });
  });

  it('markRead uses principal.userId — never an input user', async () => {
    let markFor: string | null = null;
    const notify = stubNotify({
      markRead: async (userId: string) => {
        markFor = userId;
        return 1;
      },
    });

    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await expect(
      createNotifyRouter(notify)
        .createCaller(signed())
        .notify.markRead({ ids: [id] }),
    ).resolves.toEqual({ marked: 1 });
    expect(markFor).toBe(USER);
  });

  it('markAllRead is principal-bound', async () => {
    let markFor: string | null = null;
    const notify = stubNotify({
      markAllRead: async (userId: string) => {
        markFor = userId;
        return 3;
      },
    });

    await expect(createNotifyRouter(notify).createCaller(signed()).notify.markAllRead()).resolves.toEqual({
      marked: 3,
    });
    expect(markFor).toBe(USER);
  });
});

describe('svc-notify mount — public surface', () => {
  it('serves health to an anonymous caller', async () => {
    await expect(createNotifyRouter(stubNotify()).createCaller(anonymous()).health()).resolves.toEqual({
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

  it('halt-all is not allFine — ok is liveness, not an invented all-clear', async () => {
    await expect(
      createNotifyRouter(stubNotify(), undefined, async () => ({
        allFine: false,
        matching: 'halted',
        code: 'notify.venue_halted',
        incidentSilence: false,
        allClear: false,
      }))
        .createCaller(anonymous())
        .health(),
    ).resolves.toMatchObject({
      ok: true,
      venueIncident: { allFine: false, matching: 'halted', code: 'notify.venue_halted' },
    });
  });
});
