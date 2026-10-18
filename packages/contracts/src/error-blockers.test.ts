import { describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { errorBlockersOf, publicProcedure, router, type Context } from './trpc.js';

class BlankLaw extends Error {
  constructor(
    readonly code: string,
    readonly blockers: readonly { code: string; sentence?: string }[],
    readonly residual: string,
  ) {
    super('Copy trading is not available yet: the list of served regions is not set.');
  }
}

const app = router({
  follow: publicProcedure.query(() => {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Copy trading is not available yet: the list of served regions is not set.',
      cause: new BlankLaw(
        'trade.copy_jurisdiction_blank',
        [{ code: 'trade.copy_jurisdiction_blank', sentence: 'internal' }],
        'DIRECTION §8',
      ),
    });
  }),
  plain: publicProcedure.query(() => {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'no', cause: new Error('no') });
  }),
});

async function wireData(path: string): Promise<Record<string, unknown>> {
  const res = await fetchRequestHandler({
    endpoint: '/trpc',
    req: new Request(`http://localhost/trpc/${path}`),
    router: app,
    createContext: () => ({}) as Context,
  });
  return ((await res.json()) as { error: { data: Record<string, unknown> } }).error.data;
}

describe('error blockers', () => {
  it('copies codes only onto the wire', async () => {
    const data = await wireData('follow');
    expect(data.blockers).toEqual([{ code: 'trade.copy_jurisdiction_blank' }]);
    expect(JSON.stringify(data)).not.toContain('DIRECTION');
    expect(JSON.stringify(data)).not.toContain('sentence');
    expect(data).not.toHaveProperty('residual');
    expect(data.cause).toEqual({ code: 'trade.copy_jurisdiction_blank' });
  });

  it('omits blockers when the cause has none', async () => {
    const data = await wireData('plain');
    expect(data).not.toHaveProperty('blockers');
  });

  it('drops a list that is not codes', () => {
    expect(errorBlockersOf({ blockers: [{ code: 'Ok Code' }] })).toBeUndefined();
    expect(errorBlockersOf({ blockers: [] })).toBeUndefined();
    expect(errorBlockersOf({})).toBeUndefined();
  });
});
