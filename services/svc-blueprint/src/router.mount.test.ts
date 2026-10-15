import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_SCOPES, issueAccessToken, verifyAccessToken, type Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createBlueprintRouter } from './router.js';
import type { BlueprintService } from './blueprint-service.js';

/**
 * THE MOUNT BOUNDARY, for svc-blueprint (docs/decisions/mount-boundary.md).
 *
 * The context comes from `createEdgeContext` over real headers, exactly as
 * `index.ts` builds it — never a hand-written `Context` literal, which would go
 * on passing if the service started believing an unsigned header.
 *
 * This service has the sharpest version of the problem. Owner procedures
 * (`export`, `erase`, `me`, `card`, `setVisibility`) read `ctx.principal.userId`
 * and never take a userId as input. `cardOf` is the one exception: its input
 * names the SUBJECT (whose share card), and the viewer is still the signed
 * principal. That design is only worth anything if the caller cannot choose
 * whose userId ends up on the context — so `export` and `erase` are exactly as
 * safe as the signature check, and no safer.
 *
 * `blueprint` is `minTier: 'none'` in the jurisdiction matrix: the guard's job
 * here is scope and region, not verification.
 */

const SECRET = 'a-blueprint-mount-test-edge-secret-long';
const USER = '11111111-1111-4111-8111-111111111111';
const VICTIM = '99999999-9999-4999-8999-999999999999';

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-blueprint' });

beforeEach(() => {
  vi.stubEnv('APP_ENV', 'test');
  // Exercise signature, ownership and scope with the explicit legacy test posture.
  // Production keeps its strict blank-list refusal; the control below verifies it.
  vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'off');
  vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', undefined);
  vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', undefined);
});

afterEach(() => vi.unstubAllEnvs());

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['blueprint:read'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

/** No credentials of any kind — a caller who simply found the port. */
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

function stubBlueprint(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    get: async () => null,
    ...overrides,
  } as unknown as BlueprintService;
}

describe('svc-blueprint mount — authorisation', () => {
  it('refuses a signed caller before reading with blank sanctions and the default strict screening posture', async () => {
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', undefined);
    const get = vi.fn(async () => null);

    await expect(createBlueprintRouter(stubBlueprint({ get })).createCaller(signed()).me()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: { code: 'denied.screening_unconfigured' },
    });
    expect(get).not.toHaveBeenCalled();
  });

  it('refuses an anonymous caller on a scoped procedure, and reads nothing', async () => {
    let read = false;
    const blueprint = stubBlueprint({
      get: async () => {
        read = true;
        return null;
      },
    });

    await expect(createBlueprintRouter(blueprint).createCaller(anonymous()).me()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(read).toBe(false);
  });

  /**
   * THE ONE THAT MATTERS.
   *
   * The forged header names somebody else. If this ever passes, `me` is a
   * data-exfiltration endpoint for any account whose id an attacker can guess —
   * and `erase` is worse.
   */
  it('refuses a self-asserted principal naming another user, and reads nothing', async () => {
    let readFor: string | null = null;
    const blueprint = stubBlueprint({
      get: async ({ userId }: { userId: string }) => {
        readFor = userId;
        return null;
      },
    });

    const ctx = forged(principal({ sub: VICTIM, userId: VICTIM, scopes: ['blueprint:read', 'blueprint:write'] }));
    expect(ctx.principal).toBeNull();

    await expect(createBlueprintRouter(blueprint).createCaller(ctx).me()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(readFor).toBeNull();
  });

  it('refuses an anonymous caller on cardOf, and reads nothing', async () => {
    let called = false;
    const blueprint = stubBlueprint({
      cardFor: async () => {
        called = true;
        return {
          size: 'portrait' as const,
          width: 1080,
          height: 1350,
          svg: '<svg/>',
          raster: { status: 'unavailable' as const, code: 'blueprint.card_renderer_unconfigured' as const, reason: 'x' },
          shareMode: 'svg' as const,
        };
      },
    });
    await expect(
      createBlueprintRouter(blueprint).createCaller(anonymous()).cardOf({ userId: VICTIM, size: 'portrait' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(called).toBe(false);
  });

  it('accepts a principal the edge signed, and reads that principal own Blueprint', async () => {
    let readFor: string | null = null;
    const blueprint = stubBlueprint({
      get: async ({ userId }: { userId: string }) => {
        readFor = userId;
        return null;
      },
    });

    await expect(createBlueprintRouter(blueprint).createCaller(signed()).me()).resolves.toBeNull();
    expect(readFor).toBe(USER);
  });
});

/**
 * WHAT A REAL LOGIN CAN REACH ON THIS ROUTER.
 *
 * Every test above hands the router the scopes it wants. That is the right test
 * for a guard, and it is exactly how `blueprint:read` / `blueprint:write` were
 * once issued to nobody while this suite stayed green — the door worked and no
 * one on the platform had a key.
 *
 * `packages/contracts/src/session-access.test.ts` closed that, but it does so
 * against procedures that MIRROR these ones. A mirror can drift: add a
 * procedure here on a scope no session carries, and the mirror still passes.
 *
 * So this block starts from a token minted the way `AuthService.issueSession`
 * mints one — `SESSION_SCOPES`, through `issueAccessToken` and back out of
 * `verifyAccessToken` — and drives THE REAL ROUTER with it.
 */
describe('svc-blueprint mount — a real session, on the real router', () => {
  const authConfig = {
    secret: 'a-blueprint-session-signing-secret-long',
    issuer: 'intafaced',
    audience: 'intafaced.api',
    accessTtlSeconds: 900,
  };

  /** The context the edge would build for a genuinely logged-in account. */
  async function loggedIn() {
    const { token } = await issueAccessToken(
      { userId: USER, sessionId: '22222222-2222-4222-8222-222222222222', scopes: SESSION_SCOPES, tier: 'none' },
      authConfig,
    );
    const verified = await verifyAccessToken(token, authConfig);
    const raw = encodePrincipal(verified);
    return edgeContext({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: 'req-real-session',
    });
  }

  it('mints blueprint scopes into a session at all', async () => {
    // The precondition. Without it every assertion below could pass for the
    // wrong reason on a router that had stopped guarding anything.
    expect(SESSION_SCOPES).toContain('blueprint:read');
    expect(SESSION_SCOPES).toContain('blueprint:write');
  });

  it('reaches every procedure on this router — no scope is issued to nobody', async () => {
    // The stubs return schema-valid envelopes, because every procedure here
    // validates its OUTPUT too — a thinner stub fails on the response shape
    // and would tell us nothing about authorisation.
    const emptyExport = {
      exportedAt: new Date().toISOString(),
      schemaVersion: 2 as const,
      blueprint: null,
      card: null,
      crew: null,
      membership: null,
      crewmates: [],
      matchRuns: [],
      mentorMatches: [],
      mentoringOthers: [],
    };
    // Counted so `mentors` can be shown NOT to route through the export — see
    // the assertion after the calls.
    let exports = 0;
    const caller = createBlueprintRouter(
      stubBlueprint({
        get: async () => null,
        card: async () => ({
          size: 'portrait',
          width: 1080,
          height: 1350,
          svg: '<svg/>',
          raster: { status: 'unavailable', code: 'blueprint.card_renderer_unconfigured', reason: 'no renderer' },
          shareMode: 'svg' as const,
        }),
        cardFor: async () => ({
          size: 'portrait',
          width: 1080,
          height: 1350,
          svg: '<svg/>',
          raster: { status: 'unavailable', code: 'blueprint.card_renderer_unconfigured', reason: 'no renderer' },
          shareMode: 'svg' as const,
        }),
        setVisibility: async () => ({
          id: '33333333-3333-4333-8333-333333333333',
          userId: USER,
          engineVersion: 'test',
          profile: {
            decisionStyle: 'analytical',
            riskTemperament: 'measured',
            energyRhythm: 'steady',
            learningMode: 'systematic',
            crewRole: 'anchor',
            curriculumPath: 'foundations',
            toneRegister: 'direct',
            guardrails: {
              maxLeverage: 1,
              dailyLossPromptPct: 5,
              confirmBeforeMarketOrder: true,
              copyTradingVisible: false,
            },
          },
          cardAssetUrl: null,
          visibility: 'public' as const,
          createdAt: new Date().toISOString(),
        }),
        mentors: async () => [],
        export: async () => {
          exports += 1;
          return emptyExport;
        },
        erase: async () => ({
          userId: USER,
          erasedAt: new Date().toISOString(),
          removed: { blueprints: 0, crewMemberships: 0, matchRuns: 0, mentorMatches: 0, emptiedCrews: 0 },
        }),
      }),
    ).createCaller(await loggedIn());

    // Each of these is a 403 the day someone removes a scope from the issuing
    // list, or adds a procedure here gated on one that is not issued.
    await expect(caller.me()).resolves.toBeNull();
    await expect(caller.card({ size: 'portrait' })).resolves.toMatchObject({ width: 1080 });
    await expect(caller.cardOf({ userId: VICTIM, size: 'portrait' })).resolves.toMatchObject({ width: 1080 });
    await expect(caller.setVisibility({ visibility: 'public' })).resolves.toMatchObject({ visibility: 'public' });
    await expect(caller.mentors()).resolves.toEqual([]);
    await expect(caller.export()).resolves.toBeDefined();
    await expect(caller.erase()).resolves.toMatchObject({ userId: USER });

    // Exactly one — the `export()` call above. A shortlist must not drag six
    // table reads and an external rasterizer behind it.
    expect(exports).toBe(1);
  });

  it('acts on the token’s own userId, never on one the caller could choose', async () => {
    // The privacy guarantee restated against a real token: `export` has no
    // userId input, so the only id it can reach is the signed one.
    let readFor: string | null = null;
    const caller = createBlueprintRouter(
      stubBlueprint({
        get: async ({ userId }: { userId: string }) => {
          readFor = userId;
          return null;
        },
      }),
    ).createCaller(await loggedIn());

    await caller.me();
    expect(readFor).toBe(USER);
  });

  it('cardOf uses the signed principal as viewer, and the input only as subject', async () => {
    let seen: { viewerId: string; subjectUserId: string } | null = null;
    const caller = createBlueprintRouter(
      stubBlueprint({
        cardFor: async (input: { viewerId: string; subjectUserId: string }) => {
          seen = { viewerId: input.viewerId, subjectUserId: input.subjectUserId };
          return {
            size: 'portrait' as const,
            width: 1080,
            height: 1350,
            svg: '<svg/>',
            raster: { status: 'unavailable' as const, code: 'blueprint.card_renderer_unconfigured' as const, reason: 'no renderer' },
            shareMode: 'svg' as const,
          };
        },
      }),
    ).createCaller(await loggedIn());

    await caller.cardOf({ userId: VICTIM, size: 'portrait' });
    expect(seen).toEqual({ viewerId: USER, subjectUserId: VICTIM });
  });

  it('still refuses that same real token once the edge signature is stripped', async () => {
    // A valid session is not authority on its own — the edge's signature over
    // the principal is what this service trusts.
    const { token } = await issueAccessToken(
      { userId: USER, sessionId: '22222222-2222-4222-8222-222222222222', scopes: SESSION_SCOPES, tier: 'none' },
      authConfig,
    );
    const raw = encodePrincipal(await verifyAccessToken(token, authConfig));
    const unsigned = edgeContext({ headers: { 'x-intafaced-principal': raw, 'x-intafaced-region': 'DE' }, id: 'req-unsigned' });

    await expect(createBlueprintRouter(stubBlueprint()).createCaller(unsigned).card({ size: 'portrait' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});

describe('svc-blueprint mount — the public surface', () => {
  it('serves health to an anonymous caller', async () => {
    await expect(createBlueprintRouter(stubBlueprint()).createCaller(anonymous()).health()).resolves.toEqual({
      ok: true,
      service: 'svc-blueprint',
    });
  });

  it('serves health even when a forged principal was presented', async () => {
    await expect(createBlueprintRouter(stubBlueprint()).createCaller(forged()).health()).resolves.toMatchObject({ ok: true });
  });
});
