import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createSupportRouter } from './router.js';
import { MemoryReadGrantBook, ReadGrants, type ReadOwners } from './read-grants.js';
import { MemoryCheckBook, VerificationChecks, type VerificationOwners } from './verification-checks.js';
import { MemorySupportStore } from './store.js';
import { SupportService } from './support-service.js';

/**
 * J-support-public-20 #2 through the router, as the desk and the customer call it: `customerBalance` and `readDisclosure`
 * refuse by their code until the customer's own grant is live, whatever checks are matched; under the grant they answer
 * from the read's owner for the request's own customer, and each answered read is listed to the customer. The reads take
 * no customer id and are the desk's alone; the grant and the list are the customer's alone.
 */

const authConfig = {
  secret: 'a-support-verification-checks-test-secret-long',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const AGENT = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
const SESSION = '66666666-6666-4666-8666-666666666666';
const W1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BALANCES = { USDT: { free: '20', used: '0', total: '20' } };
const DESTINATION = { withdrawalId: W1, destination: { kind: 'crypto', ref: '0xabc' } };

async function ctx(userId: string, scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-verification' };
}

async function desk(input: { owners?: VerificationOwners; readOwners?: ReadOwners; linked?: string[] } = {}) {
  const support = new SupportService(new MemorySupportStore());
  const u = undefined;
  const checkBook = new MemoryCheckBook();
  const checks = input.owners ? new VerificationChecks(checkBook, support, 5, input.owners) : u;
  const clock = { at: new Date('2026-11-23T03:00:00.000Z') };
  const asked: unknown[] = [];
  const owners: ReadOwners = input.readOwners ?? {
    balance: async (userId) => {
      asked.push({ balance: userId });
      return BALANCES;
    },
    destinations: async (ask) => {
      asked.push({ destinations: ask });
      return [DESTINATION];
    },
  };
  const grantBook = new MemoryReadGrantBook();
  const reads = new ReadGrants({
    book: grantBook,
    support,
    linkedWithdrawals: async () => input.linked ?? [W1],
    owners,
    audit: (row) => checkBook.audit(row),
    now: () => clock.at,
  });
  const router = createSupportRouter(support, u, u, support, u, u, u, u, u, u, u, u, u, u, u, checks, u, u, u, u, u, u, reads);
  const customer = router.createCaller(await ctx(CUSTOMER, ['support:read', 'support:write']));
  const stranger = router.createCaller(await ctx(STRANGER, ['support:read', 'support:write']));
  const agent = router.createCaller(await ctx(AGENT, ['support:ops', 'support:read', 'support:write']));
  const ticket = await customer.create({ category: 'deposit_withdraw', subject: 'TEST withdrawal missing', body: 'TEST it never came' });
  return { customer, stranger, agent, ticketId: ticket.id, clock, asked, grantBook, checkBook, support };
}

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (err: { message?: string; code?: string }) => `${err.code} ${err.message}`,
  );

const NO_GRANT = 'PRECONDITION_FAILED support.read_grant_required none';

describe("the desk's reads behind the customer's grant, through the router", () => {
  it('with no grant every read refuses, no owner is asked, and a check refuses on the blank attempts value', async () => {
    const { agent, customer, ticketId, asked, checkBook } = await desk();
    expect(await refusal(agent.customerBalance({ ticketId }))).toBe(NO_GRANT);
    for (const kind of ['balance', 'fills', 'destination'] as const)
      expect(await refusal(agent.readDisclosure({ ticketId, kind }))).toBe(NO_GRANT);
    expect(asked).toEqual([]);
    // Nothing was read, so nothing is listed to the customer; each refused ask is on the desk's own audit.
    expect(await customer.readAccess({ ticketId })).toEqual({ ticketId, grant: null, reads: [] });
    expect(checkBook.trail.map((row) => [row.action, row.outcome, row.operator])).toEqual(
      Array.from({ length: 4 }, () => ['disclosure', 'support.read_grant_required', AGENT]),
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
    const { agent, ticketId } = await desk({ owners: {} });
    expect(await refusal(agent.recordVerificationCheck({ ticketId, kind: 'email', value: 'ann@example.com' }))).toBe(
      'PRECONDITION_FAILED support.disclosure_unwired svc-identity',
    );
  });

  it("the email and a record id matched open no read: only the customer's grant does", async () => {
    const yes = { matches: async ({ userId }: { userId: string }) => userId === CUSTOMER };
    const { agent, ticketId, asked } = await desk({ owners: { 'svc-identity': yes, 'svc-pay': yes } });
    await agent.recordVerificationCheck({ ticketId, kind: 'email', value: 'ann@example.com' });
    await agent.recordVerificationCheck({ ticketId, kind: 'withdrawal_id', value: W1 });
    expect((await agent.verificationChecks({ ticketId })).matched).toBe(2);
    expect(await refusal(agent.customerBalance({ ticketId }))).toBe(NO_GRANT);
    expect(await refusal(agent.readDisclosure({ ticketId, kind: 'destination' }))).toBe(NO_GRANT);
    expect(asked).toEqual([]);
  });

  it('a mismatch says only that it does not match', async () => {
    const { agent, ticketId } = await desk({ owners: { 'svc-pay': { matches: async () => false } } });
    expect(await refusal(agent.recordVerificationCheck({ ticketId, kind: 'deposit_id', value: W1 }))).toBe(
      'BAD_REQUEST support.verification_mismatch',
    );
  });

  it("under the customer's grant the desk is answered from the owner, for the request's customer, and each read is listed to the customer", async () => {
    const { agent, customer, ticketId, clock, asked } = await desk();
    const grant = await customer.grantRead({ ticketId, seconds: 60 });
    expect(grant).toEqual({ ticketId, grantedAt: '2026-11-23T03:00:00.000Z', expiresAt: '2026-11-23T03:01:00.000Z', active: true });

    clock.at = new Date('2026-11-23T03:00:10.000Z');
    expect(await agent.customerBalance({ ticketId })).toEqual({
      kind: 'balance',
      readAt: '2026-11-23T03:00:10.000Z',
      grantExpiresAt: grant.expiresAt,
      balances: BALANCES,
    });
    clock.at = new Date('2026-11-23T03:00:20.000Z');
    expect(await agent.readDisclosure({ ticketId, kind: 'destination' })).toEqual({
      kind: 'destination',
      readAt: '2026-11-23T03:00:20.000Z',
      grantExpiresAt: grant.expiresAt,
      withdrawals: [DESTINATION],
    });
    // The owner is asked for the request's own customer and its linked withdrawals, never for anyone the agent names.
    expect(asked).toEqual([{ balance: CUSTOMER }, { destinations: { userId: CUSTOMER, withdrawalIds: [W1] } }]);
    // Fills have no owner door: refused naming the owner, and not listed.
    expect(await refusal(agent.readDisclosure({ ticketId, kind: 'fills' }))).toBe(
      'PRECONDITION_FAILED support.disclosure_unwired svc-trade',
    );

    expect(await customer.readAccess({ ticketId })).toEqual({
      ticketId,
      grant: { ...grant, active: true },
      reads: [
        { kind: 'destination', readBy: AGENT, readAt: '2026-11-23T03:00:20.000Z' },
        { kind: 'balance', readBy: AGENT, readAt: '2026-11-23T03:00:10.000Z' },
      ],
    });
  });

  it('the grant ends at its time: the read refuses again, nothing more is listed, and a new grant opens it again', async () => {
    const { agent, customer, ticketId, clock, asked } = await desk();
    const grant = await customer.grantRead({ ticketId, seconds: 30 });
    clock.at = new Date(Date.parse(grant.expiresAt) - 1);
    await agent.customerBalance({ ticketId });
    clock.at = new Date(grant.expiresAt);
    expect(await refusal(agent.customerBalance({ ticketId }))).toBe('PRECONDITION_FAILED support.read_grant_required expired');
    expect(await refusal(agent.readDisclosure({ ticketId, kind: 'destination' }))).toBe(
      'PRECONDITION_FAILED support.read_grant_required expired',
    );
    expect(asked).toHaveLength(1);
    const ended = await customer.readAccess({ ticketId });
    expect(ended.grant).toEqual({ ...grant, active: false });
    expect(ended.reads).toHaveLength(1);

    const again = await customer.grantRead({ ticketId, seconds: 30 });
    expect(again.active).toBe(true);
    expect((await agent.customerBalance({ ticketId })).grantExpiresAt).toBe(again.expiresAt);
    expect((await customer.readAccess({ ticketId })).reads).toHaveLength(2);
  });

  it('a new grant replaces the one before it, so the customer can cut a long grant short', async () => {
    const { agent, customer, ticketId, clock } = await desk();
    await customer.grantRead({ ticketId, seconds: 604_800 });
    const short = await customer.grantRead({ ticketId, seconds: 30 });
    clock.at = new Date(Date.parse(short.expiresAt) + 1_000);
    expect(await refusal(agent.customerBalance({ ticketId }))).toBe('PRECONDITION_FAILED support.read_grant_required expired');
  });

  it('an owner that gives no answer, or is not wired, refuses naming it; no linked withdrawal has no destination to read; none is listed', async () => {
    const silent = await desk({ readOwners: { balance: async () => null, destinations: async () => null } });
    await silent.customer.grantRead({ ticketId: silent.ticketId, seconds: 60 });
    expect(await refusal(silent.agent.customerBalance({ ticketId: silent.ticketId }))).toBe(
      'PRECONDITION_FAILED support.disclosure_unwired svc-trade',
    );
    expect(await refusal(silent.agent.readDisclosure({ ticketId: silent.ticketId, kind: 'destination' }))).toBe(
      'PRECONDITION_FAILED support.disclosure_unwired svc-pay',
    );
    const unwired = await desk({ readOwners: {} });
    await unwired.customer.grantRead({ ticketId: unwired.ticketId, seconds: 60 });
    expect(await refusal(unwired.agent.customerBalance({ ticketId: unwired.ticketId }))).toBe(
      'PRECONDITION_FAILED support.disclosure_unwired svc-trade',
    );
    // An owner that answers for a withdrawal the request does not link is no answer.
    const stray = await desk({ readOwners: { destinations: async () => [{ ...DESTINATION, withdrawalId: SESSION }] } });
    await stray.customer.grantRead({ ticketId: stray.ticketId, seconds: 60 });
    expect(await refusal(stray.agent.readDisclosure({ ticketId: stray.ticketId, kind: 'destination' }))).toBe(
      'PRECONDITION_FAILED support.disclosure_unwired svc-pay',
    );
    const none = await desk({ linked: [] });
    await none.customer.grantRead({ ticketId: none.ticketId, seconds: 60 });
    expect(await refusal(none.agent.readDisclosure({ ticketId: none.ticketId, kind: 'destination' }))).toBe(
      'PRECONDITION_FAILED support.read_withdrawal_unlinked',
    );
    expect(none.asked).toEqual([]);
    for (const d of [silent, unwired, stray, none]) expect((await d.customer.readAccess({ ticketId: d.ticketId })).reads).toEqual([]);
  });

  it("the grant and the list are the customer's alone, on their own request, for a length within the bounds", async () => {
    const { agent, customer, stranger, ticketId, grantBook } = await desk();
    // The desk cannot grant itself a read, and neither can another customer.
    expect(await refusal(agent.grantRead({ ticketId, seconds: 60 }))).toMatch(/^NOT_FOUND/);
    expect(await refusal(stranger.grantRead({ ticketId, seconds: 60 }))).toMatch(/^NOT_FOUND/);
    expect(await refusal(stranger.readAccess({ ticketId }))).toMatch(/^NOT_FOUND/);
    for (const seconds of [0, 29, 604_801, 60.5]) expect(await refusal(customer.grantRead({ ticketId, seconds }))).toMatch(/^BAD_REQUEST/);
    const sneaky = { ticketId, seconds: 60, userId: STRANGER } as { ticketId: string; seconds: number };
    expect(await refusal(customer.grantRead(sneaky))).toMatch(/^BAD_REQUEST [\s\S]*unrecognized_keys/);
    expect(grantBook.grants).toEqual([]);
    expect(await refusal(agent.customerBalance({ ticketId }))).toBe(NO_GRANT);
  });

  it('the reads take no customer id, and are the desk alone', async () => {
    const { agent, customer, ticketId } = await desk();
    await customer.grantRead({ ticketId, seconds: 60 });
    const sneaky = { ticketId, userId: CUSTOMER } as { ticketId: string };
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
