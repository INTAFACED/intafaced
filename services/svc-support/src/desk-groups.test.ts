import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryGroupBook } from './desk-groups.js';
import { MemoryStaffBook, type StaffRole } from './desk-staff.js';
import { createSupportRouter } from './router.js';
import { SupportService } from './support-service.js';

const authConfig = {
  secret: 'a-support-desk-groups-test-secret-long-enough-xx',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const LEAD = '33333333-3333-4333-8333-333333333333';
const AGENT_A = '44444444-4444-4444-8444-444444444444';
const AGENT_B = '55555555-5555-4555-8555-555555555555';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const SESSION = '66666666-6666-4666-8666-666666666666';
const MISSING = '99999999-9999-4999-8999-999999999999';

async function ctx(userId: string): Promise<Context> {
  const { token } = await issueAccessToken(
    { userId, sessionId: SESSION, scopes: ['support:ops', 'support:read'], tier: 'none', mfa: true },
    authConfig,
  );
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-groups' };
}

async function desk(allGroupsRoles: StaffRole[] = []) {
  const groups = new MemoryGroupBook();
  const support = new SupportService(
    undefined,
    undefined,
    undefined,
    new MemoryStaffBook(),
    undefined,
    null,
    undefined,
    groups,
    allGroupsRoles,
  );
  const router = createSupportRouter(support, undefined, undefined, support);
  const as = async (userId: string) => router.createCaller(await ctx(userId));
  const lead = await as(LEAD);
  await lead.staffAppoint({ userId: LEAD, role: 'lead', idempotencyKey: 'appoint-lead-1' });
  await lead.staffAppoint({ userId: AGENT_A, role: 'agent', idempotencyKey: 'appoint-agent-a' });
  await lead.staffAppoint({ userId: AGENT_B, role: 'agent', idempotencyKey: 'appoint-agent-b' });
  const ticket = (subject: string) => support.createTicket({ userId: CUSTOMER, category: 'account', subject, body: 'Help me please' });
  return { support, groups, as, lead, ticket };
}

/** Two groups, one ticket in each, one ungrouped, agent A in group one. */
async function twoGroups() {
  const d = await desk();
  const one = await d.lead.groupsSave({ name: 'Trading', idempotencyKey: 'group-trading-1' });
  const two = await d.lead.groupsSave({ name: 'Payments', idempotencyKey: 'group-payments-1' });
  await d.lead.groupsAddMember({ groupId: one.id, userId: AGENT_A });
  await d.lead.groupsAddMember({ groupId: two.id, userId: AGENT_B });
  const inOne = await d.ticket('In trading');
  const inTwo = await d.ticket('In payments');
  const loose = await d.ticket('Not in a group');
  await d.lead.ticketSetGroup({ ticketId: inOne.id, groupId: one.id });
  await d.lead.ticketSetGroup({ ticketId: inTwo.id, groupId: two.id });
  return { ...d, one, two, inOne, inTwo, loose };
}

describe('desk groups and visibility (SP-desk-04)', () => {
  it('with no groups defined, scope is not restricted and every operator sees the queue', async () => {
    const { as, ticket } = await desk();
    await ticket('First');
    await ticket('Second');
    const agent = await as(AGENT_A);
    expect(await agent.deskScope()).toEqual({ restricted: false, groups: [], seesAllGroups: true });
    expect(await agent.listAll({ limit: 100 })).toHaveLength(2);
    expect(await agent.queueMetrics()).toMatchObject({ total: 2 });
  });

  it('an agent lists, counts and peeks only their group and their own assignments', async () => {
    const { as, one, inOne, inTwo, loose } = await twoGroups();
    const a = await as(AGENT_A);
    expect((await a.listAll({ limit: 100 })).map((t) => t.id)).toEqual([inOne.id]);
    expect(await a.queueMetrics()).toMatchObject({ total: 1, open: 1 });
    const queue = await a.listQueue({ limit: 100 });
    expect(queue.status === 'ok' ? queue.entries.map((e) => e.ticketId) : []).toEqual([inOne.id]);
    expect((await a.next())?.ticketId).toBe(inOne.id);
    expect(await a.deskScope()).toEqual({ restricted: true, groups: [{ id: one.id, name: 'Trading' }], seesAllGroups: false });
    void inTwo;
    void loose;
  });

  it('a ticket outside the scope answers exactly like no such ticket, on every door', async () => {
    const { as, inTwo } = await twoGroups();
    const a = await as(AGENT_A);
    const outside = a.get({ ticketId: inTwo.id });
    const missing = a.get({ ticketId: MISSING });
    const [o, m] = await Promise.allSettled([outside, missing]);
    expect(o.status).toBe('rejected');
    expect(m.status).toBe('rejected');
    expect((o as PromiseRejectedResult).reason).toMatchObject({ code: 'NOT_FOUND', message: (m as PromiseRejectedResult).reason.message });
    await expect(a.listComments({ ticketId: inTwo.id, limit: 50 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(a.events({ ticketId: inTwo.id, limit: 50 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(a.claim({ ticketId: inTwo.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(a.setStatus({ ticketId: inTwo.id, status: 'pending' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(a.accountState({ ticketId: inTwo.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(a.caseFile({ ticketId: inTwo.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(a.ratingOps({ ticketId: inTwo.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a ticket assigned to the agent stays visible after it is moved to another group', async () => {
    const { as, lead, two, inOne } = await twoGroups();
    const a = await as(AGENT_A);
    await a.claim({ ticketId: inOne.id });
    await lead.ticketSetGroup({ ticketId: inOne.id, groupId: two.id });
    expect((await a.listAll({ limit: 100 })).map((t) => t.id)).toEqual([inOne.id]);
    await expect(a.get({ ticketId: inOne.id })).resolves.toMatchObject({ id: inOne.id });
  });

  it('an ungrouped ticket is seen by a lead, not by an agent, and an owner-marked role sees everything', async () => {
    const { as, loose } = await twoGroups();
    expect((await (await as(LEAD)).listAll({ limit: 100 })).map((t) => t.id)).toContain(loose.id);
    expect((await (await as(AGENT_A)).listAll({ limit: 100 })).map((t) => t.id)).not.toContain(loose.id);

    const wide = await desk(['agent']);
    const g = await wide.lead.groupsSave({ name: 'Only', idempotencyKey: 'group-only-001' });
    await wide.ticket('Ungrouped');
    const agent = await wide.as(AGENT_A);
    expect(await agent.listAll({ limit: 100 })).toHaveLength(1);
    expect(await agent.deskScope()).toMatchObject({ restricted: true, seesAllGroups: true, groups: [{ id: g.id }] });
  });

  it('a membership change shows on the next read and leaves one log row', async () => {
    const { as, lead, groups, two, inTwo } = await twoGroups();
    const a = await as(AGENT_A);
    expect(await a.listAll({ limit: 100 })).toHaveLength(1);
    await lead.groupsAddMember({ groupId: two.id, userId: AGENT_A });
    expect((await a.listAll({ limit: 100 })).map((t) => t.id)).toContain(inTwo.id);
    expect(groups.log.filter((e) => e.action === 'member_added' && e.subject === AGENT_A && e.groupId === two.id)).toHaveLength(1);
    await lead.groupsRemoveMember({ groupId: two.id, userId: AGENT_A });
    expect((await a.listAll({ limit: 100 })).map((t) => t.id)).not.toContain(inTwo.id);
    expect(groups.log.filter((e) => e.action === 'member_removed')).toHaveLength(1);
  });

  it('refuses a non-lead, an unknown group, a duplicate member and a taken name with typed codes', async () => {
    const { as, lead, one, inOne } = await twoGroups();
    const a = await as(AGENT_A);
    await expect(a.groupsSave({ name: 'Mine', idempotencyKey: 'group-mine-0001' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(a.groupsAddMember({ groupId: one.id, userId: AGENT_B })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(a.ticketSetGroup({ ticketId: inOne.id, groupId: null })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(lead.groupsAddMember({ groupId: MISSING, userId: AGENT_A })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(lead.ticketSetGroup({ ticketId: inOne.id, groupId: MISSING })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(lead.groupsAddMember({ groupId: one.id, userId: AGENT_A })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(lead.groupsSave({ name: 'Trading', idempotencyKey: 'group-trading-2' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('a replayed group save returns the first group; the same key with another name is a conflict', async () => {
    const { lead, groups } = await desk();
    const first = await lead.groupsSave({ name: 'Billing', idempotencyKey: 'group-billing-1' });
    const again = await lead.groupsSave({ name: 'Billing', idempotencyKey: 'group-billing-1' });
    expect(again.id).toBe(first.id);
    expect(await groups.list()).toHaveLength(1);
    await expect(lead.groupsSave({ name: 'Other', idempotencyKey: 'group-billing-1' })).rejects.toMatchObject({ code: 'CONFLICT' });
    const renamed = await lead.groupsSave({ groupId: first.id, name: 'Billing and tax', idempotencyKey: 'group-billing-2' });
    expect(renamed).toMatchObject({ id: first.id, name: 'Billing and tax' });
  });

  it('a customer who holds support:ops still reads their own ticket outside their scope', async () => {
    const { as, support, one } = await twoGroups();
    void one;
    const own = await support.createTicket({ userId: AGENT_A, category: 'account', subject: 'My own', body: 'My own question' });
    const a = await as(AGENT_A);
    await expect(a.get({ ticketId: own.id })).resolves.toMatchObject({ id: own.id });
  });
});
