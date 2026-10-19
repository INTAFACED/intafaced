import { describe, expect, it } from 'vitest';
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
    expect(edgeEd25519Config({ EDGE_PRINCIPAL_PRIVATE_KEY: 'k'.repeat(64), EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS: 60 })).toEqual({
      privateKey: 'k'.repeat(64),
      maxLifetimeSeconds: 60,
    });
  });
});
