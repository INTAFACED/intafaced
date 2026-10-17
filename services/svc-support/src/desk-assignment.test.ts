import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createSupportRouter } from './router.js';
import { SupportService } from './support-service.js';

const authConfig = {
  secret: 'a-support-desk-assignment-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const USER = '11111111-1111-4111-8111-111111111111';
const LEAD = '33333333-3333-4333-8333-333333333333';
const AGENT = '44444444-4444-4444-8444-444444444444';
const PLAIN = '55555555-5555-4555-8555-555555555555';
const SESSION = '66666666-6666-4666-8666-666666666666';

async function ctx(userId: string, scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-desk' };
}

describe('support desk assignment', () => {
  it('refuses queue metrics without support:ops and counts the whole queue', async () => {
    const support = new SupportService();
    const router = createSupportRouter(support);
    await support.createTicket({ userId: USER, category: 'account', subject: 'One', body: 'Body of one' });
    await support.createTicket({ userId: USER, category: 'account', subject: 'Two', body: 'Body of two' });
    const plain = router.createCaller(await ctx(PLAIN, ['support:read']));
    await expect(plain.queueMetrics()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const lead = router.createCaller(await ctx(LEAD, ['support:ops']));
    const metrics = await lead.queueMetrics();
    expect(metrics).toMatchObject({ total: 2, open: 2, pending: 0, unassigned: 2, claimed: 0 });
  });

  it('lets the assignee unclaim, and only a lead reassign to another staff member', async () => {
    const support = new SupportService();
    const router = createSupportRouter(support);
    const lead = router.createCaller(await ctx(LEAD, ['support:ops']));
    const agent = router.createCaller(await ctx(AGENT, ['support:ops']));
    await lead.staffAppoint({ userId: LEAD, role: 'lead', idempotencyKey: 'appoint-lead-1' });
    await lead.staffAppoint({ userId: AGENT, role: 'agent', idempotencyKey: 'appoint-agent-1' });
    const ticket = await support.createTicket({ userId: USER, category: 'account', subject: 'Stuck', body: 'Please look' });
    const claimed = await agent.claim({ ticketId: ticket.id });
    expect(claimed.assigneeId).toBe(AGENT);

    await expect(agent.assign({ ticketId: ticket.id, assigneeId: LEAD, idempotencyKey: 'agent-cannot-assign' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    const moved = await lead.assign({ ticketId: ticket.id, assigneeId: LEAD, idempotencyKey: 'lead-reassign-1' });
    expect(moved.assigneeId).toBe(LEAD);
    const again = await lead.assign({ ticketId: ticket.id, assigneeId: LEAD, idempotencyKey: 'lead-reassign-1' });
    expect(again.id).toBe(moved.id);
    expect(again.updatedAt).toBe(moved.updatedAt);

    const released = await lead.unclaim({ ticketId: ticket.id, idempotencyKey: 'lead-unclaim-1' });
    expect(released.assigneeId).toBeNull();
    const metrics = await lead.queueMetrics();
    expect(metrics).toMatchObject({ total: 1, unassigned: 1, claimed: 0 });
  });
});
