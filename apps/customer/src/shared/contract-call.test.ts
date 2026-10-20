import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { rankPerksSchema, rankStateSchema, type RankState } from '@intafaced/contracts/identity';
import { createApiClient } from './api';
import { contractProcedure, readContract, writeContract } from './contract-call';

const owner = '11111111-1111-4111-8111-111111111111';
const rank: RankState = { userId: owner, rank: 2, xp: '2500', seasonXp: '400', nextRankAt: '1500', updatedAt: '2026-10-10T08:00:00.000Z' };
const answer = (data: unknown) => async () => new Response(JSON.stringify({ result: { data } }));

describe('contract-typed calls', () => {
  const rankGet = contractProcedure('identity', 'rank.get', { output: rankStateSchema });

  it('calls the named procedure and returns the contract type', async () => {
    const seen: string[] = [];
    const api = createApiClient({
      fetch: async (url) => {
        seen.push(String(url));
        return new Response(JSON.stringify({ result: { data: rank } }));
      },
    });
    const result = await readContract(api, rankGet);
    expect(seen).toEqual(['/api/identity/trpc/rank.get']);
    expect(result).toEqual({ ok: true, data: rank });
    if (result.ok) expectTypeOf(result.data).toEqualTypeOf<RankState>();
  });

  it('refuses an answer that does not match the contract instead of passing it on', async () => {
    const api = createApiClient({ fetch: answer({ ...rank, xp: 2500 }) });
    expect(await readContract(api, rankGet)).toMatchObject({ ok: false, reason: 'invalid_response' });
  });

  it('keeps a narrowing written next to the call', async () => {
    const mine = contractProcedure('identity', 'rank.get', { output: rankStateSchema.refine((value) => value.userId === owner) });
    const api = createApiClient({ fetch: answer({ ...rank, userId: '22222222-2222-4222-8222-222222222222' }) });
    expect(await readContract(api, mine)).toMatchObject({ ok: false, reason: 'invalid_response' });
  });

  it('types a mutation input from the contract and sends it', async () => {
    const award = contractProcedure('identity', 'rank.award', {
      input: z.object({ userId: z.string().uuid(), xpDelta: z.number().int() }),
      output: rankPerksSchema.pick({ feeDiscountBps: true }),
    });
    let body: unknown;
    const api = createApiClient({
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ result: { data: { feeDiscountBps: 5 } } }));
      },
    });
    const result = await writeContract(api, award, { userId: owner, xpDelta: 1 });
    expect(body).toEqual({ userId: owner, xpDelta: 1 });
    expect(result).toEqual({ ok: true, data: { feeDiscountBps: 5 } });
    // Compile-time only: never called.
    void function refused() {
      // @ts-expect-error a mutation with an input schema needs its input
      void writeContract(api, award);
      // @ts-expect-error the input is the contract's, so a misspelt field does not compile
      void writeContract(api, award, { userId: owner, xpDelt: 1 });
    };
  });
});
