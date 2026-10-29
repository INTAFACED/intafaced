import { describe, expect, it, vi } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createSupportRouter } from './router.js';
import { MemorySupportStore } from './store.js';
import { SupportService } from './support-service.js';
import { MemoryLifecycleBook } from './ticket-lifecycle.js';

/**
 * A comment sent from code (SP-api-01, J-support-public-09 #4 and #5): the same client request id twice is one comment,
 * and the owner's cap on a requester's comments per request refuses at the cap and, while blank, refuses every one.
 */

const authConfig = {
  secret: 'a-support-comment-key-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const AGENT = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const SESSION = '66666666-6666-4666-8666-666666666666';

async function ctx(userId: string, scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-comment-key' };
}

function desk(cap: number | null, store = new MemorySupportStore(), lifecycle = new MemoryLifecycleBook()) {
  const support = new SupportService(
    store,
    undefined,
    undefined,
    undefined,
    undefined,
    null,
    undefined,
    undefined,
    [],
    undefined,
    lifecycle,
    undefined,
    undefined,
    null,
    undefined,
    cap,
  );
  const router = createSupportRouter(support);
  const customer = async () => router.createCaller(await ctx(CUSTOMER, ['support:read', 'support:write']));
  const agent = async () => router.createCaller(await ctx(AGENT, ['support:ops', 'support:read', 'support:write']));
  const ticket = () => support.createTicket({ userId: CUSTOMER, category: 'account', subject: 'TEST help', body: 'TEST body' });
  return { support, store, lifecycle, customer, agent, ticket };
}

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (err: { message?: string }) => err.message?.split(' ')[0],
  );

describe('a comment with a client request id', () => {
  it('sent twice is one comment, and the second answer is the first comment', async () => {
    const { customer, ticket } = desk(5);
    const t = await ticket();
    const me = await customer();
    const first = await me.comment({ ticketId: t.id, body: 'TEST from code', clientRequestId: 'bot:comment:1' });
    const again = await me.comment({ ticketId: t.id, body: 'TEST from code', clientRequestId: 'bot:comment:1' });
    expect(again).toEqual(first);
    expect(await me.listComments({ ticketId: t.id, limit: 50 })).toEqual([first]);
  });

  it('with other text under the same id refuses and stores nothing', async () => {
    const { customer, ticket } = desk(5);
    const t = await ticket();
    const me = await customer();
    await me.comment({ ticketId: t.id, body: 'TEST one', clientRequestId: 'bot:comment:2' });
    expect(await code(me.comment({ ticketId: t.id, body: 'TEST two', clientRequestId: 'bot:comment:2' }))).toBe(
      'support.idempotency_conflict',
    );
    expect(await me.listComments({ ticketId: t.id, limit: 50 })).toHaveLength(1);
  });

  it('replayed once the request is at its cap still answers the first comment, and moves nothing again', async () => {
    const { customer, agent, lifecycle, ticket } = desk(1);
    const t = await ticket();
    const me = await customer();
    const first = await me.comment({ ticketId: t.id, body: 'TEST last one', clientRequestId: 'bot:comment:3' });
    // The team answers, so the request now waits on the customer; a replay must not hand it back to the team.
    await (await agent()).comment({ ticketId: t.id, body: 'TEST answer' });
    const waiting = await lifecycle.get(t.id);
    expect(await me.comment({ ticketId: t.id, body: 'TEST last one', clientRequestId: 'bot:comment:3' })).toEqual(first);
    expect(await lifecycle.get(t.id)).toEqual(waiting);
  });

  it('replayed when the team answered in the same millisecond still moves nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-23T20:00:00.000Z') });
    try {
      const { customer, agent, lifecycle, ticket } = desk(1);
      const t = await ticket();
      const me = await customer();
      const first = await me.comment({ ticketId: t.id, body: 'TEST same instant', clientRequestId: 'bot:comment:same-ms' });
      await (await agent()).comment({ ticketId: t.id, body: 'TEST answer in the same millisecond' });
      const waiting = await lifecycle.get(t.id);
      expect(waiting.waitingOn).toBe('customer');
      expect(await me.comment({ ticketId: t.id, body: 'TEST same instant', clientRequestId: 'bot:comment:same-ms' })).toEqual(first);
      expect(await lifecycle.get(t.id)).toEqual(waiting);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replayed after the first call died before the lifecycle, settles the lifecycle the first call never wrote', async () => {
    let failOnce = true;
    const lifecycle = new (class extends MemoryLifecycleBook {
      override async setWaiting(...args: Parameters<MemoryLifecycleBook['setWaiting']>): Promise<void> {
        if (failOnce) {
          failOnce = false;
          throw new Error('TEST lifecycle write lost');
        }
        return super.setWaiting(...args);
      }
    })();
    const { customer, ticket } = desk(5, undefined, lifecycle);
    const t = await ticket();
    const me = await customer();
    await expect(me.comment({ ticketId: t.id, body: 'TEST reply', clientRequestId: 'bot:comment:5' })).rejects.toThrow();
    expect((await lifecycle.get(t.id)).waitingOn).toBeNull();
    const replay = await me.comment({ ticketId: t.id, body: 'TEST reply', clientRequestId: 'bot:comment:5' });
    expect(await me.listComments({ ticketId: t.id, limit: 50 })).toEqual([replay]);
    expect((await lifecycle.get(t.id)).waitingOn).toBe('team');
  });

  it('replayed after the cap was blanked still answers the comment that landed', async () => {
    const store = new MemorySupportStore();
    const before = desk(5, store);
    const t = await before.ticket();
    const first = await (await before.customer()).comment({ ticketId: t.id, body: 'TEST sent', clientRequestId: 'bot:comment:6' });
    const after = desk(null, store);
    expect(await (await after.customer()).comment({ ticketId: t.id, body: 'TEST sent', clientRequestId: 'bot:comment:6' })).toEqual(first);
    expect(await code((await after.customer()).comment({ ticketId: t.id, body: 'TEST new' }))).toBe('support.comment_cap_unset');
  });

  it('refuses a blank or oversized id', async () => {
    const { support, ticket } = desk(5);
    const t = await ticket();
    for (const clientRequestId of ['   ', 'x'.repeat(201)]) {
      await expect(support.comment({ userId: CUSTOMER, ticketId: t.id, body: 'TEST', clientRequestId })).rejects.toMatchObject({
        code: 'support.client_request_id_required',
      });
    }
  });
});

describe("the owner's comment cap per request", () => {
  it('at the cap refuses support.comment_cap_reached and stores nothing; the team can still answer', async () => {
    const { customer, agent, ticket } = desk(2);
    const t = await ticket();
    const me = await customer();
    await me.comment({ ticketId: t.id, body: 'TEST 1' });
    await me.comment({ ticketId: t.id, body: 'TEST 2' });
    expect(await code(me.comment({ ticketId: t.id, body: 'TEST 3', clientRequestId: 'bot:comment:4' }))).toBe(
      'support.comment_cap_reached',
    );
    expect(await (await agent()).comment({ ticketId: t.id, body: 'TEST answer' })).toMatchObject({ authorRole: 'operator' });
    expect((await me.listComments({ ticketId: t.id, limit: 50 })).map((c) => c.body)).toEqual(['TEST 1', 'TEST 2', 'TEST answer']);
  });

  it('blank refuses every requester comment support.comment_cap_unset, naming the setting, and the team is not capped', async () => {
    const { support, customer, agent, ticket } = desk(null);
    const t = await ticket();
    expect(await code((await customer()).comment({ ticketId: t.id, body: 'TEST' }))).toBe('support.comment_cap_unset');
    await expect(support.comment({ userId: CUSTOMER, ticketId: t.id, body: 'TEST' })).rejects.toMatchObject({
      code: 'support.comment_cap_unset',
      missingKey: 'support.comment_cap',
    });
    expect(await (await agent()).comment({ ticketId: t.id, body: 'TEST answer' })).toMatchObject({ authorRole: 'operator' });
    expect(await support.listComments({ userId: CUSTOMER, ticketId: t.id, limit: 50 })).toHaveLength(1);
  });
});

describe('a reply still holding a macro placeholder (SP-desk-02)', () => {
  it('the team cannot send it: support.macro_placeholder_blank, nothing stored; the requester may type braces', async () => {
    const { customer, agent, ticket } = desk(5);
    const t = await ticket();
    const team = await agent();
    expect(await code(team.comment({ ticketId: t.id, body: 'Hi {{requester.name}}, about your request.' }))).toBe(
      'support.macro_placeholder_blank',
    );
    expect(await code(team.comment({ ticketId: t.id, body: 'Hi {{ agent.name }}' }))).toBe('support.macro_placeholder_blank');
    const me = await customer();
    expect((await me.listComments({ ticketId: t.id, limit: 50 })).map((c) => c.body)).toEqual([]);
    await me.comment({ ticketId: t.id, body: 'TEST {{requester.name}}' });
    expect(await team.comment({ ticketId: t.id, body: 'Hi, about your request.' })).toMatchObject({ authorRole: 'operator' });
    expect((await me.listComments({ ticketId: t.id, limit: 50 })).map((c) => c.body)).toEqual([
      'TEST {{requester.name}}',
      'Hi, about your request.',
    ]);
  });
});
