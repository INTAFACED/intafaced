import {
  RECOVERY_KEY_STEP_UP_PURPOSE,
  RECOVERY_KEY_STEP_UP_SCOPE,
  recoveryKeyFingerprint,
  recoveryPlanTarget,
  type RecoveryKeyChange,
  type RecoveryPublicJwk,
} from '@intafaced/contracts/identity-recovery';

/**
 * A recovery key as the person who holds it keeps it: one line of text, `INTAFACED-RECOVERY-KEY-1.` and the key pair's
 * P-256 coordinates. It is made in this browser and never sent; identity receives only the public half and keeps only
 * its fingerprint (RC-identity-07). The claim room reads the same line back to sign a claim.
 */
export const RECOVERY_KEY_PREFIX = 'INTAFACED-RECOVERY-KEY-1.';

export type MadeRecoveryKey = { publicKey: RecoveryPublicJwk; fingerprint: string; text: string };

const toBase64url = (text: string) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A new key pair, its public half for identity and its text for the person who will hold it. */
export async function makeRecoveryKey(subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<MadeRecoveryKey> {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await subtle.exportKey('jwk', pair.privateKey);
  if (!jwk.x || !jwk.y || !jwk.d) throw new Error('recovery key export incomplete');
  const publicKey: RecoveryPublicJwk = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
  const text = RECOVERY_KEY_PREFIX + toBase64url(JSON.stringify({ d: jwk.d, x: jwk.x, y: jwk.y }));
  return { publicKey, fingerprint: await recoveryKeyFingerprint(publicKey), text };
}

/** The fingerprint as a person compares it: the first 16 hex characters in groups of four. */
export function shortFingerprint(fingerprint: string): string {
  return (
    fingerprint
      .slice(0, 16)
      .match(/.{1,4}/g)
      ?.join(' ') ?? fingerprint
  );
}

/** The body of `stepUp.begin` for one change: the target is what identity re-hashes when the change arrives. */
export function recoveryStepUp(change: RecoveryKeyChange, target: string, clientRequestId: string) {
  return {
    scope: RECOVERY_KEY_STEP_UP_SCOPE,
    purpose: RECOVERY_KEY_STEP_UP_PURPOSE,
    target,
    fields: { change, target, clientRequestId },
  };
}

export { recoveryPlanTarget };
