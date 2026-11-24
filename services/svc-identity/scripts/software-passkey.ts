import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import type { EmbeddedWalletPasskey } from '@intafaced/contracts/protocol-embedded-wallet';

/**
 * A TEST passkey made in software, for the one-off live check against the owner's wallet provider
 * (scripts/turnkey-live-check.ts, `.github/workflows/vendor-live-check.yml`). It is what a browser hands the page after
 * `navigator.credentials.create`: a P-256 credential, its public key, and a WebAuthn registration with the "none"
 * attestation most passkeys send. Its private key stays in this process and is dropped when it ends, so the TEST wallet
 * bound to it can never sign anything. Never used by the service itself.
 */

const b64url = (buf: Buffer | Uint8Array) => Buffer.from(buf).toString('base64url');

/** A CBOR head: major type and length (RFC 8949 §3). */
function head(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
  if (length < 0x10000) return Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
  throw new Error('CBOR item too long for a passkey');
}
const cborBytes = (b: Buffer) => Buffer.concat([head(2, b.length), b]);
const cborText = (s: string) => Buffer.concat([head(3, Buffer.byteLength(s)), Buffer.from(s)]);
/** A small integer, negative or not. */
const cborInt = (n: number) => (n >= 0 ? head(0, n) : head(1, -1 - n));

/** The credential's public key as COSE_Key (RFC 9053 §7.1.1): EC2, ES256, P-256. */
function coseKeyOf(x: Buffer, y: Buffer): Buffer {
  return Buffer.concat([
    head(5, 5),
    cborInt(1),
    cborInt(2), // kty: EC2
    cborInt(3),
    cborInt(-7), // alg: ES256
    cborInt(-1),
    cborInt(1), // crv: P-256
    cborInt(-2),
    cborBytes(x),
    cborInt(-3),
    cborBytes(y),
  ]);
}

/** The attestation object a "none" attestation carries (WebAuthn §6.5, §8.7). */
function noneAttestationObject(authData: Buffer): Buffer {
  return Buffer.concat([
    head(5, 3),
    cborText('fmt'),
    cborText('none'),
    cborText('attStmt'),
    head(5, 0),
    cborText('authData'),
    cborBytes(authData),
  ]);
}

/** Authenticator data for a registration (WebAuthn §6.1): user present and verified, with the attested credential. */
function registrationAuthData(rpId: string, credentialId: Buffer, coseKey: Buffer): Buffer {
  const rpIdHash = createHash('sha256').update(rpId).digest();
  const flags = Buffer.from([0x45]); // UP | UV | AT
  const signCount = Buffer.alloc(4);
  const aaguid = Buffer.alloc(16);
  const idLength = Buffer.from([credentialId.length >> 8, credentialId.length & 0xff]);
  return Buffer.concat([rpIdHash, flags, signCount, aaguid, idLength, credentialId, coseKey]);
}

export function softwarePasskey(rpId: string, origin: string): EmbeddedWalletPasskey {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  if (!jwk.x || !jwk.y) throw new Error('the TEST passkey has no public point');
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  const credentialId = randomBytes(16);
  const challenge = randomBytes(32);
  const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: b64url(challenge), origin, crossOrigin: false }));
  const authData = registrationAuthData(rpId, credentialId, coseKeyOf(x, y));
  return {
    credentialId: b64url(credentialId),
    publicKey: b64url(publicKey.export({ format: 'der', type: 'spki' })),
    algorithm: -7,
    registration: {
      challenge: b64url(challenge),
      clientDataJson: b64url(clientData),
      attestationObject: b64url(noneAttestationObject(authData)),
      transports: ['internal'],
    },
  };
}
