import { describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';
import type { Context } from '@intafaced/contracts/trpc';
import { JOB_CALLER, JOB_FORBIDDEN, authorizeTokenJobHttp } from './job-hmac.js';
import { createTokenRouter } from './router.js';
import type { TokenService } from './token-service.js';

/** A job twin of the real router, called as `service`: the guard refuses before the job reads the token service. */
const jobs = createTokenRouter({} as TokenService);
const asService = (service: string | null) =>
  jobs.createCaller({ principal: null, service, region: 'XX', requestId: 'r' } as Context).yield.runWindow({ windowId: 'w1' });

describe("the job twins' tRPC guard", () => {
  it('null is UNAUTHORIZED', async () => {
    const err = await asService(null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect(err).toMatchObject({ code: 'UNAUTHORIZED' });
    expect((err as TRPCError).message).toMatch(/callable only by another INTAFACED service/);
  });

  it("svc-trade is FORBIDDEN, in the job door's own words", async () => {
    const err = await asService('svc-trade').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect(err).toMatchObject({ code: 'FORBIDDEN', message: JOB_FORBIDDEN });
    // No machine code rides on it: the replay's recorded body has none.
    expect((err as TRPCError).cause).toBeUndefined();
  });

  it('svc-cron is FORBIDDEN — not an unpublished allowlist', async () => {
    const err = await asService('svc-cron').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect(err).toMatchObject({ code: 'FORBIDDEN', message: JOB_FORBIDDEN });
    // No machine code rides on it: the replay's recorded body has none.
    expect((err as TRPCError).cause).toBeUndefined();
  });

  it('svc-token passes the guard and reaches the job (unset here, so the job itself refuses)', async () => {
    const err = await asService(JOB_CALLER).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});

describe('authorizeTokenJobHttp', () => {
  it('null is 401 token.unauthenticated', () => {
    expect(authorizeTokenJobHttp(null)).toEqual({
      ok: false,
      status: 401,
      code: 'token.unauthenticated',
      error: 'service credentials required',
    });
  });

  it('svc-trade is 403 token.forbidden', () => {
    expect(authorizeTokenJobHttp('svc-trade')).toEqual({
      ok: false,
      status: 403,
      code: 'token.forbidden',
      error: JOB_FORBIDDEN,
    });
  });

  it('svc-token passes', () => {
    expect(authorizeTokenJobHttp(JOB_CALLER)).toEqual({ ok: true, service: JOB_CALLER });
  });
});
