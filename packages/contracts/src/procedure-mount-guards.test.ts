import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from './index.js';
import { defineProcedure, NO_INPUT, type Access } from './procedure.js';
import { mountRecords, type ServiceParts } from './procedure-mount.js';
import { router, scopedProcedure, TRPCError, type GuardOptions, type ServiceCheck } from './trpc.js';

/**
 * A guard a service wrote by hand, and the record the call-records codemod copies it onto, refuse exactly the same
 * callers with exactly the same code. The hand guards here are the ones the services wrote before the record could say
 * them (svc-agents' `operator(scope)` and `executeProcedure()`, svc-ops' `guards` options).
 */

const SECRET = 'a-procedure-mount-guards-test-edge-secret-long';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-quant' });

interface Caller {
  readonly scopes: string[];
  readonly kid?: string;
  readonly sub_account?: string;
  readonly region?: string;
}

async function contextOf(c: Caller) {
  const principal = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: c.scopes,
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...(c.kid === undefined ? {} : { kid: c.kid }),
    ...(c.sub_account === undefined ? {} : { sub_account: c.sub_account }),
  } as Principal;
  const raw = encodePrincipal(principal);
  const region = c.region ?? 'DE';
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, region),
      'x-intafaced-region': region,
    },
    id: 'signed',
  });
}

const output = z.object({ ok: z.literal(true) });

/** The record for `access`, mounted as `guarded`, and the hand guard's procedure at the same path. */
function both(access: Access & { caller: 'scope' }, hand: ReturnType<typeof scopedProcedure>, parts: ServiceParts = () => undefined) {
  const RECORD = defineProcedure({
    service: 'svc-quant',
    module: 'quant',
    transport: 'trpc',
    name: 'example.guarded',
    kind: 'query',
    path: 'guarded',
    access,
    refusals: {},
    input: NO_INPUT,
    output,
    samples: [{ verdict: 'accept' }],
  });
  const fromRecord = mountRecords([RECORD] as const, { 'example.guarded': () => ({ ok: true as const }) }, parts);
  const byHand = router({ guarded: hand.output(output).query(() => ({ ok: true as const })) });
  type Ctx = Awaited<ReturnType<typeof contextOf>>;
  return {
    fromRecord: (ctx: Ctx) => fromRecord.createCaller(ctx).guarded(),
    byHand: (ctx: Ctx) => byHand.createCaller(ctx).guarded(),
  };
}

/** What a caller gets: the answer, or the refusal's code and message. */
async function verdict(call: ReturnType<typeof both>['fromRecord'], c: Caller) {
  try {
    return await call(await contextOf(c));
  } catch (err) {
    if (err instanceof TRPCError) return { refused: err.code, message: err.message };
    throw err;
  }
}

const KEY = 'key-1';
const SUB = '33333333-3333-4333-8333-333333333333';

describe('a guard copied onto its record refuses as the hand guard did', () => {
  it("svc-agents' operator(scope): an API key and a sub-account are refused with the call's own code, through the record", async () => {
    // svc-agents fleet/control.ts before the record could say it.
    const hand = scopedProcedure('admin:read', { module: 'agents', person: true }).use(({ ctx, next }) => {
      if (ctx.principal.kid || ctx.principal.sub_account) throw new TRPCError({ code: 'FORBIDDEN', message: 'agents.fleet_person_only' });
      return next();
    });
    const { fromRecord, byHand } = both(
      { caller: 'scope', scope: 'admin:read', module: 'agents', person: true, ownSession: 'agents.fleet_person_only' },
      hand,
    );
    const callers: Caller[] = [
      { scopes: ['admin:read'] },
      { scopes: ['admin:read'], kid: KEY },
      { scopes: ['admin:read'], sub_account: SUB },
      { scopes: [], kid: KEY },
      { scopes: [] },
    ];
    for (const c of callers) expect(await verdict(fromRecord, c), JSON.stringify(c)).toEqual(await verdict(byHand, c));
    expect(await verdict(fromRecord, { scopes: ['admin:read'] })).toEqual({ ok: true });
    // admin:read is interactive-only, so the scope check refuses the key first, as it did by hand.
    expect(await verdict(fromRecord, { scopes: ['admin:read'], kid: KEY })).toMatchObject({ refused: 'FORBIDDEN' });
    expect(await verdict(fromRecord, { scopes: ['admin:read'], sub_account: SUB })).toEqual({
      refused: 'FORBIDDEN',
      message: 'agents.fleet_person_only',
    });
  });

  it("svc-agents' executeProcedure(): a key and a sub-account are refused as before", async () => {
    const hand = scopedProcedure('agents:execute', { module: 'agents', person: true }).use(({ ctx, next }) => {
      if (ctx.principal.kid || ctx.principal.sub_account) throw new TRPCError({ code: 'FORBIDDEN', message: 'agents.execute_person_only' });
      return next();
    });
    const { fromRecord, byHand } = both(
      { caller: 'scope', scope: 'agents:execute', module: 'agents', person: true, ownSession: 'agents.execute_person_only' },
      hand,
    );
    for (const c of [
      { scopes: ['agents:execute'] },
      { scopes: ['agents:execute'], kid: KEY },
      { scopes: ['agents:execute'], sub_account: SUB },
    ])
      expect(await verdict(fromRecord, c), JSON.stringify(c)).toEqual(await verdict(byHand, c));
    // agents:execute is the person's own in packages/auth, so the scope check refuses a key and a sub-account first, as it did by hand.
    expect(await verdict(fromRecord, { scopes: ['agents:execute'], kid: KEY })).toMatchObject({ refused: 'FORBIDDEN' });
    expect(await verdict(fromRecord, { scopes: ['agents:execute'], sub_account: SUB })).toMatchObject({ refused: 'FORBIDDEN' });
  });

  it("svc-agents' personReadProcedure(): an API key holding agents:read reaches the call's own code, through the record", async () => {
    const hand = scopedProcedure('agents:read', { module: 'agents', person: true }).use(({ ctx, next }) => {
      if (ctx.principal.kid || ctx.principal.sub_account) throw new TRPCError({ code: 'FORBIDDEN', message: 'agents.select_person_only' });
      return next();
    });
    const { fromRecord, byHand } = both(
      { caller: 'scope', scope: 'agents:read', module: 'agents', person: true, ownSession: 'agents.select_person_only' },
      hand,
    );
    for (const c of [{ scopes: ['agents:read'] }, { scopes: ['agents:read'], kid: KEY }, { scopes: ['agents:read'], sub_account: SUB }])
      expect(await verdict(fromRecord, c), JSON.stringify(c)).toEqual(await verdict(byHand, c));
    expect(await verdict(fromRecord, { scopes: ['agents:read'] })).toEqual({ ok: true });
    expect(await verdict(fromRecord, { scopes: ['agents:read'], kid: KEY })).toEqual({
      refused: 'FORBIDDEN',
      message: 'agents.select_person_only',
    });
    expect(await verdict(fromRecord, { scopes: ['agents:read'], sub_account: SUB })).toEqual({
      refused: 'FORBIDDEN',
      message: 'agents.select_person_only',
    });
  });

  it("svc-ops' guards const ({ module: 'core-ops', plane: 'fiat' }): the jurisdiction check holds through the record", async () => {
    const guards: GuardOptions = { module: 'core-ops' as const, plane: 'fiat' as const };
    const { fromRecord, byHand } = both(
      { caller: 'scope', scope: 'admin:read', module: 'core-ops', plane: 'fiat' },
      scopedProcedure('admin:read', guards),
    );
    const regions = ['DE', 'US', 'GB', 'KP', 'IR', 'CU', 'SY', 'RU'];
    const seen: unknown[] = [];
    for (const region of regions) {
      const c = { scopes: ['admin:read'], region };
      const got = await verdict(fromRecord, c);
      expect(got, region).toEqual(await verdict(byHand, c));
      seen.push(got);
    }
    // The option is live: at least one region is refused by it and one is served.
    expect(seen).toContainEqual({ ok: true });
    expect(seen.some((v) => typeof v === 'object' && v !== null && 'refused' in v)).toBe(true);
  });

  it("svc-p2p's merchantApiProcedure(scope): an API key without merchant standing is refused by the service's own check, through the record", async () => {
    // The service reads standing live; here, a key's account stands when `standing` says so.
    let standing = true;
    const message = 'P2P API-key access requires current approved merchant standing. Use an interactive session to review or apply.';
    const merchantApi: ServiceCheck = ({ principal }) => {
      if (principal.kid && !standing) throw new TRPCError({ code: 'FORBIDDEN', message });
    };
    // svc-p2p router.ts before the record could say it (its module option is held as svc-ops' is, above).
    const hand = scopedProcedure('p2p:read').use(({ ctx, next }) => {
      if (ctx.principal.kid && !standing) throw new TRPCError({ code: 'FORBIDDEN', message });
      return next();
    });
    const { fromRecord, byHand } = both({ caller: 'scope', scope: 'p2p:read', check: 'merchantApi' }, hand, {
      refusalOf: () => undefined,
      checks: { merchantApi },
    });
    const callers: Caller[] = [{ scopes: ['p2p:read'] }, { scopes: ['p2p:read'], kid: KEY }, { scopes: [], kid: KEY }];
    for (const s of [true, false]) {
      standing = s;
      for (const c of callers) expect(await verdict(fromRecord, c), `${s} ${JSON.stringify(c)}`).toEqual(await verdict(byHand, c));
    }
    standing = false;
    expect(await verdict(fromRecord, { scopes: ['p2p:read'] })).toEqual({ ok: true });
    expect(await verdict(fromRecord, { scopes: ['p2p:read'], kid: KEY })).toEqual({ refused: 'FORBIDDEN', message });
    standing = true;
    expect(await verdict(fromRecord, { scopes: ['p2p:read'], kid: KEY })).toEqual({ ok: true });
  });

  it('a record naming a check its service did not hand over fails at mount, not at the first call', () => {
    expect(() => both({ caller: 'scope', scope: 'p2p:read', check: 'merchantApi' }, scopedProcedure('p2p:read'))).toThrow(
      "example.guarded names the check merchantApi: mount it with the service's checks",
    );
  });
});
