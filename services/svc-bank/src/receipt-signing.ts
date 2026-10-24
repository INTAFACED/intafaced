import { createHash, createHmac, hkdfSync } from 'node:crypto';

/**
 * How svc-bank signs a receipt it hands a customer: the SHA-256 of the text's UTF-8 bytes, and an HMAC-SHA256 over the
 * same bytes under a key derived (HKDF-SHA256) from the service secret for one kind of receipt alone, named by `info`,
 * so no other key is reused. One value is one line: a control character or line separator in a stored name never adds
 * a line to signed text.
 */
export const oneLine = (value: string | null) => (value ?? '').replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').trim();

export function signReceipt(text: string, secret: string, info: string): { sha256: string; signature: string } {
  const bytes = Buffer.from(text, 'utf8');
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), info, 32));
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    signature: createHmac('sha256', key).update(bytes).digest('hex'),
  };
}
