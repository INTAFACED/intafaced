import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { generateEdgePrincipalKeyPair } from '@intafaced/contracts';
import { edgeEd25519Config } from './edge-ed25519-config.js';

describe('edgeEd25519Config', () => {
  it('is off while neither setting is present', () => {
    expect(edgeEd25519Config({})).toBeUndefined();
  });

  it('refuses a key without a lifetime and a lifetime without a key', () => {
    expect(() => edgeEd25519Config({ EDGE_PRINCIPAL_PRIVATE_KEY: 'k'.repeat(64) })).toThrow(/set together/);
    expect(() => edgeEd25519Config({ EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS: 60 })).toThrow(/set together/);
  });

  it('returns both when both are set', () => {
    const { privateKey } = generateEdgePrincipalKeyPair();
    expect(edgeEd25519Config({ EDGE_PRINCIPAL_PRIVATE_KEY: privateKey, EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS: 60 })).toEqual({
      privateKey,
      maxLifetimeSeconds: 60,
    });
  });

  it('refuses boot on a key that is not a PKCS8 Ed25519 private key', () => {
    expect(() => edgeEd25519Config({ EDGE_PRINCIPAL_PRIVATE_KEY: 'k'.repeat(64), EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS: 60 })).toThrow(
      /EDGE_PRINCIPAL_PRIVATE_KEY/,
    );
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ format: 'der', type: 'pkcs8' })
      .toString('base64url');
    expect(() => edgeEd25519Config({ EDGE_PRINCIPAL_PRIVATE_KEY: rsa, EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS: 60 })).toThrow(/Ed25519/);
  });
});
