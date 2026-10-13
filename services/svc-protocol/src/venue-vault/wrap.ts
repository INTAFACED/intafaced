/**
 * AES-256-GCM wrap for venue API material. The wrap key is a KEK, not a chain
 * signing key — svc-protocol still originates no user transaction (§16.10).
 *
 * The GCM tag binds `aad` (the registering user, record id and venue). A blob
 * swapped onto another record fails authentication before secrets are opened.
 *
 * Production KEK belongs in an HSM (Class X / Nitro). An empty KEK fail-closes.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class VenueVaultKekUnconfiguredError extends Error {
  readonly code = 'venue_vault.kek_unconfigured' as const;
  constructor() {
    super('venue vault KEK unconfigured — HSM wrap is Nitro/Class X residual');
    this.name = 'VenueVaultKekUnconfiguredError';
  }
}

export class VenueVaultUnwrapFailedError extends Error {
  readonly code = 'venue_vault.unwrap_failed' as const;
  constructor() {
    super('venue vault ciphertext failed authentication');
    this.name = 'VenueVaultUnwrapFailedError';
  }
}

const IV_LEN = 12;
const TAG_LEN = 16;
const KEK_LEN = 32;

export type WrappedSecret = {
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
};

export function parseKek(hex: string | undefined | null): Buffer {
  const raw = (hex ?? '').trim();
  if (!raw) throw new VenueVaultKekUnconfiguredError();
  const buf = Buffer.from(raw, 'hex');
  if (buf.length !== KEK_LEN) throw new VenueVaultKekUnconfiguredError();
  return buf;
}

export function wrapSecret(kek: Buffer, plaintext: Buffer, aad: Buffer): WrappedSecret {
  if (kek.length !== KEK_LEN) throw new VenueVaultKekUnconfiguredError();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', kek, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ciphertext };
}

export function unwrapSecret(kek: Buffer, wrapped: WrappedSecret, aad: Buffer): Buffer {
  if (kek.length !== KEK_LEN) throw new VenueVaultKekUnconfiguredError();
  let body: Buffer | undefined;
  try {
    if (wrapped.tag.length !== TAG_LEN || wrapped.iv.length !== IV_LEN) throw new VenueVaultUnwrapFailedError();
    const decipher = createDecipheriv('aes-256-gcm', kek, wrapped.iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(wrapped.tag);
    body = decipher.update(wrapped.ciphertext);
    const tail = decipher.final();
    const opened = Buffer.concat([body, tail]);
    body.fill(0);
    tail.fill(0);
    return opened;
  } catch {
    body?.fill(0);
    throw new VenueVaultUnwrapFailedError();
  }
}
