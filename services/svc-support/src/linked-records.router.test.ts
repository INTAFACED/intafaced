import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { LinkedRecords, MemoryLinkBook, type RecordOwnershipDoor } from './linked-records.js';
import { createSupportRouter } from './router.js';
import { MemorySupportStore } from './store.js';
import { SupportService } from './support-service.js';

/**
 * J-support-public-20 #1 through the router, as the desk calls it: `linkRecord` refuses another customer's record and a
 * missing one with `support.link_record_not_owned`, names the owner when it gives no answer, takes no customer id, and is
 * the desk's alone. A refused link leaves `linkedRecords` empty.
 */

const authConfig = {
  secret: 'a-support-linked-records-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const AGENT = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SESSION = '66666666-6666-4666-8666-666666666666';
const MINE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const THEIRS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MISSING = '00000000-0000-4000-8000-000000000000';

async function ctx(userId: string, scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-linked-records' };
}

async function desk(door: RecordOwnershipDoor) {
  const support = new SupportService(new MemorySupportStore());
  const links = new LinkedRecords(new MemoryLinkBook(), support, door);
  const u = undefined;
  const router = createSupportRouter(support, u, u, support, u, u, u, u, u, u, u, u, u, u, u, links);
  const customer = router.createCaller(await ctx(CUSTOMER, ['support:read', 'support:write']));
  const agent = router.createCaller(await ctx(AGENT, ['support:ops', 'support:read', 'support:write']));
  const ticket = await customer.create({ category: 'deposit_withdraw', subject: 'TEST withdrawal missing', body: 'TEST it never came' });
  return { customer, agent, ticketId: ticket.id };
}

const svcPay: RecordOwnershipDoor = {
  configured: true,
  owns: async ({ kind, recordId, userId }) =>
    (kind === 'withdrawal' && recordId === MINE && userId === CUSTOMER) || (kind === 'deposit' && recordId === THEIRS && userId === OTHER),
};

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (err: { message?: string; code?: string }) => `${err.code} ${err.message}`,
  );

describe('linkRecord through the router', () => {
  it("links the customer's own withdrawal, and refuses another customer's record and a missing one alike", async () => {
    const { agent, ticketId } = await desk(svcPay);
    for (const [kind, recordId] of [
      ['deposit', THEIRS],
      ['withdrawal', MISSING],
    ] as const)
      expect(await refusal(agent.linkRecord({ ticketId, kind, recordId }))).toBe('BAD_REQUEST support.link_record_not_owned');
    expect(await agent.linkedRecords({ ticketId })).toEqual({ records: [] });
    const link = await agent.linkRecord({ ticketId, kind: 'withdrawal', recordId: MINE });
    expect(link).toMatchObject({ ticketId, kind: 'withdrawal', recordId: MINE, linkedBy: AGENT });
    expect(await agent.linkedRecords({ ticketId })).toEqual({ records: [link] });
  });

  it('names the owning service when it is the blocker', async () => {
    const dark = await desk({ configured: true, owns: async () => null });
    expect(await refusal(dark.agent.linkRecord({ ticketId: dark.ticketId, kind: 'withdrawal', recordId: MINE }))).toBe(
      'PRECONDITION_FAILED support.link_record_owner_unreachable svc-pay',
    );
    expect(await refusal(dark.agent.linkRecord({ ticketId: dark.ticketId, kind: 'order', recordId: MINE }))).toBe(
      'PRECONDITION_FAILED support.link_record_owner_unwired svc-trade',
    );
    expect(await dark.agent.linkedRecords({ ticketId: dark.ticketId })).toEqual({ records: [] });
  });

  it('takes no customer id, is the desk alone, and answers an unknown ticket as not found', async () => {
    const { agent, customer, ticketId } = await desk(svcPay);
    expect(
      await refusal(
        agent.linkRecord({ ticketId, kind: 'withdrawal', recordId: THEIRS, userId: OTHER } as unknown as Parameters<
          typeof agent.linkRecord
        >[0]),
      ),
    ).toMatch(/^BAD_REQUEST [\s\S]*unrecognized_keys/);
    expect(await refusal(customer.linkRecord({ ticketId, kind: 'withdrawal', recordId: MINE }))).toMatch(/^FORBIDDEN/);
    expect(await refusal(customer.linkedRecords({ ticketId }))).toMatch(/^FORBIDDEN/);
    expect(await refusal(agent.linkRecord({ ticketId: OTHER, kind: 'withdrawal', recordId: MINE }))).toMatch(/^NOT_FOUND/);
    // The customer's own read of the ticket carries no links.
    await agent.linkRecord({ ticketId, kind: 'withdrawal', recordId: MINE });
    expect(JSON.stringify(await customer.get({ ticketId }))).not.toContain(MINE);
  });
});
