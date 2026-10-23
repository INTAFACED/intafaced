import { ANTI_PHISHING_CODE_PATTERN, ANTI_PHISHING_STEP_UP_PURPOSE, ANTI_PHISHING_STEP_UP_SCOPE } from '@intafaced/contracts/identity';

/**
 * Anti-phishing code in Security (slice I-signin-sessions-25), backed by identity `profile.antiPhishing.get` and `.set`.
 * The code is 4 to 20 letters and digits; '' clears it. Each save asks for its own confirmation, bound to the exact code
 * and a fresh request id, so a refused save never reuses a spent one.
 */
export { antiPhishingCodeSchema, antiPhishingSetResultSchema } from '@intafaced/contracts/identity';

/** The code as the service will take it (trimmed), or null when it is not 4 to 20 letters and digits. */
export function cleanAntiPhishingCode(raw: string): string | null {
  const code = raw.trim();
  return ANTI_PHISHING_CODE_PATTERN.test(code) ? code : null;
}

/** The body of `stepUp.begin` for a set or clear: the code and the request id the service re-hashes. No target is named. */
export function antiPhishingStepUp(code: string, clientRequestId: string) {
  return {
    scope: ANTI_PHISHING_STEP_UP_SCOPE,
    purpose: ANTI_PHISHING_STEP_UP_PURPOSE,
    fields: { code, clientRequestId },
  };
}

const REFUSALS = new Map([
  ['identity.anti_phishing_guessable', 'refusedGuessable'],
  ['identity.anti_phishing_invalid', 'invalidCode'],
  ['identity.anti_phishing_key_unset', 'refusedKeyUnset'],
  ['identity.anti_phishing_delegated', 'refusedDelegated'],
  ['identity.anti_phishing_unreadable', 'refusedUnreadable'],
] as const);
export type AntiPhishingRefusal = 'refusedGuessable' | 'invalidCode' | 'refusedKeyUnset' | 'refusedDelegated' | 'refusedUnreadable';

/** The card's own sentence for identity's typed refusals of this code, or null to show the general one. */
export function antiPhishingRefusal(answer: { ok: boolean; reason?: string; code?: string; status?: number }): AntiPhishingRefusal | null {
  if (answer.ok || answer.reason === 'uncertain' || !answer.code) return null;
  return REFUSALS.get(answer.code as never) ?? null;
}
