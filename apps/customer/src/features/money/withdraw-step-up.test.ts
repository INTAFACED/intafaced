import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../shared/api';

const assertion = vi.fn();
vi.mock('../session/webauthn', () => ({ requestPasskeyAssertion: (...args: unknown[]) => assertion(...args) }));
import { isStepUpCode, mintWithdrawToken } from './withdraw-step-up';

const apiWith = (mutate: ReturnType<typeof vi.fn>) => ({ mutate }) as unknown as ApiClient;
const minted = { ok: true, data: { accessToken: 'tok', expiresAt: '2026-10-20T16:00:00Z', scopes: ['trade:read', 'trade:withdraw'] } };

describe('the withdrawal confirmation token', () => {
  it('accepts a 6-digit code or a recovery code and nothing else', () => {
    expect(isStepUpCode('123456')).toBe(true);
    expect(isStepUpCode('1A2B3-C4D5E')).toBe(true);
    for (const bad of ['', '12345', '1234567', 'abcdef', '1A2B3C4D5E']) expect(isStepUpCode(bad)).toBe(false);
  });

  it('sends one code to auth.stepUp and keeps the session on a wrong code', async () => {
    const mutate = vi.fn().mockResolvedValue(minted);
    const result = await mintWithdrawToken(apiWith(mutate), { code: ' 123456 ' });
    expect(result).toEqual({ ok: true, data: { accessToken: 'tok', expiresAt: '2026-10-20T16:00:00Z' } });
    const [module, procedure, input, , options] = mutate.mock.calls[0]!;
    expect([module, procedure, input]).toEqual(['identity', 'auth.stepUp', { totpCode: '123456' }]);
    expect(options.keepSessionFor).toContain('auth.mfa_invalid');
  });

  it('refuses a malformed code without calling the service', async () => {
    const mutate = vi.fn();
    const result = await mintWithdrawToken(apiWith(mutate), { code: '12' });
    expect(result).toMatchObject({ ok: false, code: 'stepUp.code_malformed' });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('signs a passkey challenge and sends the assertion', async () => {
    assertion.mockResolvedValue({ ok: true, data: { id: 'x' } });
    const mutate = vi.fn().mockResolvedValue(minted);
    await mintWithdrawToken(apiWith(mutate), { passkey: true });
    expect(mutate.mock.calls[0]![2]).toEqual({ webauthn: { id: 'x' } });
  });

  it('passes a refused passkey through and sends nothing', async () => {
    assertion.mockResolvedValue({ ok: false, reason: 'error', message: 'stopped', code: 'portal.passkey_stopped' });
    const mutate = vi.fn();
    expect(await mintWithdrawToken(apiWith(mutate), { passkey: true })).toMatchObject({ ok: false, code: 'portal.passkey_stopped' });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('refuses a token that does not carry trade:withdraw', async () => {
    const mutate = vi.fn().mockResolvedValue({ ok: true, data: { ...minted.data, scopes: ['trade:read'] } });
    expect(await mintWithdrawToken(apiWith(mutate), { code: '123456' })).toMatchObject({ ok: false, code: 'stepUp.scope_missing' });
  });
});
