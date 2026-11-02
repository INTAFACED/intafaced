import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createSupportRouter } from './router.js';
import { MemoryCheckBook, VerificationChecks, type VerificationOwners } from './verification-checks.js';
import { MemorySupportStore } from './store.js';
import { SupportService } from './support-service.js';

/**
 * J-support-public-20 #2 through the router, as the desk calls it: `customerBalance` and `readDisclosure` refuse by their code
 * until a matched email and a matched record id are on the request, take no customer id, and are the desk's alone; the
 * default router (no owner wired and the attempts value blank, as on main) records no check.
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

async function ctx(userId: string, scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-verification' };
}

async function desk(owners?: VerificationOwners) {
  const support = new SupportService(new MemorySupportStore());
  const u = undefined;
  const checks = owners ? new VerificationChecks(new MemoryCheckBook(), support, 5, owners) : u;
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
  it('as on main: every read refuses for want of checks, and a check refuses on the blank attempts value', async () => {
    const { agent, ticketId } = await desk();
    expect(await refusal(agent.customerBalance({ ticketId }))).toBe(
      'PRECONDITION_FAILED support.verification_checks_required 0 of 2 matched',
    );
    for (const kind of ['balance', 'fills', 'destination'] as const)
      expect(await refusal(agent.readDisclosure({ ticketId, kind }))).toBe(
        'PRECONDITION_FAILED support.verification_checks_required 0 of 2 matched',
      );
    expect(await refusal(agent.recordVerificationCheck({ ticketId, kind: 'withdrawal_id', value: W1 }))).toBe(
      'PRECONDITION_FAILED support.verification_attempts_unset',
    );
    expect(await agent.verificationChecks({ ticketId })).toEqual({
      required: 2,
      matched: 0,
      attemptsAllowed: null,
      attemptsUsed: 0,
      checks: [],
    });
  });

  it('with no owner wired a check names the owner it waits on', async () => {
    const { agent, ticketId } = await desk({});
    expect(await refusal(agent.recordVerificationCheck({ ticketId, kind: 'email', value: 'ann@example.com' }))).toBe(
      'PRECONDITION_FAILED support.disclosure_unwired svc-identity',
    );
  });

  it('with the email and a record id matched the gate opens, and the read still refuses naming its owner', async () => {
    const yes = { matches: async ({ userId }: { userId: string }) => userId === CUSTOMER };
    const { agent, ticketId } = await desk({ 'svc-identity': yes, 'svc-pay': yes });
    await agent.recordVerificationCheck({ ticketId, kind: 'email', value: 'ann@example.com' });
    await agent.recordVerificationCheck({ ticketId, kind: 'withdrawal_id', value: W1 });
    expect((await agent.verificationChecks({ ticketId })).matched).toBe(2);
    expect(await refusal(agent.customerBalance({ ticketId }))).toBe('PRECONDITION_FAILED support.disclosure_unwired svc-ledger');
    expect(await refusal(agent.readDisclosure({ ticketId, kind: 'destination' }))).toBe(
      'PRECONDITION_FAILED support.disclosure_unwired svc-pay',
    );
  });

  it('a mismatch says only that it does not match', async () => {
    const { agent, ticketId } = await desk({ 'svc-pay': { matches: async () => false } });
    expect(await refusal(agent.recordVerificationCheck({ ticketId, kind: 'deposit_id', value: W1 }))).toBe(
      'BAD_REQUEST support.verification_mismatch',
    );
  });

  it('takes no customer id, and is the desk alone', async () => {
    const { agent, customer, ticketId } = await desk();
    const sneaky = { ticketId, userId: CUSTOMER } as unknown as { ticketId: string };
    expect(await refusal(agent.customerBalance(sneaky))).toMatch(/^BAD_REQUEST [\s\S]*unrecognized_keys/);
    for (const call of [
      customer.customerBalance({ ticketId }),
      customer.readDisclosure({ ticketId, kind: 'balance' }),
      customer.verificationChecks({ ticketId }),
      customer.recordVerificationCheck({ ticketId, kind: 'withdrawal_id', value: W1 }),
    ])
      expect(await refusal(call)).toMatch(/^FORBIDDEN/);
    expect(await refusal(agent.customerBalance({ ticketId: SESSION }))).toMatch(/^NOT_FOUND/);
  });
});
