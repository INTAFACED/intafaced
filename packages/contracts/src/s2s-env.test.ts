import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { s2sFromEnv } from './s2s-env.js';
import { ServiceKeyError } from './service-keys.js';

function pair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    x: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
  };
}

const agents = pair();
const academy = pair();
const KEYRING = JSON.stringify({
  keys: [
    { kid: 'svc-agents.a', svc: 'svc-agents', use: 's2s', x: agents.x },
    { kid: 'svc-academy.a', svc: 'svc-academy', use: 's2s', x: academy.x },
  ],
});
const URL_GET = new URL('http://svc-academy.internal/internal/curriculum?lang=en');

describe('s2sFromEnv', () => {
  it('leaves the process exactly as it was when the mode is unset or off', () => {
    expect(s2sFromEnv({}, 'svc-academy')).toEqual({});
    expect(s2sFromEnv({ S2S_AUTH_MODE: 'off', S2S_KEYRING: KEYRING }, 'svc-academy')).toEqual({});
  });

  it('refuses a mode it does not know, instead of reading it as off', () => {
    for (const mode of ['keypairs', 'DUAL', ' dual', 'on', '']) {
      expect(() => s2sFromEnv({ S2S_AUTH_MODE: mode, S2S_KEYRING: KEYRING }, 'svc-academy')).toThrow(ServiceKeyError);
    }
  });

  it('refuses dual or keypair without a keyring or with a bad one', () => {
    for (const mode of ['dual', 'keypair']) {
      expect(() => s2sFromEnv({ S2S_AUTH_MODE: mode }, 'svc-academy')).toThrow(ServiceKeyError);
      expect(() => s2sFromEnv({ S2S_AUTH_MODE: mode, S2S_KEYRING: '{"keys":[{"kid":"svc-agents.a"}]}' }, 'svc-academy')).toThrow(
        ServiceKeyError,
      );
    }
  });

  it('builds a verifier for this service and passes the mode through', () => {
    const out = s2sFromEnv({ S2S_AUTH_MODE: 'keypair', S2S_KEYRING: KEYRING }, 'svc-academy');
    expect(out.s2sMode).toBe('keypair');
    expect(out.serviceVerifier).toBeDefined();
    expect(out.signer).toBeUndefined();
  });

  it('builds a signer that the keyring publishes, and a receiver accepts what it signs', () => {
    const caller = s2sFromEnv(
      { S2S_AUTH_MODE: 'dual', S2S_KEYRING: KEYRING, S2S_SIGNING_KID: 'svc-agents.a', S2S_SIGNING_KEY: agents.privateKey },
      'svc-agents',
    );
    const receiver = s2sFromEnv({ S2S_AUTH_MODE: 'keypair', S2S_KEYRING: KEYRING }, 'svc-academy');
    const headers = caller.signer!.headers({ audience: 'svc-academy', method: 'GET', url: URL_GET });
    const result = receiver.serviceVerifier!.verify({
      method: 'GET',
      url: URL_GET.pathname + URL_GET.search,
      headers,
      rawBody: { retained: true, bytes: Buffer.alloc(0) },
    });
    expect(result).toMatchObject({ status: 'accepted', service: 'svc-agents' });
  });

  it('refuses half a signing pair, a key the keyring does not publish for this service, and another service key', () => {
    const base = { S2S_AUTH_MODE: 'dual', S2S_KEYRING: KEYRING };
    expect(() => s2sFromEnv({ ...base, S2S_SIGNING_KID: 'svc-agents.a' }, 'svc-agents')).toThrow(ServiceKeyError);
    expect(() => s2sFromEnv({ ...base, S2S_SIGNING_KEY: agents.privateKey }, 'svc-agents')).toThrow(ServiceKeyError);
    expect(() => s2sFromEnv({ ...base, S2S_SIGNING_KID: 'svc-agents.a', S2S_SIGNING_KEY: academy.privateKey }, 'svc-agents')).toThrow(
      ServiceKeyError,
    );
    expect(() => s2sFromEnv({ ...base, S2S_SIGNING_KID: 'svc-agents.a', S2S_SIGNING_KEY: agents.privateKey }, 'svc-academy')).toThrow(
      ServiceKeyError,
    );
  });

  it('never puts malformed signing key text in an error', () => {
    const malformed = 'not-a-real-key-but-secret-looking-text-0123456789';
    try {
      s2sFromEnv(
        { S2S_AUTH_MODE: 'dual', S2S_KEYRING: KEYRING, S2S_SIGNING_KID: 'svc-agents.a', S2S_SIGNING_KEY: malformed },
        'svc-agents',
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceKeyError);
      expect(String((e as Error).message)).not.toContain(malformed);
    }
  });

  it('never puts private key text in an error', () => {
    try {
      s2sFromEnv(
        { S2S_AUTH_MODE: 'dual', S2S_KEYRING: KEYRING, S2S_SIGNING_KID: 'svc-agents.a', S2S_SIGNING_KEY: academy.privateKey },
        'svc-agents',
      );
      expect.unreachable();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(academy.privateKey);
    }
  });
});
