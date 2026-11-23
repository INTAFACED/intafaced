import { PASSKEY_PURPOSES } from '@intafaced/contracts/identity-list-passkeys-procedures';
export type PasskeyPurpose = (typeof PASSKEY_PURPOSES)[number];

/** The stored purposes of one credential, in the fixed order; anything unknown is ignored. */
export function purposesOf(credential: { purposes?: unknown }): PasskeyPurpose[] {
  const raw = Array.isArray(credential.purposes) ? credential.purposes : [];
  return PASSKEY_PURPOSES.filter((purpose) => raw.includes(purpose));
}

/** Parse the step-up field: the sorted, comma-joined set, or '' for none. Refuses anything else. */
export function parsePurposes(field: string): PasskeyPurpose[] | null {
  if (field === '') return [];
  const parts = field.split(',');
  const known = parts.filter((part): part is PasskeyPurpose => (PASSKEY_PURPOSES as readonly string[]).includes(part));
  if (known.length !== parts.length || new Set(known).size !== known.length) return null;
  return encodePurposes(known) === field ? PASSKEY_PURPOSES.filter((purpose) => known.includes(purpose)) : null;
}

/** The canonical field the client hashes into its step-up: sorted by name, comma-joined. */
export function encodePurposes(purposes: readonly PasskeyPurpose[]): string {
  return [...new Set(purposes)].sort().join(',');
}

/**
 * The credentials that answer for this purpose: those kept for it; when none is, those kept for nothing in particular;
 * and when every passkey is kept for something else, all of them, so keeping passkeys never locks the owner out.
 */
export function credentialsFor<T extends { purposes?: unknown }>(credentials: readonly T[], purpose: PasskeyPurpose): T[] {
  const bound = credentials.filter((credential) => purposesOf(credential).includes(purpose));
  if (bound.length > 0) return bound;
  const free = credentials.filter((credential) => purposesOf(credential).length === 0);
  return free.length > 0 ? free : [...credentials];
}

/** The purpose a customer step-up confirms: a change to the account's own security, or money (and money-like) doors. */
export function stepUpPurposeOf(scope: string): PasskeyPurpose {
  return scope.startsWith('identity.step_up.') ? 'security_change' : 'money_out';
}
