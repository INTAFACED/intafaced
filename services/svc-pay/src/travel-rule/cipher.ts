import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { TravelRuleError } from './errors.js';

/**
 * At-rest encryption for travel-rule messages (AES-256-GCM). The key is the owner's; there is no default. With no key
 * the message path refuses `travel_rule.cipher_unwired` and nothing is stored in clear. The transfer id is bound as
 * additional data, so a ciphertext moved to another transfer does not decrypt.
 */
export const TRAVEL_RULE_KEY_ENV = 'PAY_TRAVEL_RULE_MESSAGE_KEY';
export const TRAVEL_RULE_KEY_ID_ENV = 'PAY_TRAVEL_RULE_MESSAGE_KEY_ID';

export interface Sealed {
  readonly keyId: string;
  readonly iv: Buffer;
  readonly authTag: Buffer;
  readonly ciphertext: Buffer;
}

export interface MessageCipher {
  readonly keyId: string;
  seal(plaintext: Buffer, aad: string): Sealed;
  open(sealed: Sealed, aad: string): Buffer;
}

export function createMessageCipher(keyId: string, key: Buffer): MessageCipher {
  if (key.length !== 32) throw new Error('the travel-rule message key must be exactly 32 bytes');
  if (keyId.trim() === '') throw new Error('the travel-rule message key needs a key id');
  return {
    keyId,
    seal(plaintext, aad) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      c.setAAD(Buffer.from(aad, 'utf8'));
      const ciphertext = Buffer.concat([c.update(plaintext), c.final()]);
      return { keyId, iv, authTag: c.getAuthTag(), ciphertext };
    },
    open(sealed, aad) {
      if (sealed.keyId !== keyId) throw new TravelRuleError('travel_rule.key_unknown', `no key "${sealed.keyId}" is loaded`);
      const d = createDecipheriv('aes-256-gcm', key, sealed.iv);
      d.setAAD(Buffer.from(aad, 'utf8'));
      d.setAuthTag(sealed.authTag);
      return Buffer.concat([d.update(sealed.ciphertext), d.final()]);
    },
  };
}

/**
 * Both variables unset: no cipher. A key without an id, an id without a key, or a key that is not base64 for exactly
 * 32 bytes FAILS BOOT: a typo must not quietly turn encryption off.
 */
export function loadMessageCipher(env: Record<string, string | undefined>): MessageCipher | null {
  const rawKey = env[TRAVEL_RULE_KEY_ENV]?.trim() ?? '';
  const keyId = env[TRAVEL_RULE_KEY_ID_ENV]?.trim() ?? '';
  if (rawKey === '' && keyId === '') return null;
  if (rawKey === '' || keyId === '') {
    throw new Error(`${TRAVEL_RULE_KEY_ENV} and ${TRAVEL_RULE_KEY_ID_ENV} must be set together; refusing to boot`);
  }
  const key = Buffer.from(rawKey, 'base64');
  if (key.length !== 32 || key.toString('base64') !== rawKey) {
    throw new Error(`${TRAVEL_RULE_KEY_ENV} must be base64 for exactly 32 bytes; refusing to boot`);
  }
  return createMessageCipher(keyId, key);
}
