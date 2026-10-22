import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * `promisify` drops scrypt's options overload, so this is wrapped by hand.
 * The options matter — they are the cost parameters.
 */
function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (err, derived) => (err ? reject(err) : resolve(derived)));
  });
}

/**
 * Password hashing.
 *
 * §9 specifies **argon2id**. `@node-rs/argon2` is the intended implementation
 * and is wired in below — but it is a native module, and a native module that
 * fails to install must not stop a developer from running the test suite.
 *
 * So: argon2id when available, scrypt otherwise. Both are memory-hard and both
 * are acceptable; what is NOT acceptable is a fast hash, and there is no path
 * here that reaches one. The stored string records which algorithm produced it,
 * so a hash made under one is verifiable under the other and users are migrated
 * on next login without ever needing a reset.
 *
 * In production the fallback is not permitted: `assertArgon2Available()` is
 * called at boot when APP_ENV=prod, so the process refuses to start rather than
 * quietly hashing new passwords with the weaker option.
 */

export type Algorithm = 'argon2id' | 'scrypt';

interface Argon2Module {
  hash(password: string, options?: Record<string, unknown>): Promise<string>;
  verify(hash: string, password: string, options?: Record<string, unknown>): Promise<boolean>;
}

let argon2: Argon2Module | null = null;
let argon2Probed = false;

async function loadArgon2(): Promise<Argon2Module | null> {
  if (argon2Probed) return argon2;
  argon2Probed = true;
  try {
    argon2 = (await import('@node-rs/argon2')) as unknown as Argon2Module;
  } catch {
    argon2 = null;
  }
  return argon2;
}

export async function argon2Available(): Promise<boolean> {
  return (await loadArgon2()) !== null;
}

/** Called at boot in production — §9 does not permit the fallback there. */
export async function assertArgon2Available(): Promise<void> {
  if (!(await argon2Available())) {
    throw new Error(
      'argon2id is unavailable and APP_ENV=prod. Install @node-rs/argon2 for this platform; ' +
        'the scrypt fallback is a development convenience, not a production configuration (§9).',
    );
  }
}

/**
 * OWASP-aligned parameters. Deliberately expensive: this function taking ~100ms
 * is the entire defence against an offline cracking run.
 */
const ARGON2_PARAMS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/**
 * scrypt at N=2^15, r=8 needs 128·N·r = 32 MiB, which is exactly Node's default
 * `maxmem` — so it fails with "memory limit exceeded" unless the ceiling is
 * raised explicitly. Found by a test, not by reasoning; without it every
 * password hash on a machine lacking argon2 would throw.
 */
const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 } as const;

export async function hashPassword(password: string): Promise<string> {
  assertPasswordShape(password);

  const argon = await loadArgon2();
  if (argon) return argon.hash(password, ARGON2_PARAMS);

  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_PARAMS.keylen, SCRYPT_PARAMS);
  return `$scrypt$N=${SCRYPT_PARAMS.N},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  if (storedHash.startsWith('$argon2')) {
    const argon = await loadArgon2();
    if (!argon) throw new Error('Stored hash is argon2id but argon2 is unavailable — cannot verify');
    try {
      return await argon.verify(storedHash, password, ARGON2_PARAMS);
    } catch {
      return false;
    }
  }

  if (storedHash.startsWith('$scrypt$')) {
    const parts = storedHash.split('$');
    const params = parts[2] ?? '';
    const salt = Buffer.from(parts[3] ?? '', 'base64');
    const expected = Buffer.from(parts[4] ?? '', 'base64');
    if (expected.length === 0) return false;

    const N = Number(/N=(\d+)/.exec(params)?.[1] ?? SCRYPT_PARAMS.N);
    const r = Number(/r=(\d+)/.exec(params)?.[1] ?? SCRYPT_PARAMS.r);
    const p = Number(/p=(\d+)/.exec(params)?.[1] ?? SCRYPT_PARAMS.p);

    try {
      const derived = await scrypt(password, salt, expected.length, { N, r, p, maxmem: SCRYPT_PARAMS.maxmem });
      return derived.length === expected.length && timingSafeEqual(derived, expected);
    } catch {
      // A stored hash we cannot evaluate is a failed verification, never a 500.
      // Throwing here would turn a corrupt row into an outage, and would leak
      // through timing which accounts have unusable hashes.
      return false;
    }
  }

  return false;
}

/**
 * A real hash of a random string, computed once.
 *
 * Login compares against this when no user matches, so an unknown account costs
 * the same time as a wrong password. A hand-written fake string would either
 * return early or throw — both of which are the enumeration oracle this exists
 * to close.
 */
let dummyHash: Promise<string> | null = null;

export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(`unused-${randomBytes(24).toString('hex')}`);
  return dummyHash;
}

/** True when the hash was made with something we would no longer choose. */
export async function needsRehash(storedHash: string): Promise<boolean> {
  return storedHash.startsWith('$scrypt$') && (await argon2Available());
}

export function algorithmOf(storedHash: string): Algorithm | 'unknown' {
  if (storedHash.startsWith('$argon2id')) return 'argon2id';
  if (storedHash.startsWith('$scrypt$')) return 'scrypt';
  return 'unknown';
}

export class WeakPasswordError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'WeakPasswordError';
  }
}

/**
 * Length over composition rules.
 *
 * Character-class requirements push people toward `Password1!` — predictable,
 * and weaker than a long passphrase. NIST dropped them for exactly that reason.
 * The 72-byte ceiling is bcrypt's; we do not use bcrypt, but staying inside it
 * keeps a future migration open.
 */
export function assertPasswordShape(password: string): void {
  if (typeof password !== 'string') throw new WeakPasswordError('Password must be a string');
  if (password.length < 12) throw new WeakPasswordError('Password must be at least 12 characters');
  if (Buffer.byteLength(password, 'utf8') > 72) throw new WeakPasswordError('Password must be at most 72 bytes');
  if (/^(.)\1+$/.test(password)) throw new WeakPasswordError('Password cannot be a single repeated character');
}

/**
 * A password must not be the account's own name (I-signin-sessions-04): not the handle, not the email address and
 * not the email's local part, compared without case and surrounding spaces. Those are public or guessable.
 */
export function assertPasswordNotIdentity(password: string, identity: { handle?: string | null; email?: string | null }): void {
  const candidate = password.trim().toLowerCase();
  const email = identity.email?.trim().toLowerCase() ?? '';
  const local = email.includes('@') ? email.slice(0, email.lastIndexOf('@')) : '';
  const handle = identity.handle?.trim().toLowerCase() ?? '';
  for (const name of [handle, email, local]) {
    if (name !== '' && candidate === name) throw new WeakPasswordError('Password cannot be your handle or email address');
  }
}

/** SHA-256 for high-entropy tokens — refresh tokens, API keys. Not for passwords. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * API keys are shown once. The prefix is stored so the UI can say which key is
 * which without ever holding the secret.
 *
 * Sandbox keys use `ifc_test_…` so a merchant can tell them apart at a glance;
 * live keys keep the historical `ifc_…` prefix. Mode of record is still the
 * `api_keys.mode` column — the prefix is presentation, not the gate.
 */
export function generateApiKey(mode: 'live' | 'sandbox' = 'live'): { key: string; hash: string; prefix: string } {
  const head = mode === 'sandbox' ? 'ifc_test_' : 'ifc_';
  const key = `${head}${generateToken(24)}`;
  return { key, hash: hashToken(key), prefix: key.slice(0, 12) };
}
