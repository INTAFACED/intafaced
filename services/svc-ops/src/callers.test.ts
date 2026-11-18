import { describe, expect, it } from 'vitest';
import { SESSION_SCOPES, type Principal } from '@intafaced/auth';
import { procedureCallers, type Context } from '@intafaced/contracts';
import { OutreachError } from './outreach/config.js';
import { OpsService } from './ops-service.js';
import { createOpsRouter } from './router.js';

/**
 * Who may call each svc-ops procedure, listed from the router itself. svc-ops is the operators' service: apart from
 * the public doors below, an ordinary customer session and an API key are refused by every procedure, before it runs.
 */
const PUBLIC = [
  'health',
  'home.config',
  'outreach.addInterests',
  'outreach.answer',
  'outreach.capture',
  'outreach.publicSettings',
  'outreach.resume',
  'protocolListing.hidden',
  'valuation.prices',
];

const USER = '11111111-1111-4111-8111-111111111111';
const session = {
  sub: USER,
  userId: USER,
  sid: '22222222-2222-4222-8222-222222222222',
  scopes: [...SESSION_SCOPES],
  tier: 'full',
  mfa: true,
  expiresAt: new Date(Date.now() + 60_000),
} as Principal;
const key = { ...session, kid: 'key-1' } as Principal;

// The live entitlement reads say what identity says of a customer: not an operator.
const api = createOpsRouter(new OpsService(), {
  crm: {} as never,
  authority: async () => {
    throw new OutreachError('ops.crm.operator_forbidden');
  },
});
const rows = procedureCallers(api);

function ctx(principal: Principal): Context {
  return { principal, service: null, region: 'GB', requestId: 'callers', operatorAuthority: async () => 'not_operator' };
}

async function outcome(principal: Principal, path: string): Promise<string> {
  const caller: unknown = api.createCaller(ctx(principal));
  const fn = path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], caller) as (i?: unknown) => Promise<unknown>;
  try {
    await fn(undefined);
    return 'ran';
  } catch (err) {
    return (err as { code?: string }).code ?? 'threw';
  }
}

describe('svc-ops callers', () => {
  it('every procedure names who may call it', () => {
    expect(rows.length).toBeGreaterThan(100);
    expect(rows.filter((r) => r.caller === undefined).map((r) => r.path)).toEqual([]);
  });

  it('the public doors are exactly the reviewed list', () => {
    expect(rows.filter((r) => r.caller === 'public').map((r) => r.path)).toEqual(PUBLIC);
  });

  it.each(rows.filter((r) => r.caller !== 'public').map((r) => r.path))('%s refuses an ordinary session and an API key', async (path) => {
    expect(await outcome(session, path)).toBe('FORBIDDEN');
    expect(await outcome(key, path)).toBe('FORBIDDEN');
  });
});
