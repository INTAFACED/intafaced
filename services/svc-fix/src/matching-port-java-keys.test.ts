import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServiceVerifier, verifyServiceRequest, type Keyring, type ServiceAuthMode } from '@intafaced/contracts';
import { temurinJavaHome } from '../scripts/ensure-toolchain.mjs';

/**
 * Cross-language check for the live path. The Java `MatchingSubmitPort.submit` (the code the FIX session runs) signs
 * one order with a per-run Ed25519 key from S2S_* in its environment; the TypeScript contracts verifier, fed the
 * request exactly as Java put it on the wire, must accept it, and must refuse it once it is moved. Java is compiled
 * here with javac (no Maven, no QuickFIX/J: the signing path imports neither).
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const javaSrc = join(root, 'src', 'main', 'java', 'io', 'intafaced', 'fix');
const cliSrc = join(root, 'src', 'test', 'java', 'io', 'intafaced', 'fix', 'S2sSignCli.java');
const SECRET = randomBytes(24).toString('hex');
const OWNER_MAP = '{"CLIENT":"acct-desk"}';

function findJavaHome(): string | null {
  const unpacked = temurinJavaHome(join(root, '.tools', 'jdk'));
  if (unpacked) return unpacked;
  return process.env.JAVA_HOME && existsSync(join(process.env.JAVA_HOME, 'bin', 'javac')) ? process.env.JAVA_HOME : null;
}

function bin(name: string): string {
  const home = findJavaHome();
  return home ? join(home, 'bin', name) : name;
}

type Wire = { url: string; body: string; headers: Record<string, string> };

let classes = '';

beforeAll(() => {
  classes = mkdtempSync(join(tmpdir(), 'svc-fix-java-'));
  const files = [
    'ServiceAuth',
    'ServiceKeys',
    'MatchingSubmitPort',
    'MatchingSubmitResult',
    'MatchingAck',
    'MatchingOrderCommand',
    'Json',
  ].map((name) => join(javaSrc, `${name}.java`));
  execFileSync(bin('javac'), ['-d', classes, ...files, cliSrc], { stdio: ['ignore', 'pipe', 'pipe'] });
}, 120_000);

afterAll(() => {
  if (classes) rmSync(classes, { recursive: true, force: true });
});

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const keyring: Keyring = [{ kid: 'svc-fix.a', svc: 'svc-fix', use: 's2s', x }];
  return {
    keyring,
    env: {
      S2S_KEYRING: JSON.stringify({ keys: keyring }),
      S2S_SIGNING_KID: 'svc-fix.a',
      S2S_SIGNING_KEY: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    },
  };
}

function javaSigns(env: Record<string, string>, secret: string | undefined = SECRET): Wire {
  const out = execFileSync(bin('java'), ['-cp', classes, 'io.intafaced.fix.S2sSignCli'], {
    env: {
      PATH: process.env.PATH ?? '',
      MATCHING_BASE_URL: 'http://matching.test',
      FIX_COMPID_ACCOUNT_JSON: OWNER_MAP,
      ...(secret === undefined ? {} : { INTERNAL_SERVICE_SECRET: secret }),
      ...env,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out) as Wire;
}

/** What the transport sends: the signed headers plus the content-type it sets on every POST. */
function judged(
  w: Wire,
  keyring: Keyring,
  mode: ServiceAuthMode | undefined,
  edit: { method?: string; path?: string; contentType?: string } = {},
) {
  const url = new URL(w.url);
  const verifier = createServiceVerifier({ self: 'svc-matching', keyring, bootSecond: 0 });
  return verifyServiceRequest(
    {
      method: edit.method ?? 'POST',
      url: edit.path ?? url.pathname + url.search,
      headers: { ...w.headers, 'content-type': edit.contentType ?? 'application/json' },
      body: w.body,
    },
    { verifier, legacySecret: SECRET, mode },
  );
}

describe('Java live path signs what the TypeScript contracts verifier accepts', () => {
  it('dual: key signature plus v2 HMAC, accepted as the keypair caller svc-fix', { timeout: 60_000 }, () => {
    const k = keys();
    const w = javaSigns({ S2S_AUTH_MODE: 'dual', ...k.env });
    expect(w.url).toBe('http://matching.test/markets/BTC%2FUSDT/orders');
    expect(w.headers['x-intafaced-service']).toBe('svc-fix');
    expect(w.headers['x-intafaced-s2s-aud']).toBe('svc-matching');
    expect(judged(w, k.keyring, undefined)).toEqual({ service: 'svc-fix', scheme: 'keypair', rejected: null });
  });

  it('keypair: only the key signature, no shared secret needed, accepted by a keypair-only callee', { timeout: 60_000 }, () => {
    const k = keys();
    const w = javaSigns({ S2S_AUTH_MODE: 'keypair', ...k.env }, undefined);
    expect(w.headers['x-intafaced-service']).toBeUndefined();
    expect(w.headers['x-intafaced-service-sig']).toBeUndefined();
    expect(judged(w, k.keyring, 'keypair')).toMatchObject({ service: 'svc-fix', scheme: 'keypair', rejected: null });
  });

  it('off: the v2 shared-secret headers alone, as before', { timeout: 60_000 }, () => {
    const w = javaSigns({});
    expect(Object.keys(w.headers).some((h) => h.startsWith('x-intafaced-s2s-'))).toBe(false);
    expect(judged(w, keys().keyring, undefined)).toMatchObject({ service: 'svc-fix', scheme: 'shared' });
  });

  it('a Java-signed call moved to another path, method or content type is refused', { timeout: 60_000 }, () => {
    const k = keys();
    const w = javaSigns({ S2S_AUTH_MODE: 'keypair', ...k.env }, undefined);
    expect(judged(w, k.keyring, 'keypair', { path: '/markets/ETH%2FUSDT/orders' })).toMatchObject({ service: null });
    expect(judged(w, k.keyring, 'keypair', { method: 'PUT' })).toMatchObject({ service: null });
    expect(judged(w, k.keyring, 'keypair', { contentType: 'text/plain' })).toMatchObject({ service: null });
  });

  it('a Java process with a half-set or mismatched key does not start', { timeout: 60_000 }, () => {
    const k = keys();
    const other = keys();
    expect(() => javaSigns({ S2S_AUTH_MODE: 'dual', S2S_KEYRING: k.env.S2S_KEYRING, S2S_SIGNING_KID: 'svc-fix.a' })).toThrow();
    expect(() => javaSigns({ S2S_AUTH_MODE: 'dual', ...k.env, S2S_SIGNING_KEY: other.env.S2S_SIGNING_KEY })).toThrow();
  });
});
