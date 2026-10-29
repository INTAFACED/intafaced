import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryGroupBook } from './desk-groups.js';
import { MemoryPropertiesBook } from './desk-properties.js';
import { MemoryStaffBook } from './desk-staff.js';
import { createSupportRouter } from './router.js';
import { SupportService } from './support-service.js';

const authConfig = {
  secret: 'a-support-ticket-properties-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const LEAD = '33333333-3333-4333-8333-333333333333';
const AGENT = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const SESSION = '66666666-6666-4666-8666-666666666666';

async function ctx(userId: string, scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-props' };
}

async function desk() {
  const properties = new MemoryPropertiesBook();
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
    [],
    properties,
  );
  const router = createSupportRouter(support, undefined, undefined, support);
  const as = async (userId: string, scopes = ['support:ops', 'support:read', 'support:write']) =>
    router.createCaller(await ctx(userId, scopes));
  const lead = await as(LEAD);
  await lead.staffAppoint({ userId: LEAD, role: 'lead', idempotencyKey: 'appoint-lead-1' });
  await lead.staffAppoint({ userId: AGENT, role: 'agent', idempotencyKey: 'appoint-agent-1' });
  const ticket = (subject: string) => support.createTicket({ userId: CUSTOMER, category: 'account', subject, body: 'Help me please' });
  return { support, properties, groups, as, lead, ticket };
}

describe('ticket properties (SP-tickets-04)', () => {
  it('a ticket nobody touched has no priority, type or labels', async () => {
    const { lead, ticket } = await desk();
    const t = await ticket('Fresh');
    expect(await lead.ticketProperties({ ticketId: t.id })).toEqual({
      ticketId: t.id,
      priority: null,
      ticketType: null,
      labels: [],
      updatedAt: null,
    });
  });

  it('sets priority, type and labels, leaves omitted fields alone, and clears with null', async () => {
    const { lead, ticket } = await desk();
    const t = await ticket('Stuck');
    const first = await lead.setProperties({
      ticketId: t.id,
      priority: 'high',
      ticketType: 'problem',
      labels: ['vip', 'chargeback'],
      clientRequestId: 'req-0001',
    });
    expect(first).toMatchObject({ priority: 'high', ticketType: 'problem', labels: ['chargeback', 'vip'] });
    const second = await lead.setProperties({ ticketId: t.id, labels: ['vip'], clientRequestId: 'req-0002' });
    expect(second).toMatchObject({ priority: 'high', ticketType: 'problem', labels: ['vip'] });
    const third = await lead.setProperties({ ticketId: t.id, priority: null, clientRequestId: 'req-0003' });
    expect(third).toMatchObject({ priority: null, ticketType: 'problem' });
  });

  it('refuses a label with a space, an unknown priority or type, and an empty change, by typed code', async () => {
    const { lead, ticket } = await desk();
    const t = await ticket('Bad');
    await expect(lead.setProperties({ ticketId: t.id, labels: ['two words'], clientRequestId: 'req-0001' })).rejects.toMatchObject({
      message: expect.stringContaining('support.label_invalid'),
    });
    await expect(lead.setProperties({ ticketId: t.id, priority: 'critical', clientRequestId: 'req-0002' })).rejects.toMatchObject({
      message: expect.stringContaining('support.property_invalid'),
    });
    await expect(lead.setProperties({ ticketId: t.id, ticketType: 'task', clientRequestId: 'req-0003' })).rejects.toMatchObject({
      message: expect.stringContaining('support.property_invalid'),
    });
    await expect(lead.setProperties({ ticketId: t.id, clientRequestId: 'req-0004' })).rejects.toMatchObject({
      message: expect.stringContaining('support.property_invalid'),
    });
    expect((await lead.ticketProperties({ ticketId: t.id })).labels).toEqual([]);
  });

  it('a repeat of one client request id returns the first answer and logs once; another body on that id conflicts', async () => {
    const { lead, properties, ticket } = await desk();
    const t = await ticket('Repeat');
    const a = await lead.setProperties({ ticketId: t.id, priority: 'urgent', reason: 'chargeback deadline', clientRequestId: 'req-0001' });
    const b = await lead.setProperties({ ticketId: t.id, priority: 'urgent', reason: 'chargeback deadline', clientRequestId: 'req-0001' });
    expect(b).toEqual(a);
    expect(properties.log).toHaveLength(1);
    expect(properties.log[0]).toMatchObject({ by: LEAD, reason: 'chargeback deadline' });
    await expect(lead.setProperties({ ticketId: t.id, priority: 'low', clientRequestId: 'req-0001' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('writes no log row when the change is a no-op', async () => {
    const { lead, properties, ticket } = await desk();
    const t = await ticket('Same');
    await lead.setProperties({ ticketId: t.id, labels: ['b', 'a', 'a'], clientRequestId: 'req-0001' });
    await lead.setProperties({ ticketId: t.id, labels: ['a', 'b'], clientRequestId: 'req-0002' });
    expect(properties.log).toHaveLength(1);
  });

  it('reads the log as one entry per field changed, oldest first, with who and why; a no-op adds none', async () => {
    const { lead, ticket } = await desk();
    const t = await ticket('Logged');
    expect(await lead.propertyChanges({ ticketId: t.id, limit: 100 })).toEqual([]);
    await lead.setProperties({
      ticketId: t.id,
      priority: 'high',
      ticketType: 'question',
      labels: ['vip', 'a-b'],
      reason: 'deadline',
      clientRequestId: 'req-0001',
    });
    await lead.setProperties({ ticketId: t.id, labels: ['a-b', 'vip'], clientRequestId: 'req-0002' });
    await lead.setProperties({ ticketId: t.id, priority: null, labels: ['vip'], clientRequestId: 'req-0003' });
    const changes = await lead.propertyChanges({ ticketId: t.id, limit: 100 });
    expect(changes.map((c) => [c.logId, c.field, c.from, c.to])).toEqual([
      ['1', 'priority', null, 'high'],
      ['1', 'type', null, 'question'],
      ['1', 'labels', [], ['a-b', 'vip']],
      ['2', 'priority', 'high', null],
      ['2', 'labels', ['a-b', 'vip'], ['vip']],
    ]);
    expect(changes[0]).toMatchObject({ ticketId: t.id, setBy: LEAD, reason: 'deadline' });
    expect(changes[3]).toMatchObject({ reason: null });
    // The limit counts saves, not fields: one save, three entries.
    expect(await lead.propertyChanges({ ticketId: t.id, limit: 1 })).toHaveLength(3);
  });

  it('the property log is staff only: the customer is refused and an agent outside the desk scope reads not found', async () => {
    const { as, lead, groups, ticket } = await desk();
    const t = await ticket('Private log');
    await lead.setProperties({ ticketId: t.id, priority: 'urgent', clientRequestId: 'req-0001' });
    const customer = await as(CUSTOMER, ['support:read', 'support:write']);
    await expect(customer.propertyChanges({ ticketId: t.id, limit: 100 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(JSON.stringify(await customer.events({ ticketId: t.id, limit: 100 }))).not.toMatch(/urgent|priority/);
    const g = await lead.groupsSave({ name: 'Payments', idempotencyKey: 'group-pay-0002' });
    await groups.addMember({ groupId: g.id, userId: LEAD, by: LEAD, at: new Date().toISOString() });
    await lead.ticketSetGroup({ ticketId: t.id, groupId: g.id });
    await expect((await as(AGENT)).propertyChanges({ ticketId: t.id, limit: 100 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a closed ticket with support.ticket_closed', async () => {
    const { lead, support, ticket } = await desk();
    const t = await ticket('Done');
    await support.close({ userId: CUSTOMER, ticketId: t.id, clientRequestId: 'close-0001' });
    await expect(lead.setProperties({ ticketId: t.id, priority: 'low', clientRequestId: 'req-0001' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('filters the queue by label, and an invalid label filter is refused', async () => {
    const { lead, ticket } = await desk();
    const a = await ticket('A');
    await ticket('B');
    await lead.setProperties({ ticketId: a.id, labels: ['vip'], clientRequestId: 'req-0001' });
    const q = await lead.listQueue({ limit: 50, label: 'vip' });
    expect(q.status === 'ok' ? q.entries.map((e) => e.ticketId) : []).toEqual([a.id]);
    const none = await lead.listQueue({ limit: 50, label: 'absent' });
    expect(none.status).toBe('empty');
    await expect(lead.listQueue({ limit: 50, label: 'two words' })).rejects.toMatchObject({
      message: expect.stringContaining('support.label_invalid'),
    });
  });

  it('the customer never reads the properties: not on the ticket, and not through the operator door', async () => {
    const { as, lead, ticket } = await desk();
    const t = await ticket('Mine');
    await lead.setProperties({ ticketId: t.id, priority: 'urgent', labels: ['internal-note'], clientRequestId: 'req-0001' });
    const customer = await as(CUSTOMER, ['support:read', 'support:write']);
    expect(JSON.stringify(await customer.get({ ticketId: t.id }))).not.toMatch(/urgent|internal-note|priority|labels/);
    await expect(customer.ticketProperties({ ticketId: t.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(customer.setProperties({ ticketId: t.id, priority: 'low', clientRequestId: 'req-0002' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('a ticket outside the desk scope answers as not found on both property doors', async () => {
    const { as, lead, groups, ticket } = await desk();
    const g = await lead.groupsSave({ name: 'Payments', idempotencyKey: 'group-pay-0001' });
    await groups.addMember({ groupId: g.id, userId: LEAD, by: LEAD, at: new Date().toISOString() });
    const t = await ticket('Hidden from the agent');
    await lead.ticketSetGroup({ ticketId: t.id, groupId: g.id });
    const agent = await as(AGENT);
    await expect(agent.ticketProperties({ ticketId: t.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(agent.setProperties({ ticketId: t.id, priority: 'low', clientRequestId: 'req-0001' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
