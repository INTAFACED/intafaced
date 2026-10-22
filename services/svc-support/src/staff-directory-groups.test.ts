import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryGroupBook } from './desk-groups.js';
import { MemoryStaffBook } from './desk-staff.js';
import { createSupportRouter } from './router.js';
import { SupportService } from './support-service.js';

const authConfig = {
  secret: 'a-support-staff-directory-groups-test-secret-long',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const LEAD = '33333333-3333-4333-8333-333333333333';
const AGENT_A = '44444444-4444-4444-8444-444444444444';
const AGENT_B = '55555555-5555-4555-8555-555555555555';
const SESSION = '66666666-6666-4666-8666-666666666666';

async function ctx(userId: string, scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-directory' };
}

async function desk() {
  const support = new SupportService(
    undefined,
    undefined,
    undefined,
    new MemoryStaffBook(),
    undefined,
    null,
    undefined,
    new MemoryGroupBook(),
  );
  const router = createSupportRouter(support, undefined, undefined, support);
  const as = async (userId: string, scopes = ['support:ops']) => router.createCaller(await ctx(userId, scopes));
  const lead = await as(LEAD);
  await lead.staffAppoint({ userId: LEAD, role: 'lead', idempotencyKey: 'appoint-lead-1' });
  await lead.staffAppoint({ userId: AGENT_A, role: 'agent', idempotencyKey: 'appoint-agent-a' });
  await lead.staffAppoint({ userId: AGENT_B, role: 'agent', idempotencyKey: 'appoint-agent-b' });
  return { as, lead };
}

describe('staff directory with group memberships (SP-agents-01)', () => {
  it('lists every member with an empty group list when no group exists', async () => {
    const { lead } = await desk();
    const rows = await lead.staffList();
    expect(rows.map((r) => [r.userId, r.groups])).toEqual([
      [LEAD, []],
      [AGENT_A, []],
      [AGENT_B, []],
    ]);
  });

  it('shows each member the groups they belong to, sorted by name, and follows removal', async () => {
    const { lead } = await desk();
    const trading = await lead.groupsSave({ name: 'Trading', idempotencyKey: 'group-trading-1' });
    const payments = await lead.groupsSave({ name: 'Payments', idempotencyKey: 'group-payments-1' });
    await lead.groupsAddMember({ groupId: trading.id, userId: AGENT_A });
    await lead.groupsAddMember({ groupId: payments.id, userId: AGENT_A });
    await lead.groupsAddMember({ groupId: trading.id, userId: AGENT_B });

    const byUser = new Map((await lead.staffList()).map((r) => [r.userId, r.groups]));
    expect(byUser.get(AGENT_A)).toEqual([
      { id: payments.id, name: 'Payments' },
      { id: trading.id, name: 'Trading' },
    ]);
    expect(byUser.get(AGENT_B)).toEqual([{ id: trading.id, name: 'Trading' }]);
    expect(byUser.get(LEAD)).toEqual([]);

    await lead.groupsRemoveMember({ groupId: trading.id, userId: AGENT_B });
    expect((await lead.staffList()).find((r) => r.userId === AGENT_B)?.groups).toEqual([]);
  });

  it('keeps availability on the row next to the groups', async () => {
    const { as, lead } = await desk();
    const trading = await lead.groupsSave({ name: 'Trading', idempotencyKey: 'group-trading-1' });
    await lead.groupsAddMember({ groupId: trading.id, userId: AGENT_A });
    await (await as(AGENT_A)).staffSetAvailability({ availability: 'busy' });
    expect((await lead.staffList()).find((r) => r.userId === AGENT_A)).toMatchObject({
      availability: 'busy',
      groups: [{ id: trading.id, name: 'Trading' }],
    });
  });

  it('refuses a caller without support:ops', async () => {
    const { as } = await desk();
    await expect((await as(AGENT_A, ['support:read'])).staffList()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
