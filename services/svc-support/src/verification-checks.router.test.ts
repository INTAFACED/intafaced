import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createSupportRouter } from './router.js';
import { MemoryCheckBook, VerificationChecks, type RecordOwners } from './verification-checks.js';
import { MemorySupportStore } from './store.js';
import { SupportService } from './support-service.js';

/**
 * J-support-public-20 #2 through the router, as the desk calls it: `customerBalance` refuses by its code until two checks are
 * recorded, takes no customer id, and is the desk's alone; the default router (no owner wired, as on main) records no check.
 */

const authConfig = {
  secret: 'a-support-verification-checks-test-secret-long',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const AGENT = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const SESSION = '66666666-6666-4666-8666-666666666666';
const W1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const D1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

async function ctx(userId: string, scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-verification' };
}

async function desk(owners?: RecordOwners) {
  const support = new SupportService(new MemorySupportStore());
  const u = undefined;
  const checks = owners ? new VerificationChecks(new MemoryCheckBook(), support, owners) : u;
  const router = createSupportRouter(support, u, u, support, u, u, u, u, u, u, u, u, u, u, u, checks);
  const customer = router.createCaller(await ctx(CUSTOMER, ['support:read', 'support:write']));
  const agent = router.createCaller(await ctx(AGENT, ['support:ops', 'support:read', 'support:write']));
  const ticket = await customer.create({ category: 'deposit_withdraw', subject: 'TEST withdrawal missing', body: 'TEST it never came' });
  return { customer, agent, ticketId: ticket.id };
}

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (err: { message?: string; code?: string }) => `${err.code} ${err.message}`,
  );

describe('the balance disclosure gate through the router', () => {
  it('as on main: the balance and the destination refuse for want of checks, and recording one names its owner', async () => {
    const { agent, ticketId } = await desk();
    expect(await refusal(agent.customerBalance({ ticketId }))).toBe(
      'PRECONDITION_FAILED support.verification_checks_required 0 of 2 recorded',
    );
    expect(await refusal(agent.customerWithdrawalDestination({ ticketId }))).toBe(
      'PRECONDITION_FAILED support.verification_checks_required 0 of 2 recorded',
    );
    expect(await refusal(agent.recordVerificationCheck({ ticketId, kind: 'owned_record', recordKind: 'withdrawal', recordId: W1 }))).toBe(
      'PRECONDITION_FAILED support.verification_check_owner_unwired svc-pay',
    );
    expect(await agent.verificationChecks({ ticketId })).toEqual({ required: 2, checks: [] });
  });

  it('with two owned records recorded the gate opens, and the read still refuses', async () => {
    const { agent, ticketId } = await desk({ 'svc-pay': { owns: async ({ userId }) => userId === CUSTOMER } });
    for (const [recordKind, recordId] of [
      ['withdrawal', W1],
      ['deposit', D1],
    ] as const)
      await agent.recordVerificationCheck({ ticketId, kind: 'owned_record', recordKind, recordId });
    expect((await agent.verificationChecks({ ticketId })).checks).toHaveLength(2);
    expect(await refusal(agent.customerBalance({ ticketId }))).toBe('PRECONDITION_FAILED support.balance_read_unwired');
  });

  it('takes no customer id, and is the desk alone', async () => {
    const { agent, customer, ticketId } = await desk();
    const sneaky = { ticketId, userId: CUSTOMER } as unknown as { ticketId: string };
    expect(await refusal(agent.customerBalance(sneaky))).toMatch(/^BAD_REQUEST [\s\S]*unrecognized_keys/);
    for (const call of [
      customer.customerBalance({ ticketId }),
      customer.customerWithdrawalDestination({ ticketId }),
      customer.verificationChecks({ ticketId }),
      customer.recordVerificationCheck({ ticketId, kind: 'owned_record', recordKind: 'withdrawal', recordId: W1 }),
    ])
      expect(await refusal(call)).toMatch(/^FORBIDDEN/);
    expect(await refusal(agent.customerBalance({ ticketId: SESSION }))).toMatch(/^NOT_FOUND/);
  });
});
