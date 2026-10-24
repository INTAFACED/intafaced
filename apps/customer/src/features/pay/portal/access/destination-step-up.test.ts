import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../../../shared/api';
import { confirmDestination } from './destination-step-up';

const destination = { merchantId: 'm-1', railId: 'crypto-native', kind: 'crypto', ref: '0xabc' };

function client(answers: Record<string, unknown>) {
  const mutate = vi.fn(async (_service: string, procedure: string, _input?: unknown) => answers[procedure]);
  return { api: { mutate } as unknown as ApiClient, mutate };
}

describe('confirming a payout destination', () => {
  it('asks identity for exactly this destination and returns the single-use approval', async () => {
    const { api, mutate } = client({
      'stepUp.begin': { ok: true, data: { challengeId: '00000000-0000-4000-8000-000000000001', totp: true, webauthn: null } },
      'stepUp.complete': { ok: true, data: { stepUpApprovalId: 'appr-1' } },
    });
    const result = await confirmDestination(api, destination, { code: ' 123456 ' });
    expect(result).toEqual({ ok: true, data: { stepUpApprovalId: 'appr-1' } });
    expect(mutate.mock.calls[0]?.slice(0, 3)).toEqual([
      'identity',
      'stepUp.begin',
      { scope: 'pay.step_up.payoutDestination.set', purpose: 'payoutDestination.set', target: '0xabc', fields: destination },
    ]);
    expect(mutate.mock.calls[1]?.[2]).toEqual({ challengeId: '00000000-0000-4000-8000-000000000001', totpCode: '123456' });
  });

  it('refuses a short code without asking identity', async () => {
    const { api, mutate } = client({});
    const result = await confirmDestination(api, destination, { code: '12345' });
    expect(result).toMatchObject({ ok: false, message: 'Enter the 6 digits from your authenticator app.' });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('says a wrong code in words, and never returns an approval', async () => {
    const { api } = client({
      'stepUp.begin': { ok: true, data: { challengeId: '00000000-0000-4000-8000-000000000002', totp: true, webauthn: null } },
      'stepUp.complete': { ok: false, reason: 'unauthorized', code: 'auth.mfa_invalid', message: 'Invalid two-factor code' },
    });
    const result = await confirmDestination(api, destination, { code: '000000' });
    expect(result).toMatchObject({ ok: false, message: "That code didn't match. Check your authenticator app and try again." });
  });

  it('stops when identity will not begin, and tells a person without a passkey to use a code', async () => {
    const refused = client({
      'stepUp.begin': { ok: false, reason: 'forbidden', code: '', message: 'API keys and sub-accounts cannot confirm a payment' },
    });
    expect(await confirmDestination(refused.api, destination, { code: '123456' })).toMatchObject({
      ok: false,
      message: 'API keys and sub-accounts cannot confirm a payment.',
    });
    expect(refused.mutate).toHaveBeenCalledTimes(1);
    const noPasskey = client({
      'stepUp.begin': { ok: true, data: { challengeId: '00000000-0000-4000-8000-000000000003', totp: true, webauthn: null } },
    });
    expect(await confirmDestination(noPasskey.api, destination, { passkey: true })).toMatchObject({
      ok: false,
      message: 'No passkey is saved on this account. Enter your authenticator code, or add a passkey in Security settings.',
    });
  });
});
