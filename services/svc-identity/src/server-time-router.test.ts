import { describe, expect, it } from 'vitest';
import { serverTimeSchema, type Context } from '@intafaced/contracts';
import { createServerTimeRouter } from './server-time-router.js';

describe('serverTime', () => {
  it('answers the service clock to anyone, signed in or not, and nothing else', async () => {
    const at = new Date('2026-10-23T02:30:00.000Z');
    const caller = createServerTimeRouter(() => at).createCaller({
      principal: null,
      service: null,
      region: 'DE',
      requestId: 'r',
    } as Context);
    const answer = await caller.serverTime();
    expect(answer).toEqual({ now: '2026-10-23T02:30:00.000Z' });
    expect(serverTimeSchema.strict().safeParse(answer).success).toBe(true);
  });
});
