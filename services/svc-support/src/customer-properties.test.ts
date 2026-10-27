import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context, SupportCustomerProperty } from '@intafaced/contracts';
import { supportCustomerSeesEnv } from './customer-sees-env.js';
import { MemoryStaffBook } from './desk-staff.js';
import { createSupportRouter } from './router.js';
import { SupportService } from './support-service.js';

const authConfig = {
  secret: 'a-support-customer-properties-test-secret-long-xx',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const AGENT = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SESSION = '66666666-6666-4666-8666-666666666666';

async function ctx(userId: string, scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-props' };
}

async function desk(customerSees: SupportCustomerProperty[] | null) {
  const support = new SupportService(
    undefined,
    undefined,
    undefined,
    new MemoryStaffBook(),
    undefined,
    null,
    undefined,
    undefined,
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    null,
    undefined,
    null,
    undefined,
    null,
    customerSees,
  );
  const router = createSupportRouter(support, undefined, undefined, support);
  const as = async (userId: string, scopes = ['support:read', 'support:write']) => router.createCaller(await ctx(userId, scopes));
  const agent = await as(AGENT, ['support:ops', 'support:read', 'support:write']);
  await agent.staffAppoint({ userId: AGENT, role: 'lead', idempotencyKey: 'appoint-lead' });
  const ticket = await support.createTicket({ userId: CUSTOMER, category: 'account', subject: 'TEST', body: 'TEST body' });
  await agent.setProperties({ ticketId: ticket.id, priority: 'high', ticketType: 'problem', clientRequestId: 'props-1' });
  return { as, ticket };
}

describe('what a customer reads of priority and type (SP-tickets-04)', () => {
  it('blank reads unset and shows neither', async () => {
    const { as, ticket } = await desk(null);
    expect(await (await as(CUSTOMER)).myTicketProperties({ ticketId: ticket.id })).toEqual({
      status: 'unset',
      code: 'support.customer_properties_unset',
    });
  });

  it('shows only what the owner chose, and a property the desk has not set as empty', async () => {
    const both = await desk(['priority', 'type']);
    expect(await (await both.as(CUSTOMER)).myTicketProperties({ ticketId: both.ticket.id })).toEqual({
      status: 'ok',
      priority: { value: 'high' },
      ticketType: { value: 'problem' },
    });
    const typeOnly = await desk(['type']);
    expect(await (await typeOnly.as(CUSTOMER)).myTicketProperties({ ticketId: typeOnly.ticket.id })).toEqual({
      status: 'ok',
      priority: null,
      ticketType: { value: 'problem' },
    });
    const none = await desk([]);
    expect(await (await none.as(CUSTOMER)).myTicketProperties({ ticketId: none.ticket.id })).toEqual({
      status: 'ok',
      priority: null,
      ticketType: null,
    });
  });

  it("someone else's request reads as not found", async () => {
    const { as, ticket } = await desk(['priority', 'type']);
    await expect((await as(OTHER)).myTicketProperties({ ticketId: ticket.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('the owner value parses a subset or none, and refuses anything else', () => {
    expect(supportCustomerSeesEnv.parse('')).toBeUndefined();
    expect(supportCustomerSeesEnv.parse(undefined)).toBeUndefined();
    expect(supportCustomerSeesEnv.parse('none')).toEqual([]);
    expect(supportCustomerSeesEnv.parse('priority, type')).toEqual(['priority', 'type']);
    expect(() => supportCustomerSeesEnv.parse('labels')).toThrow();
  });
});
