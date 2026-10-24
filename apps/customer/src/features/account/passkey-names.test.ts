import { describe, expect, it } from 'vitest';
import { cleanName, encodePurposes, passkeyList, purposesStepUp, renameStepUp, secondStepStepUp } from './passkey-names';

describe('passkey names', () => {
  it('trims and refuses empty, 65 characters and control characters, like the service', () => {
    expect(cleanName('  Work laptop ')).toBe('Work laptop');
    expect(cleanName('a'.repeat(64))).toHaveLength(64);
    for (const bad of ['', '   ', 'a'.repeat(65), 'tab\there', 'line\nbreak']) expect(cleanName(bad)).toBeNull();
  });

  it('binds the confirmation to the passkey, the new name and the request id', () => {
    expect(renameStepUp('cred-1', 'Laptop', 'req-1')).toEqual({
      scope: 'identity.step_up.passkey_rename',
      purpose: 'account.passkey.rename',
      target: 'cred-1',
      fields: { credentialId: 'cred-1', label: 'Laptop', clientRequestId: 'req-1' },
    });
  });

  it('reads the list with a stated or unstated limit and refuses an unknown kind', () => {
    const row = { credentialId: 'a', label: null, kind: 'platform', createdAt: '2026-10-01T00:00:00.000Z', lastUsedAt: null };
    expect(passkeyList.safeParse({ passkeys: [row], maxPerAccount: null }).success).toBe(true);
    expect(passkeyList.safeParse({ passkeys: [row], maxPerAccount: 5 }).success).toBe(true);
    expect(passkeyList.safeParse({ passkeys: [{ ...row, kind: 'magic' }], maxPerAccount: null }).success).toBe(false);
  });

  it('binds a purposes change to the passkey and the sorted set, and the second step to on or off (I-signin-sessions-10)', () => {
    expect(encodePurposes(['signin', 'money_out', 'signin'])).toBe('money_out,signin');
    expect(encodePurposes([])).toBe('');
    expect(purposesStepUp('cred-1', 'money_out,signin', 'req-1')).toEqual({
      scope: 'identity.step_up.passkey_purposes',
      purpose: 'account.passkey.purposes',
      target: 'cred-1',
      fields: { credentialId: 'cred-1', purposes: 'money_out,signin', clientRequestId: 'req-1' },
    });
    expect(secondStepStepUp(true, 'req-2')).toEqual({
      scope: 'identity.step_up.passkey_second_step',
      purpose: 'account.passkey.secondStep',
      target: 'req-2',
      fields: { on: 'on', clientRequestId: 'req-2' },
    });
    const row = { credentialId: 'a', label: null, kind: 'platform', createdAt: '2026-10-01T00:00:00.000Z', lastUsedAt: null };
    const parsed = passkeyList.parse({ passkeys: [{ ...row, purposes: ['signin'] }], maxPerAccount: null, secondStep: true });
    expect(parsed.passkeys[0]!.purposes).toEqual(['signin']);
    expect(parsed.secondStep).toBe(true);
    expect(passkeyList.safeParse({ passkeys: [{ ...row, purposes: ['admin'] }], maxPerAccount: null }).success).toBe(false);
  });
});
