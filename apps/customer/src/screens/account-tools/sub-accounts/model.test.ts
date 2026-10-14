import { describe, expect, it } from 'vitest';
import { classifyCreateFailure, createSubAccount, labelError, purposeError } from './model';
import type { ApiClient } from '../../../shared/api';

describe('sub-account fields', () => {
  it('needs a name of 1 to 64 characters and a purpose of at most 200', () => {
    expect(labelError('  ')).toBe('empty');
    expect(labelError('Bots')).toBeNull();
    expect(labelError('x'.repeat(65))).toBe('long');
    expect(purposeError('x'.repeat(200))).toBeNull();
    expect(purposeError('x'.repeat(201))).toBe('long');
  });
});

describe('why a create was refused', () => {
  const fail = (message: string, reason: 'error' | 'uncertain' | 'unauthorized' = 'error', code?: string) => ({
    ok: false as const,
    reason,
    message,
    ...(code ? { code } : {}),
  });
  it('knows the owner has not opened sub-accounts yet', () => {
    expect(classifyCreateFailure(fail('IDENTITY_MAX_SUB_ACCOUNTS is unset — owner must publish a live-partition cap'))).toBe('not-open');
    expect(classifyCreateFailure(fail('x', 'error', 'auth.sub_account_cap_unset'))).toBe('not-open');
  });
  it('knows the limit, a held account, a lost answer and a signed-out session', () => {
    expect(classifyCreateFailure(fail('Sub-account limit reached (3). Retire a live partition'))).toBe('limit');
    expect(classifyCreateFailure(fail('Account is frozen'))).toBe('on-hold');
    expect(classifyCreateFailure(fail('x', 'uncertain'))).toBe('uncertain');
    expect(classifyCreateFailure(fail('x', 'unauthorized'))).toBe('signed-out');
    expect(classifyCreateFailure(fail('boom'))).toBe('other');
  });
});

describe('createSubAccount', () => {
  it('trims, and leaves the purpose out when it is blank', async () => {
    const calls: unknown[] = [];
    const api = {
      mutate: async (_m: string, procedure: string, input: unknown) => {
        calls.push({ procedure, input });
        return { ok: true as const, data: { id: '00000000-0000-4000-8000-000000000009' } };
      },
    } as unknown as ApiClient;
    await createSubAccount(api, { label: ' Bots ', purpose: '  ' });
    await createSubAccount(api, { label: 'Fund', purpose: ' Long term ' });
    expect(calls).toEqual([
      { procedure: 'subAccounts.create', input: { label: 'Bots' } },
      { procedure: 'subAccounts.create', input: { label: 'Fund', purpose: 'Long term' } },
    ]);
  });
});
