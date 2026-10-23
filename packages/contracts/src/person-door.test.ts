import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { router, scopedProcedure, type Context } from './trpc.js';

const USER = '11111111-1111-4111-8111-111111111111';

function ctx(service: string | null): Context {
  const principal = {
    sub: USER,
    userId: USER,
    sid: '55555555-5555-4555-8555-555555555555',
    scopes: ['agents:read', 'identity:write'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  return { principal, service, region: 'DE', requestId: 'req-person' };
}

const door = router({
  set: scopedProcedure('agents:read', { person: true }).mutation(() => 'set'),
  get: scopedProcedure('agents:read').query(() => 'get'),
});

describe('person door', () => {
  it('lets the person through and refuses a service carrying that principal', async () => {
    expect(await door.createCaller(ctx(null)).set()).toBe('set');
    await expect(door.createCaller(ctx('svc-trade')).set()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'A signed-in user session is required',
    });
    expect(await door.createCaller(ctx('svc-trade')).get()).toBe('get');
  });
});
