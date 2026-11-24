import { createPublicKey } from 'node:crypto';
import { embeddedWalletPasskeySchema } from '@intafaced/contracts/protocol-embedded-wallet';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import { describe, expect, it } from 'vitest';
import { softwarePasskey } from './software-passkey.js';

/**
 * The live check's TEST passkey must read as a real WebAuthn registration, or the provider refuses it. Checked by the
 * WebAuthn verifier this service already uses for people's passkeys, not by our own parser.
 */
describe('software passkey (live check only)', () => {
  const passkey = softwarePasskey('localhost', 'http://localhost');
  const reg = passkey.registration!;

  it('passes the wire schema the service reads', () => {
    expect(embeddedWalletPasskeySchema.parse(passkey)).toEqual(passkey);
  });

  it('verifies as a "none" registration for its challenge, origin and rpId, carrying its own public key', async () => {
    const verified = await verifyRegistrationResponse({
      response: {
        id: passkey.credentialId,
        rawId: passkey.credentialId,
        type: 'public-key',
        clientExtensionResults: {},
        response: { clientDataJSON: reg.clientDataJson, attestationObject: reg.attestationObject, transports: ['internal'] },
      },
      expectedChallenge: reg.challenge,
      expectedOrigin: 'http://localhost',
      expectedRPID: 'localhost',
      requireUserVerification: true,
    });
    expect(verified.verified).toBe(true);
    const info = verified.registrationInfo!;
    expect(info.fmt).toBe('none');
    expect(info.credential.id).toBe(passkey.credentialId);

    // The COSE key in the attestation is the SPKI key the passkey declares.
    const spki = createPublicKey({ key: Buffer.from(passkey.publicKey, 'base64url'), format: 'der', type: 'spki' });
    const cose = Buffer.from(info.credential.publicKey);
    const jwk = spki.export({ format: 'jwk' });
    expect(cose.includes(Buffer.from(jwk.x!, 'base64url'))).toBe(true);
    expect(cose.includes(Buffer.from(jwk.y!, 'base64url'))).toBe(true);
  });

  it('fails verification for another rpId, so the check is not vacuous', async () => {
    await expect(
      verifyRegistrationResponse({
        response: {
          id: passkey.credentialId,
          rawId: passkey.credentialId,
          type: 'public-key',
          clientExtensionResults: {},
          response: { clientDataJSON: reg.clientDataJson, attestationObject: reg.attestationObject },
        },
        expectedChallenge: reg.challenge,
        expectedOrigin: 'http://localhost',
        expectedRPID: 'example.com',
      }),
    ).rejects.toThrow();
  });
});
