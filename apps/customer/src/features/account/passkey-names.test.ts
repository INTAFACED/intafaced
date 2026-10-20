import { describe, expect, it } from 'vitest';
import { cleanName, passkeyList, renameStepUp } from './passkey-names';

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
});
