import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryGroupBook } from './desk-groups.js';
import { MemoryStaffBook } from './desk-staff.js';
import { createSupportRouter } from './router.js';
import { SupportService } from './support-service.js';

const authConfig = {
  secret: 'a-support-fraud-route-test-secret-long-enough-xxx',
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
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-fraud' };
}

async function desk(fraudGroupName: string | null) {
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
    undefined,
    undefined,
    undefined,
    undefined,
    null,
    undefined,
    null,
    undefined,
    fraudGroupName,
  );
  const router = createSupportRouter(support, undefined, undefined, support);
  const staff = async (userId: string) => router.createCaller(await ctx(userId, ['support:ops', 'support:read', 'support:write']));
  const me = await router.createCaller(await ctx(CUSTOMER, ['support:read', 'support:write']));
  const lead = await staff(LEAD);
  await lead.staffAppoint({ userId: LEAD, role: 'lead', idempotencyKey: 'appoint-lead' });
  await lead.staffAppoint({ userId: AGENT, role: 'agent', idempotencyKey: 'appoint-agent' });
  return { support, groups, me, lead, staff };
}

const report = { category: 'fraud_report', subject: 'TEST fraud', body: 'TEST someone used my card' };

describe('fraud reports go to compliance (SP-tickets-01)', () => {
  it('an unknown category is refused by its own code and makes nothing', async () => {
    const { me } = await desk(null);
    await expect(me.create({ ...report, category: 'made-up' })).rejects.toMatchObject({ message: 'support.category_unknown' });
    expect(await me.listMine({ limit: 10 })).toHaveLength(0);
  });

  it('with no group named, a fraud report is refused and the category says why', async () => {
    const { me } = await desk(null);
    await expect(me.create(report)).rejects.toMatchObject({ message: 'support.fraud_report_key_required' });
    await expect(me.create({ ...report, clientRequestId: 'fraud-0' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'support.fraud_route_unset',
    });
    expect((await me.categories()).categories.find((row) => row.id === 'fraud_report')).toEqual({
      id: 'fraud_report',
      routesTo: 'compliance',
      refusal: 'support.fraud_route_unset',
    });
    expect((await me.categories()).categories.find((row) => row.id === 'account')).toMatchObject({ routesTo: 'desk', refusal: null });
    expect(await me.listMine({ limit: 10 })).toHaveLength(0);
  });

  it('a named group the desk does not have refuses, and once it exists the report is grouped into it', async () => {
    const { me, lead, staff, groups } = await desk('TEST Compliance');
    await expect(me.create({ ...report, clientRequestId: 'fraud-0' })).rejects.toMatchObject({ message: 'support.fraud_route_missing' });
    const group = await lead.groupsSave({ name: 'TEST Compliance', idempotencyKey: 'group-compliance' });
    expect((await me.categories()).categories.find((row) => row.id === 'fraud_report')?.refusal).toBeNull();
    const made = await me.create({ ...report, clientRequestId: 'fraud-1' });
    expect(await groups.groupOfTicket(made.id)).toBe(group.id);
    // A member of the group sees it; someone outside the group, a lead included, does not.
    await lead.groupsAddMember({ groupId: group.id, userId: AGENT });
    expect((await (await staff(AGENT)).listAll({ limit: 10 })).map((t) => t.id)).toContain(made.id);
    expect((await lead.listAll({ limit: 10 })).map((t) => t.id)).not.toContain(made.id);
    // A replay returns the same report and leaves a lead's later move alone.
    const other = await lead.groupsSave({ name: 'Elsewhere', idempotencyKey: 'group-elsewhere' });
    await groups.setTicketGroup({ ticketId: made.id, groupId: other.id, by: LEAD, at: new Date().toISOString() });
    expect((await me.create({ ...report, clientRequestId: 'fraud-1' })).id).toBe(made.id);
    expect(await groups.groupOfTicket(made.id)).toBe(other.id);
  });

  it('a replay after a crash before grouping groups the report', async () => {
    const { support, me, lead, groups } = await desk('TEST Compliance');
    const group = await lead.groupsSave({ name: 'TEST Compliance', idempotencyKey: 'group-compliance' });
    const set = groups.setTicketGroup.bind(groups);
    groups.setTicketGroup = async () => {
      throw new Error('crash before grouping');
    };
    await expect(me.create({ ...report, clientRequestId: 'fraud-2' })).rejects.toBeTruthy();
    groups.setTicketGroup = set;
    const made = await me.create({ ...report, clientRequestId: 'fraud-2' });
    expect(await groups.groupOfTicket(made.id)).toBe(group.id);
    expect(await support.listMyTickets({ userId: CUSTOMER, limit: 10 })).toHaveLength(1);
  });

  it('a replay finds its report after the route changed, and a group gone before grouping refuses', async () => {
    const { me, lead, groups } = await desk('TEST Compliance');
    const group = await lead.groupsSave({ name: 'TEST Compliance', idempotencyKey: 'group-compliance' });
    const made = await me.create({ ...report, clientRequestId: 'fraud-3' });
    await lead.groupsSave({ groupId: group.id, name: 'Renamed', idempotencyKey: 'group-rename' });
    expect((await me.create({ ...report, clientRequestId: 'fraud-3' })).id).toBe(made.id);
    // The route is read, then the group is gone when the write lands: refused, and the report stays lead-only.
    await lead.groupsSave({ groupId: group.id, name: 'TEST Compliance', idempotencyKey: 'group-rename-back' });
    const set = groups.setTicketGroup.bind(groups);
    groups.setTicketGroup = async () => 'unknown_group';
    await expect(me.create({ ...report, clientRequestId: 'fraud-4' })).rejects.toMatchObject({ message: 'support.fraud_route_missing' });
    groups.setTicketGroup = set;
    const retried = await me.create({ ...report, clientRequestId: 'fraud-4' });
    expect(await groups.groupOfTicket(retried.id)).toBe(group.id);
  });
});
