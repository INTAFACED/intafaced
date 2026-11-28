/**
 * Shared by the session-door tests: the bodies identity can answer a passkey read with, and how a door's answer to one
 * is compared with another's. A door that "reuses assertSessionPasskey" answers every body exactly as it does.
 */
const USER = '11111111-1111-4111-8111-111111111111';
const VERIFIED_AT = '2026-08-25T00:00:00.000Z';

export const VERIFIED_PASSKEY_BODY = { userId: USER, webauthnCreds: [{ credentialId: 'cred-3', lastVerifiedAt: VERIFIED_AT }] };

export const PASSKEY_BODIES: readonly unknown[] = [
  VERIFIED_PASSKEY_BODY,
  { userId: USER, webauthnCreds: [{ credentialId: 'cred-3' }] },
  { userId: USER, webauthnCreds: [{ credentialId: 'cred-3', lastVerifiedAt: 'not-a-date' }] },
  { userId: USER, webauthnCreds: [{ credentialId: 'cred-1', lastVerifiedAt: VERIFIED_AT }, { credentialId: 'cred-2' }] },
  { userId: USER, webauthnCreds: [] },
  { userId: USER },
  { userId: USER, webauthnCreds: 'cred-3' },
  null,
  undefined,
  'cred-3',
];

/** What a door did with one input: returned (and what), or refused (with which error class and code). */
export function outcomeOf(run: () => unknown): { returned: unknown } | { refused: string; code: unknown } {
  try {
    return { returned: run() };
  } catch (err) {
    return { refused: err instanceof Error ? err.name : typeof err, code: (err as { code?: unknown } | null)?.code };
  }
}
