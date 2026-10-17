import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { isExplicitDevOrTest, isProductionPosture } from '@intafaced/config';
import { LocalTestKmsRefusedError, createLocalTestInstrumentKeyProvider, type InstrumentKeyProvider } from './instrument-key-provider.js';

/**
 * Boot the local-test instrument key, or return null when the flag is unset.
 *
 * `LOCAL_TEST_KMS` is read only here (and named by the shared fixture guard).
 * It is not a field of `env.ts`. A set flag that misses any check throws
 * `LocalTestKmsRefusedError` and names every miss. It never falls through to
 * "no provider". An unset flag touches no file and logs nothing.
 *
 * The key is 32 random bytes, written once, mode 0600, next to its `TEST-`
 * label, inside a directory whose real path sits under a local-test stack
 * marker. The key is not logged, not put in env, and not written anywhere else.
 */

const KEY_FILE = 'p2p-instrument.local-test.key';
const MARKER_FILE = 'LOCAL-TEST-STACK.json';
const MARKER_KIND = 'intafaced-local-test-stack';
const KEY_BYTES = 32;

type Env = Record<string, string | undefined>;

export function createLocalTestKeyProvider(env: Env = process.env): InstrumentKeyProvider | null {
  const flag = env.LOCAL_TEST_KMS;
  if (flag === undefined || flag === '') return null;

  const reasons: string[] = [];
  if (flag !== '1') reasons.push('LOCAL_TEST_KMS must be exactly 1');
  if (!isExplicitDevOrTest(env.APP_ENV)) reasons.push('APP_ENV must be exactly dev or test');
  if (env.NODE_ENV === 'production') reasons.push('NODE_ENV is production');
  if (isProductionPosture(env)) reasons.push('process is in production posture');
  const dir = assessKmsDir(env.LOCAL_TEST_KMS_DIR);
  reasons.push(...dir.reasons);
  if (!databaseHostIsLoopback(env.DATABASE_URL)) reasons.push('DATABASE_URL host is not loopback');
  if (reasons.length > 0 || dir.dir === null) throw new LocalTestKmsRefusedError(reasons);

  const realDir = ensureRealDir(dir.dir);
  return loadOrCreateKey(realDir);
}

function databaseHostIsLoopback(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return false;
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return false;
  }
  const name = host
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (name === 'localhost' || name === '::1') return true;
  return /^127(?:\.\d{1,3}){3}$/.test(name);
}

function assessKmsDir(raw: string | undefined): { dir: string | null; reasons: string[] } {
  if (raw === undefined || raw.trim() === '') return { dir: null, reasons: ['LOCAL_TEST_KMS_DIR is blank'] };
  if (!path.isAbsolute(raw)) return { dir: null, reasons: ['LOCAL_TEST_KMS_DIR is not an absolute path'] };
  let leaf: ReturnType<typeof lstatSync> | null = null;
  try {
    leaf = lstatSync(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { dir: null, reasons: ['LOCAL_TEST_KMS_DIR is outside a local test stack state directory'] };
    }
  }
  if (leaf?.isSymbolicLink()) return { dir: null, reasons: ['LOCAL_TEST_KMS_DIR is a symlink'] };
  if (leaf !== null && !leaf.isDirectory()) {
    return { dir: null, reasons: ['LOCAL_TEST_KMS_DIR is outside a local test stack state directory'] };
  }

  // One missing leaf is the stack's `<state>/p2p-kms` before the first boot.
  // Ancestors are realpath'd so a system symlink (`/var` → `/private/var`) is
  // the location we judge, not a reason to refuse. The named directory itself
  // being a symlink is refused above, without following it.
  const parent = leaf === null ? path.dirname(raw) : raw;
  let parentReal: string;
  try {
    if (leaf === null) {
      const parentStat = lstatSync(parent);
      if (parentStat.isSymbolicLink()) return { dir: null, reasons: ['LOCAL_TEST_KMS_DIR is a symlink'] };
    }
    parentReal = realpathSync(parent);
  } catch {
    return { dir: null, reasons: ['LOCAL_TEST_KMS_DIR is outside a local test stack state directory'] };
  }
  const planned = leaf === null ? path.join(parentReal, path.basename(raw)) : parentReal;
  const marker = findMarkerDir(parentReal);
  if (marker === null || !isInside(marker, planned)) {
    return { dir: null, reasons: ['LOCAL_TEST_KMS_DIR is outside a local test stack state directory'] };
  }
  return { dir: planned, reasons: [] };
}

function findMarkerDir(start: string): string | null {
  let current = start;
  for (;;) {
    const markerPath = path.join(current, MARKER_FILE);
    try {
      const st = lstatSync(markerPath);
      if (st.isFile() && !st.isSymbolicLink()) {
        const parsed = JSON.parse(readFileSync(markerPath, 'utf8')) as { kind?: unknown };
        if (parsed?.kind === MARKER_KIND) return realpathSync(current);
      }
    } catch {
      // Absent, unreadable, or not the marker. Keep walking.
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isInside(markerReal: string, candidate: string): boolean {
  const rel = path.relative(markerReal, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function ensureRealDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const leaf = lstatSync(dir);
  if (leaf.isSymbolicLink() || !leaf.isDirectory()) {
    throw new LocalTestKmsRefusedError(['LOCAL_TEST_KMS_DIR is a symlink']);
  }
  const real = realpathSync(dir);
  const marker = findMarkerDir(real);
  if (marker === null || !isInside(marker, real)) {
    throw new LocalTestKmsRefusedError(['LOCAL_TEST_KMS_DIR is outside a local test stack state directory']);
  }
  return real;
}

function loadOrCreateKey(realDir: string): InstrumentKeyProvider {
  const keyPath = path.join(realDir, KEY_FILE);
  try {
    const st = lstatSync(keyPath);
    if (st.isSymbolicLink()) throw new LocalTestKmsRefusedError(['local-test key file is a symlink']);
  } catch (err) {
    if (err instanceof LocalTestKmsRefusedError) throw err;
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new LocalTestKmsRefusedError(['local-test key file is unreadable']);
    }
    return writeNewKey(keyPath);
  }
  const realFile = realpathSync(keyPath);
  if (!isInside(realDir, realFile)) throw new LocalTestKmsRefusedError(['local-test key file is a symlink']);
  return readKey(keyPath);
}

function writeNewKey(keyPath: string): InstrumentKeyProvider {
  const key = randomBytes(KEY_BYTES);
  const label = `TEST-${randomBytes(4).toString('hex')}`;
  const body = Buffer.from(JSON.stringify({ label, key: key.toString('base64') }), 'utf8');
  let fd: number;
  try {
    fd = openSync(keyPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return readKey(keyPath);
    throw new LocalTestKmsRefusedError(['local-test key file is a symlink']);
  }
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return createLocalTestInstrumentKeyProvider(key, label);
}

function readKey(keyPath: string): InstrumentKeyProvider {
  let st;
  try {
    st = lstatSync(keyPath);
  } catch {
    throw new LocalTestKmsRefusedError(['local-test key file is unreadable']);
  }
  if (st.isSymbolicLink()) throw new LocalTestKmsRefusedError(['local-test key file is a symlink']);
  if ((st.mode & 0o777) !== 0o600) throw new LocalTestKmsRefusedError(['local-test key file mode is not 0600']);
  let parsed: { label?: unknown; key?: unknown };
  try {
    parsed = JSON.parse(readFileSync(keyPath, 'utf8')) as { label?: unknown; key?: unknown };
  } catch {
    throw new LocalTestKmsRefusedError(['local-test key file is unreadable']);
  }
  if (typeof parsed.label !== 'string' || typeof parsed.key !== 'string') {
    throw new LocalTestKmsRefusedError(['local-test key file is unreadable']);
  }
  const key = Buffer.from(parsed.key, 'base64');
  if (key.length !== KEY_BYTES) throw new LocalTestKmsRefusedError(['local-test key file is unreadable']);
  try {
    return createLocalTestInstrumentKeyProvider(key, parsed.label);
  } catch {
    throw new LocalTestKmsRefusedError(['local-test key file is unreadable']);
  }
}
