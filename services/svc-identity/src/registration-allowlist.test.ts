/**
 * Closed registration with an invited list: REGISTRATION_OPEN=false plus REGISTRATION_EMAIL_ALLOWLIST lets
 * only the listed addresses sign up; every other address gets the existing closed refusal; an open registration
 * ignores the list; unset stays unset.
 */
import { describe, expect, it, vi } from 'vitest';
import { partial } from '@intafaced/service-kit/testing';
import type { Context } from '@intafaced/contracts';
import { createIdentityRouter } from './router.js';
import type { AuthService } from './auth/auth-service.js';
import type { RankService } from './rank/rank-service.js';
import { parseRegistrationAllowlist } from './registration-allowlist.js';

const FLOW = '77777777-7777-4777-8777-777777777777';
const anon: Context = { principal: null, service: null, region: 'DE', requestId: 'req-1' };
const form = {
  channel: 'email' as const,
  handle: 'invited_one',
  password: 'a-long-test-password',
  country: 'DE',
  dateOfBirth: '1990-05-01',
  accountType: 'individual' as const,
};
const LIST = parseRegistrationAllowlist(' Invited@Example.com, second@example.com ');

/** An auth whose confirm runs the router's admit check on `draftEmail` before "making" the account, as auth-service does. */
function harness(options: { registrationOpen?: boolean; registrationAllowlist?: ReadonlySet<string> }, draftEmail = 'invited@example.com') {
  const made: string[] = [];
  const started: string[] = [];
  const auth = partial<AuthService>({
    signUpStart: vi.fn(async (input: { email: string }) => {
      started.push(input.email);
      return { accepted: true, next: 'confirm_email', flowId: FLOW, resendAfterSeconds: 60 };
    }) as never,
    signUpResend: vi.fn(async () => ({ accepted: true, next: 'confirm_email', flowId: FLOW, resendAfterSeconds: 60 })) as never,
    signUpConfirm: vi.fn(async (input: { admit?: (email: string) => void }) => {
      input.admit?.(draftEmail);
      made.push(draftEmail);
      return {
        session: {
          userId: '11111111-1111-4111-8111-111111111111',
          sessionId: '22222222-2222-4222-8222-222222222222',
          accessToken: 'a',
          refreshToken: 'r',
          expiresAt: new Date('2026-11-23T00:15:00.000Z'),
          mfaRequired: false,
        },
        accountType: 'individual',
        referrerId: null,
      };
    }) as never,
  });
  const api = createIdentityRouter(auth, {} as RankService, options).createCaller(anon);
  return { api, made, started };
}

const codeOf = (err: unknown) => (err as { code?: string }).code;
const closed = (err: unknown) => {
  expect(codeOf(err)).toBe('FORBIDDEN');
  expect((err as Error).message).toBe('Registration is not open yet');
};

describe('REGISTRATION_EMAIL_ALLOWLIST parse', () => {
  it('blank or unset is no list; a list is lowercased and trimmed; a non-address fails boot', () => {
    expect(parseRegistrationAllowlist('')).toBeUndefined();
    expect(parseRegistrationAllowlist(' , ')).toBeUndefined();
    expect([...LIST!]).toEqual(['invited@example.com', 'second@example.com']);
    expect(() => parseRegistrationAllowlist('invited@example.com,not-an-address')).toThrow(/REGISTRATION_EMAIL_ALLOWLIST/);
  });
});

describe('closed registration with an invited list', () => {
  it('an allowlisted address starts sign-up, whatever its case, and confirms into an account', async () => {
    const h = harness({ registrationOpen: false, registrationAllowlist: LIST! });
    await h.api.auth.signUpStart({ ...form, email: 'INVITED@example.com' });
    expect(h.started).toEqual(['INVITED@example.com']);
    await h.api.auth.signUpResend({ flowId: FLOW });
    const done = await h.api.auth.signUpConfirm({ flowId: FLOW, code: '123456' });
    expect(done.accountType).toBe('individual');
    expect(h.made).toEqual(['invited@example.com']);
  });

  it('a non-listed address gets the existing closed refusal at start and nothing is sent', async () => {
    const h = harness({ registrationOpen: false, registrationAllowlist: LIST! });
    closed(await h.api.auth.signUpStart({ ...form, email: 'stranger@example.com' }).catch((e: unknown) => e));
    expect(h.started).toEqual([]);
  });

  it('a non-listed draft (a code asked for while open) makes no account at confirm', async () => {
    const h = harness({ registrationOpen: false, registrationAllowlist: LIST! }, 'stranger@example.com');
    closed(await h.api.auth.signUpConfirm({ flowId: FLOW, code: '123456' }).catch((e: unknown) => e));
    expect(h.made).toEqual([]);
  });

  it('the code-less register door checks the list too', async () => {
    const h = harness({ registrationOpen: false, registrationAllowlist: LIST! });
    closed(
      await h.api.auth
        .register({ handle: 'stranger', email: 'stranger@example.com', password: 'correct horse battery staple' })
        .catch((e: unknown) => e),
    );
  });

  it('closed with no list (or an empty one) refuses every door, listed or not', async () => {
    for (const registrationAllowlist of [undefined, new Set<string>()]) {
      const h = harness({ registrationOpen: false, ...(registrationAllowlist ? { registrationAllowlist } : {}) });
      closed(await h.api.auth.signUpStart({ ...form, email: 'invited@example.com' }).catch((e: unknown) => e));
      closed(await h.api.auth.signUpResend({ flowId: FLOW }).catch((e: unknown) => e));
      closed(await h.api.auth.signUpConfirm({ flowId: FLOW, code: '123456' }).catch((e: unknown) => e));
      expect(h.started).toEqual([]);
      expect(h.made).toEqual([]);
    }
  });
});

describe('open registration ignores the list', () => {
  it('a non-listed address signs up and confirms while REGISTRATION_OPEN=true', async () => {
    const h = harness({ registrationOpen: true, registrationAllowlist: LIST! }, 'stranger@example.com');
    await h.api.auth.signUpStart({ ...form, email: 'stranger@example.com' });
    await h.api.auth.signUpConfirm({ flowId: FLOW, code: '123456' });
    expect(h.started).toEqual(['stranger@example.com']);
    expect(h.made).toEqual(['stranger@example.com']);
  });

  it('unset REGISTRATION_OPEN still refuses as unset, list or not', async () => {
    const h = harness({ registrationAllowlist: LIST! });
    const err = await h.api.auth.signUpStart({ ...form, email: 'invited@example.com' }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('PRECONDITION_FAILED');
    expect((err as Error).message).toContain('identity.registration_open_unset');
  });
});
