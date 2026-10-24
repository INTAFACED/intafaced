/**
 * Unit card — moving value off the platform needs a step-up, not just a session
 *
 * 1. Promise: changing where a withdrawal goes, and sending money out, need the
 *    5-minute `trade:withdraw` step-up (a second factor), like every other way
 *    out of the book.
 * 2. Break: both bank doors asked only for `bank:write`, which every normal
 *    session carries, so an XSS-stolen access token could redirect and drain an
 *    account with no second factor.
 * 3. Done bar: with `bank:write` and no step-up, setWithdrawDestination and
 *    offramp are refused and the service is never called; a step-up scope
 *    without an mfa session is refused; with both they reach the service. Every
 *    mutation on the ramps router is either listed as value-in/refused-always or
 *    refuses a plain session, so a new money-out door cannot ship unguarded.
 * 4. Class M
 * 5. Paths: services/svc-bank/src/router.ts (ramps.setWithdrawDestination, ramps.offramp)
 * 6. RED before: both were `scopedProcedure('bank:write')` and reached the service
 */
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createBankRouter } from '../router.js';
import type { BankServices } from '../bank-service.js';

const SECRET = 'a-bank-ramps-step-up-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const OFFRAMP = '44444444-4444-4444-8444-444444444444';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['bank:read', 'bank:write'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signed(p: Principal) {
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-step-up',
  });
}

function fixture() {
  const calls: string[] = [];
  const bank = {
    ramps: {
      setWithdrawDestination: async () => {
        calls.push('setWithdrawDestination');
        return { kind: 'crypto', ref: '0xabc' };
      },
      offramp: async () => {
        calls.push('offramp');
        throw new Error('stop: the service was reached');
      },
    },
  } as unknown as BankServices;
  return { calls, router: createBankRouter(bank) };
}

const destination = { kind: 'crypto', ref: '0x1111111111111111111111111111111111111111' } as const;
const offramp = { offrampId: OFFRAMP, assetId: 'USDT', amount: '5', kind: 'crypto', clientRef: 'client-ref-1' } as const;

describe('bank ramps money-out needs a step-up', () => {
  it('refuses a normal session (bank:write only) on both doors and never reaches the service', async () => {
    const { calls, router } = fixture();
    const caller = router.createCaller(signed(principal()));
    await expect(caller.ramps.setWithdrawDestination(destination)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.ramps.offramp(offramp)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(calls).toEqual([]);
  });

  it('refuses the step-up scope on a session that has not passed a second factor', async () => {
    const { calls, router } = fixture();
    const caller = router.createCaller(signed(principal({ scopes: ['bank:read', 'bank:write', 'trade:withdraw'], mfa: false })));
    await expect(caller.ramps.setWithdrawDestination(destination)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller.ramps.offramp(offramp)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(calls).toEqual([]);
  });

  it('lets a stepped-up session through to the service', async () => {
    const { calls, router } = fixture();
    const caller = router.createCaller(signed(principal({ scopes: ['bank:read', 'bank:write', 'trade:withdraw'], mfa: true })));
    await expect(caller.ramps.setWithdrawDestination(destination)).resolves.toMatchObject({ kind: 'crypto' });
    // The stub throws once reached; the router wraps it, so the proof of arrival is the recorded call.
    await expect(caller.ramps.offramp(offramp)).rejects.toBeDefined();
    expect(calls).toEqual(['setWithdrawDestination', 'offramp']);
  });

  it('manifest: every mutation on the ramps router refuses a plain session, except the listed ones', async () => {
    const { router } = fixture();
    // `live` always answers { ramp: null } and moves nothing: there is no live ramp to reach.
    const NOT_VALUE_OUT = new Set([
      'ramps.live',
      // Customer on-ramp is bank:write (money in, partner instruction). It does not send funds out.
      'ramps.onrampCreate',
      // Renaming a saved destination changes only its label. Saving and removing one need the step-up scope,
      // so they are not listed: they must refuse a plain session like every other value-out mutation.
      'ramps.destinations.rename',
      // Proving a saved wallet (W-withdraw-17) records that its key signed a message. It cannot add or change an
      // address, and only the wallet's own key can make the signature, so a plain session cannot prove a wallet it
      // does not control; adding the address to prove still needs the step-up scope.
      'ramps.destinations.ownership.start',
      'ramps.destinations.ownership.verify',
      // Asking for a new-address approval link (W-withdraw-09) mails the customer's own address on file and approves
      // nothing; approving by that link or from another device still needs the step-up scope.
      'ramps.destinations.approval.requestMail',
    ]);
    const procedures = (router as unknown as { _def: { procedures: Record<string, { _def: { type: string } }> } })._def.procedures;
    const mutations = Object.entries(procedures)
      .filter(([path, p]) => path.startsWith('ramps.') && p._def.type === 'mutation')
      .map(([path]) => path);
    expect(mutations).toEqual(expect.arrayContaining(['ramps.setWithdrawDestination', 'ramps.offramp']));
    const caller = router.createCaller(signed(principal()));
    for (const path of mutations.filter((m) => !NOT_VALUE_OUT.has(m))) {
      const call = path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], caller) as (
        input?: unknown,
      ) => Promise<unknown>;
      await expect(call(undefined), path).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|UNAUTHORIZED/) });
    }
  });
});
