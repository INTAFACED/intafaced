import { describe, expect, it, vi } from 'vitest';
import { SESSION_SCOPES, type Principal, type Scope } from '@intafaced/auth';
import {
  operatorProcedure,
  personProcedure,
  procedureCallers,
  protectedProcedure,
  publicProcedure,
  router,
  scopedProcedure,
  serviceProcedure,
  type Context,
  type OperatorAuthority,
} from './trpc.js';

const USER = '11111111-1111-4111-8111-111111111111';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: [...SESSION_SCOPES],
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

const OPERATOR_SCOPES: Scope[] = [...SESSION_SCOPES, 'admin:read', 'admin:write'];

function ctx(p: Principal | null, extra: Partial<Context> = {}): Context {
  return { principal: p, service: null, region: 'GB', requestId: 'r', ...extra };
}

const app = router({
  open: publicProcedure.query(() => 'ok'),
  bare: protectedProcedure.query(() => 'ok'),
  scoped: scopedProcedure('identity:read').query(() => 'ok'),
  self: personProcedure().mutation(() => 'ok'),
  selfScoped: personProcedure('identity:write').mutation(() => 'ok'),
  desk: router({ read: operatorProcedure('admin:read').query(() => 'ok') }),
  s2s: serviceProcedure.mutation(() => 'ok'),
});

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ran';
  } catch (err) {
    return (err as { code?: string }).code ?? 'threw';
  }
}

async function refusalOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (err) {
    return ((err as { cause?: { code?: string } }).cause ?? {}).code;
  }
}

describe('procedureCallers', () => {
  it('names the builder of every procedure, nested ones included, and nobody for protectedProcedure', () => {
    expect(procedureCallers(app)).toEqual([
      { path: 'bare', type: 'query', caller: undefined },
      { path: 'desk.read', type: 'query', caller: 'operator' },
      { path: 'open', type: 'query', caller: 'public' },
      { path: 's2s', type: 'mutation', caller: 'service' },
      { path: 'scoped', type: 'query', caller: 'scope' },
      { path: 'self', type: 'mutation', caller: 'person' },
      { path: 'selfScoped', type: 'mutation', caller: 'person' },
    ]);
  });

  it('keeps the caller when a procedure adds its own meta', () => {
    const r = router({
      x: personProcedure()
        .meta({})
        .query(() => 'ok'),
    });
    expect(procedureCallers(r)[0]?.caller).toBe('person');
  });
});

describe('personProcedure: the signed-in person only', () => {
  it('runs for the person’s own session', async () => {
    expect(await codeOf(() => app.createCaller(ctx(principal())).self())).toBe('ran');
  });

  it('refuses an API key, a sub-account token and a forwarding service, whatever scopes they carry', async () => {
    const callers = [
      ctx(principal({ kid: 'key-1' } as Partial<Principal>)),
      ctx(principal({ sub_account: '33333333-3333-4333-8333-333333333333' } as Partial<Principal>)),
      ctx(principal(), { service: 'svc-pay' }),
    ];
    for (const c of callers) {
      expect(await codeOf(() => app.createCaller(c).self())).toBe('FORBIDDEN');
      expect(await refusalOf(() => app.createCaller(c).self())).toBe('auth.person_session_required');
    }
  });

  it('refuses no principal as UNAUTHORIZED and a missing named scope as FORBIDDEN', async () => {
    expect(await codeOf(() => app.createCaller(ctx(null)).self())).toBe('UNAUTHORIZED');
    expect(await codeOf(() => app.createCaller(ctx(principal({ scopes: ['identity:read'] }))).selfScoped())).toBe('FORBIDDEN');
  });
});

describe('operatorProcedure: operators only', () => {
  const enabled: OperatorAuthority = async () => 'operator';

  it('runs for an operator session whose live entitlement is enabled', async () => {
    const authority = vi.fn(enabled);
    const c = ctx(principal({ scopes: OPERATOR_SCOPES }), { operatorAuthority: authority });
    expect(await codeOf(() => app.createCaller(c).desk.read())).toBe('ran');
    expect(authority).toHaveBeenCalledTimes(1);
  });

  it('refuses an ordinary session before the entitlement is read', async () => {
    const authority = vi.fn(enabled);
    const c = ctx(principal(), { operatorAuthority: authority });
    expect(await codeOf(() => app.createCaller(c).desk.read())).toBe('FORBIDDEN');
    expect(authority).not.toHaveBeenCalled();
  });

  it('refuses a key or a service carrying operator scopes', async () => {
    for (const c of [
      ctx(principal({ scopes: OPERATOR_SCOPES, kid: 'key-1' } as Partial<Principal>), { operatorAuthority: enabled }),
      ctx(principal({ scopes: OPERATOR_SCOPES }), { operatorAuthority: enabled, service: 'svc-pay' }),
    ]) {
      expect(await refusalOf(() => app.createCaller(c).desk.read())).toBe('auth.person_session_required');
    }
  });

  it('refuses when the entitlement is withdrawn, unreadable, or no authority is installed', async () => {
    const op = principal({ scopes: OPERATOR_SCOPES });
    expect(await refusalOf(() => app.createCaller(ctx(op, { operatorAuthority: async () => 'not_operator' })).desk.read())).toBe(
      'operator.forbidden',
    );
    const down = ctx(op, { operatorAuthority: async () => 'unavailable' });
    expect(await codeOf(() => app.createCaller(down).desk.read())).toBe('SERVICE_UNAVAILABLE');
    expect(await refusalOf(() => app.createCaller(down).desk.read())).toBe('operator.authority_unavailable');
    expect(await refusalOf(() => app.createCaller(ctx(op)).desk.read())).toBe('operator.authority_unconfigured');
  });

  it('does not type an ordinary session scope', () => {
    // @ts-expect-error `ops:read` is in every customer session; an operator procedure cannot name it.
    expect(() => operatorProcedure('ops:read')).not.toThrow();
  });
});
