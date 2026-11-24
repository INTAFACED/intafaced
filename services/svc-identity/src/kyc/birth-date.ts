import { decryptDocument, encryptDocument } from './document-crypto.js';

/**
 * The date of birth a person gave at sign-up, sealed under the KYC document key (`signup_drafts`, then `birth_dates`), so
 * the trading checks can screen it (J-cex-spot-01 #3). Never stored or logged in plaintext.
 */
export function sealBirthDate(key: Buffer, dateOfBirth: string): { ciphertext: Buffer; nonce: Buffer } {
  return encryptDocument(key, Buffer.from(JSON.stringify({ dateOfBirth }), 'utf8'));
}

export function openBirthDate(key: Buffer, sealed: { ciphertext: Buffer; nonce: Buffer }): string {
  const value = JSON.parse(decryptDocument(key, sealed.ciphertext, sealed.nonce).toString('utf8')) as { dateOfBirth?: unknown };
  if (typeof value.dateOfBirth !== 'string') throw new Error('sealed date of birth is unreadable');
  return value.dateOfBirth;
}
