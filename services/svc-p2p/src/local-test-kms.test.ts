import { randomBytes } from 'node:crypto';
import { lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LocalTestKmsRefusedError,
  LocalTestSealError,
  createLocalTestInstrumentKeyProvider,
  instrumentDetailsAad,
} from './instrument-key-provider.js';
import { createLocalTestKeyProvider } from './local-test-kms.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const ACCOUNT = 'account-991122-do-not-leak';

function stack(): { state: string; kms: string } {
  const state = mkdtempSync(join(tmpdir(), 'local-kms-'));
  writeFileSync(join(state, 'LOCAL-TEST-STACK.json'), JSON.stringify({ kind: 'intafaced-local-test-stack' }));
  return { state, kms: join(state, 'p2p-kms') };
}

function goodEnv(kms: string, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    LOCAL_TEST_KMS: '1',
    APP_ENV: 'dev',
    NODE_ENV: 'development',
    LOCAL_TEST_KMS_DIR: kms,
    DATABASE_URL: 'postgres://local:local@127.0.0.1:55432/intafaced_test',
    ...extra,
  };
}

describe('local-test instrument key', () => {
  it('round-trips, and a wrong AAD, a flipped byte, or another key throws with no plaintext', () => {
    const provider = createLocalTestInstrumentKeyProvider(randomBytes(32), 'TEST-a1b2c3d4');
    const aad = instrumentDetailsAad('instrument-1', 'owner-1');
    const sealed = provider.seal(ACCOUNT, aad);
    expect(sealed.startsWith('local-test:')).toBe(true);
    expect(sealed.startsWith('local-test:v1:')).toBe(true);
    expect(provider.open(sealed, aad)).toBe(ACCOUNT);
    expect(provider.seal(ACCOUNT, aad)).not.toBe(sealed);

    const wrongAad = () => provider.open(sealed, instrumentDetailsAad('instrument-1', 'owner-2'));
    const flipped = `${sealed.slice(0, -1)}${sealed.endsWith('a') ? 'b' : 'a'}`;
    const flippedByte = () => provider.open(flipped, aad);
    const other = createLocalTestInstrumentKeyProvider(randomBytes(32), 'TEST-deadbeef');
    const otherKey = () => other.open(sealed, aad);

    for (const fail of [wrongAad, flippedByte, otherKey]) {
      expect(fail).toThrow(LocalTestSealError);
      try {
        fail();
      } catch (err) {
        expect(JSON.stringify(err)).not.toContain(ACCOUNT);
        expect((err as Error).message).not.toContain(ACCOUNT);
      }
    }
  });

  it('starts a provider when the flag, dev, and a marker directory all hold', () => {
    const { state, kms } = stack();
    try {
      const provider = createLocalTestKeyProvider(goodEnv(kms));
      expect(provider).not.toBeNull();
      expect(provider!.kind).toBe('local-test');
      expect(provider!.keyLabel).toMatch(/^TEST-[0-9a-f]{8}$/);
      const keyPath = join(kms, 'p2p-instrument.local-test.key');
      expect(statSync(keyPath).mode & 0o777).toBe(0o600);
      const again = createLocalTestKeyProvider(goodEnv(kms));
      expect(again!.keyLabel).toBe(provider!.keyLabel);
      const aad = instrumentDetailsAad('i', 'o');
      expect(again!.open(provider!.seal('plain', aad), aad)).toBe('plain');
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  it.each([
    ['unset', undefined],
    ['staging', 'staging'],
    ['prod', 'prod'],
    ['production', 'production'],
    ['DEV', 'DEV'],
  ])('refuses APP_ENV %s', (_label, appEnv) => {
    const { state, kms } = stack();
    try {
      const env = goodEnv(kms);
      if (appEnv === undefined) delete env.APP_ENV;
      else env.APP_ENV = appEnv;
      expect(() => createLocalTestKeyProvider(env)).toThrow(LocalTestKmsRefusedError);
      try {
        createLocalTestKeyProvider(env);
      } catch (err) {
        expect(err).toBeInstanceOf(LocalTestKmsRefusedError);
        expect((err as LocalTestKmsRefusedError).code).toBe('p2p.local_test_kms_refused');
        expect((err as LocalTestKmsRefusedError).reasons.join('\n')).toMatch(/APP_ENV must be exactly dev or test/);
        expect((err as Error).message).not.toContain(kms);
      }
      expect(() => statSync(join(kms, 'p2p-instrument.local-test.key'))).toThrow();
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  it('refuses NODE_ENV=production even when APP_ENV is dev', () => {
    const { state, kms } = stack();
    try {
      expect(() => createLocalTestKeyProvider(goodEnv(kms, { NODE_ENV: 'production' }))).toThrow(LocalTestKmsRefusedError);
      try {
        createLocalTestKeyProvider(goodEnv(kms, { NODE_ENV: 'production' }));
      } catch (err) {
        expect((err as LocalTestKmsRefusedError).reasons).toContain('NODE_ENV is production');
      }
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  it('refuses production posture', () => {
    const { state, kms } = stack();
    try {
      expect(() => createLocalTestKeyProvider(goodEnv(kms, { APP_ENV: 'staging' }))).toThrow(LocalTestKmsRefusedError);
      try {
        createLocalTestKeyProvider(goodEnv(kms, { APP_ENV: 'staging' }));
      } catch (err) {
        expect((err as LocalTestKmsRefusedError).reasons).toContain('process is in production posture');
      }
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  it('refuses a directory outside the marker, a symlink, or a blank directory', () => {
    const { state, kms } = stack();
    const outside = mkdtempSync(join(tmpdir(), 'local-kms-out-'));
    const link = join(state, 'linked-kms');
    mkdirSync(kms);
    symlinkSync(kms, link);
    try {
      for (const dir of [outside, link, '']) {
        expect(() => createLocalTestKeyProvider(goodEnv(kms, { LOCAL_TEST_KMS_DIR: dir }))).toThrow(LocalTestKmsRefusedError);
        try {
          createLocalTestKeyProvider(goodEnv(kms, { LOCAL_TEST_KMS_DIR: dir }));
        } catch (err) {
          const reasons = (err as LocalTestKmsRefusedError).reasons.join('\n');
          expect(reasons).toMatch(/LOCAL_TEST_KMS_DIR/);
          expect((err as Error).message).not.toContain(outside);
          expect((err as Error).message).not.toContain(link);
        }
      }
      expect(() => statSync(join(kms, 'p2p-instrument.local-test.key'))).toThrow();
      expect(() => statSync(join(outside, 'p2p-instrument.local-test.key'))).toThrow();
    } finally {
      rmSync(state, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('gives no provider and writes no file when the flag is unset', () => {
    const { state, kms } = stack();
    try {
      const env = goodEnv(kms);
      delete env.LOCAL_TEST_KMS;
      expect(createLocalTestKeyProvider(env)).toBeNull();
      expect(createLocalTestKeyProvider({ ...env, LOCAL_TEST_KMS: '' })).toBeNull();
      expect(() => statSync(join(kms, 'p2p-instrument.local-test.key'))).toThrow();
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  it('names every miss and does not quietly drop a set flag', () => {
    expect(() => createLocalTestKeyProvider({ LOCAL_TEST_KMS: 'yes', NODE_ENV: 'production' })).toThrow(LocalTestKmsRefusedError);
    try {
      createLocalTestKeyProvider({ LOCAL_TEST_KMS: 'yes', NODE_ENV: 'production' });
    } catch (err) {
      const reasons = (err as LocalTestKmsRefusedError).reasons;
      expect(reasons).toEqual(
        expect.arrayContaining([
          'LOCAL_TEST_KMS must be exactly 1',
          'APP_ENV must be exactly dev or test',
          'NODE_ENV is production',
          'process is in production posture',
          'LOCAL_TEST_KMS_DIR is blank',
          'DATABASE_URL host is not loopback',
        ]),
      );
    }
  });

  it('reads LOCAL_TEST_KMS only in the local-test provider and the shared guard', () => {
    const allowed = new Set([join(ROOT, 'services/svc-p2p/src/local-test-kms.ts'), join(ROOT, 'packages/config/src/local-test-guard.ts')]);
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts') && !full.endsWith('.test.ts') && readFileSync(full, 'utf8').includes('LOCAL_TEST_KMS'))
          hits.push(full);
      }
    };
    walk(join(ROOT, 'services/svc-p2p/src'));
    walk(join(ROOT, 'packages/config/src'));
    expect(hits.sort()).toEqual([...allowed].sort());
    expect(lstatSync(join(ROOT, 'services/svc-p2p/src/instrument-key-provider.ts')).isFile()).toBe(true);
  });
});
