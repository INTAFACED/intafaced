import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineProcedure } from '@intafaced/contracts/procedure';
import type { ActionSpec, BankWriteRecord } from './components';
import { refusal, sendReviewed, wire } from './write-flow';

// A bank write a spec sends by its record, as the call-records codemod leaves one once svc-bank's record exists.
const BANK_EARN_DEPOSIT = defineProcedure({
  service: 'svc-bank',
  module: 'bank',
  transport: 'trpc',
  name: 'bank.earn.deposit',
  kind: 'mutation',
  path: 'earn.deposit',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ positionId: z.string(), poolId: z.string(), amount: z.string() }),
  output: z.object({ positionId: z.string(), maturesAt: z.string().nullable() }),
  samples: [
    { verdict: 'accept', input: { positionId: 'p1', poolId: 'pool', amount: '1' } },
    { verdict: 'refuse', input: 42 },
  ],
}) satisfies BankWriteRecord;

const requestId = '0c1f0a52-5c7f-4c1c-8e7b-6f2d3b9a1e44';
const spec = (over: Partial<ActionSpec> = {}): ActionSpec =>
  ({
    title: 'Deposit',
    record: BANK_EARN_DEPOSIT,
    notes: [],
    input: (values, id) => ({ positionId: id, poolId: 'pool', amount: values.amount }),
    ...over,
  }) as ActionSpec;
const sentTo = (answer: Response) => {
  const seen: { url: string; body: unknown }[] = [];
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return answer;
  }) as typeof fetch;
  return { seen, fetcher };
};

describe('a bank write sent by its record', () => {
  it('posts the reviewed request to its record path and settles on an answer that matches what was reviewed', async () => {
    const { seen, fetcher } = sentTo(wire({ positionId: requestId, maturesAt: null }));
    const { outcome } = await sendReviewed(spec(), { amount: '5' }, requestId, fetcher);
    expect(outcome).toEqual({ ok: true, data: { positionId: requestId, maturesAt: null } });
    expect(seen).toEqual([{ url: '/api/bank/trpc/earn.deposit', body: { positionId: requestId, poolId: 'pool', amount: '5' } }]);
  });

  it('holds the answer to the bank write review: another position reads as unverified, never as done', async () => {
    const { fetcher } = sentTo(wire({ positionId: 'someone-else', maturesAt: null }));
    const { outcome } = await sendReviewed(spec(), { amount: '5' }, requestId, fetcher);
    expect(outcome).toMatchObject({ ok: false, reason: 'uncertain' });
  });

  it("holds the answer to the spec's own check, and to the record's shape", async () => {
    const checked = await sendReviewed(
      spec({ verifyOutcome: () => false }),
      { amount: '5' },
      requestId,
      sentTo(wire({ positionId: requestId, maturesAt: null })).fetcher,
    );
    expect(checked.outcome).toMatchObject({ ok: false, reason: 'uncertain' });
    const shapeless = await sendReviewed(spec(), { amount: '5' }, requestId, sentTo(wire({ positionId: requestId })).fetcher);
    expect(shapeless.outcome).toMatchObject({ ok: false, reason: 'uncertain' });
  });

  it('reads a typed refusal under the record path as it does under the name', async () => {
    const { outcome } = await sendReviewed(spec(), { amount: '5' }, requestId, sentTo(refusal(409, 'bank.earn_pool_closed')).fetcher);
    expect(outcome.ok).toBe(false);
  });
});
