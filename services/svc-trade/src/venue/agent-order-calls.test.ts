import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import type { AgentKeyCalls } from '@intafaced/contracts';
import { AgentAccountError } from './agent-account.js';
import { InMemoryAgentConnectionStore } from './agent-connection-store.js';
import { AgentActivity, InMemoryAgentOrderCallStore, activityCsv, outcomeOf } from './agent-order-calls.js';

// The assistant connection's Activity (J-agents-21 #11): identity's call log of the key, every call, joined by request
// id with what svc-trade answered the assistant's order route; the export holds the same rows.

const USER = '11111111-1111-4111-8111-1111111111d1';
const OTHER = '11111111-1111-4111-8111-1111111111d2';
const KEY = '22222222-2222-4222-8222-2222222222d1';
const ACCOUNT = '5a5a5a5a-0000-4000-8000-0000000000d1';
const person = (userId = USER) =>
  ({
    sub: userId,
    userId,
    sid: '33333333-3333-4333-8333-3333333333d3',
    scopes: ['trade:read'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 600_000),
  }) as Principal;

const LOG: AgentKeyCalls = {
  state: 'found',
  keyId: KEY,
  asOf: '2026-11-13T10:00:05.000Z',
  calls: [
    {
      requestId: 'r4',
      method: 'POST',
      path: '/api/v1/venue/agent/orders',
      status: 422,
      outsideIpList: false,
      at: '2026-11-13T10:00:04.000Z',
    },
    {
      requestId: 'r3',
      method: 'POST',
      path: '/api/bank/trpc/cards.threeDS.answer',
      status: 403,
      outsideIpList: false,
      at: '2026-11-13T10:00:03.000Z',
    },
    { requestId: 'r2', method: 'GET', path: '/api/v1/venue/balances', status: 403, outsideIpList: false, at: '2026-11-13T10:00:02.000Z' },
    {
      requestId: 'r1',
      method: 'POST',
      path: '/api/v1/venue/agent/orders',
      status: 200,
      outsideIpList: false,
      at: '2026-11-13T10:00:01.000Z',
    },
  ],
};

async function world(answer: AgentKeyCalls | null = LOG) {
  const connections = new InMemoryAgentConnectionStore();
  await connections.connectOnce({
    keyId: KEY,
    userId: USER,
    accountId: ACCOUNT,
    createdAt: new Date('2026-11-13T09:00:00Z'),
    endedAt: null,
  });
  const log = new InMemoryAgentOrderCallStore();
  const asked: string[] = [];
  const activity = new AgentActivity({
    connections,
    log,
    calls: {
      async calls(userId, keyId, limit) {
        asked.push(`${userId}/${keyId}/${limit}`);
        return answer;
      },
    },
    now: () => new Date('2026-11-13T10:00:05Z'),
  });
  return { activity, log, asked };
}

const refusal = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AgentAccountError);
  return err as AgentAccountError;
};

describe('AgentActivity (J-agents-21 #11)', () => {
  it('one row per call, refused ones included, newest first: time, tool, outcome, and the order the call named', async () => {
    const { activity } = await world();
    expect(
      await activity.record({
        requestId: 'r1',
        keyId: KEY,
        userId: USER,
        clientOrderId: 'buy-1',
        venueOrderId: 'v-9',
        code: null,
        at: new Date(),
      }),
    ).toBe(true);
    await activity.record({
      requestId: 'r4',
      keyId: KEY,
      userId: USER,
      clientOrderId: 'too-big',
      venueOrderId: null,
      code: 'trade.venue.insufficient_balance',
      at: new Date(),
    });
    const view = await activity.list(person(), KEY);
    expect(view.accountId).toBe(ACCOUNT);
    expect(view.rows.map((r) => [r.requestId, r.tool, r.outcome, r.status, r.code, r.order])).toEqual([
      ['r4', 'place_order', 'refused', 422, 'trade.venue.insufficient_balance', { clientOrderId: 'too-big', venueOrderId: null }],
      ['r3', 'POST /api/bank/trpc/cards.threeDS.answer', 'refused', 403, null, null],
      ['r2', 'GET /api/v1/venue/balances', 'refused', 403, null, null],
      ['r1', 'place_order', 'accepted', 200, null, { clientOrderId: 'buy-1', venueOrderId: 'v-9' }],
    ]);
    expect(view.rows.map((r) => r.at.toISOString())).toEqual(LOG.state === 'found' ? LOG.calls.map((c) => c.at) : []);
  });

  it('a call is recorded once: a second record under the same request id keeps the first', async () => {
    const { activity, log } = await world();
    await activity.record({
      requestId: 'r1',
      keyId: KEY,
      userId: USER,
      clientOrderId: 'buy-1',
      venueOrderId: 'v-9',
      code: null,
      at: new Date(),
    });
    await activity.record({
      requestId: 'r1',
      keyId: KEY,
      userId: USER,
      clientOrderId: 'other',
      venueOrderId: null,
      code: 'x',
      at: new Date(),
    });
    expect(log.rows.map((r) => r.clientOrderId)).toEqual(['buy-1']);
  });

  it("another person's record under the key's request id is never shown", async () => {
    const { activity } = await world();
    await activity.record({
      requestId: 'r1',
      keyId: KEY,
      userId: OTHER,
      clientOrderId: 'theirs',
      venueOrderId: 'v-1',
      code: null,
      at: new Date(),
    });
    const view = await activity.list(person(), KEY);
    expect(view.rows.find((r) => r.requestId === 'r1')?.order).toBeNull();
  });

  it("a key the person never connected is not found, and anyone else's connection the same; identity is not asked", async () => {
    const { activity, asked } = await world();
    expect((await refusal(activity.list(person(OTHER), KEY))).status).toBe(404);
    expect((await refusal(activity.list(person(), '22222222-2222-4222-8222-2222222222ff'))).code).toBe('agents.key_not_connected');
    expect((await refusal(activity.list(person(), 'nope'))).status).toBe(404);
    expect(asked).toEqual([]);
  });

  it("identity's log unread is a refusal, never an empty Activity; its none is not found", async () => {
    expect((await refusal((await world(null)).activity.list(person(), KEY))).code).toBe('agents.activity_read_unavailable');
    expect((await refusal((await world({ state: 'none' })).activity.list(person(), KEY))).status).toBe(404);
  });

  it('asks for at most the contract maximum; a limit outside 1 to 200 refuses before identity is asked', async () => {
    const { activity, asked } = await world();
    await activity.list(person(), KEY);
    await activity.list(person(), KEY, '5');
    expect(asked).toEqual([`${USER}/${KEY}/200`, `${USER}/${KEY}/5`]);
    for (const bad of ['0', '201', '1.5', 'x']) {
      expect((await refusal(activity.list(person(), KEY, bad))).code).toBe('agents.account_request_invalid');
    }
    expect(asked).toHaveLength(2);
  });

  it("the assistant's own key can't read the Activity: the person's session only", async () => {
    const { activity } = await world();
    await expect(activity.list({ ...person(), kid: KEY } as Principal, KEY)).rejects.toThrow();
  });

  it('outcome: accepted under 400, refused 4xx, failed 5xx', () => {
    expect([200, 202, 400, 403, 422, 500, 503].map(outcomeOf)).toEqual([
      'accepted',
      'accepted',
      'refused',
      'refused',
      'refused',
      'failed',
      'failed',
    ]);
  });

  it('the export holds the same rows in the same order, a header first, and a formula-looking cell as text', async () => {
    const { activity } = await world();
    await activity.record({
      requestId: 'r1',
      keyId: KEY,
      userId: USER,
      clientOrderId: 'buy-1',
      venueOrderId: '=v-9',
      code: null,
      at: new Date(),
    });
    const view = await activity.list(person(), KEY);
    const lines = activityCsv(view.rows).trimEnd().split('\n');
    expect(lines[0]).toBe('Time,Tool,Outcome,Status,Code,Order id,Venue order id,Request id');
    expect(lines.slice(1).map((l) => l.split(',').at(-1))).toEqual(view.rows.map((r) => r.requestId));
    expect(lines[1]).toBe('2026-11-13T10:00:04.000Z,place_order,Refused,422,,,,r4');
    expect(lines[4]).toBe("2026-11-13T10:00:01.000Z,place_order,Accepted,200,,buy-1,'=v-9,r1");
  });
});
