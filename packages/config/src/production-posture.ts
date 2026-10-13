import { isExplicitDevOrTest } from './app-env.js';

/**
 * PRODUCTION POSTURE — a real server refuses to start on development material.
 *
 * The repo ships dev keys on purpose (`.env.example`, compose defaults, the
 * Anvil test chain). Each is harmless on a laptop and a total loss on a server
 * real users can reach: anyone can read the Anvil keys on GitHub, and a
 * `dev-only-` signing secret is a published password. Nothing stopped a server
 * from booting on them, so this check does.
 *
 * It runs inside `loadEnv`, so every service that loads its environment gets it
 * with no per-service wiring to forget. It is automation, not an approval step:
 * there is no flag that turns it off, because a flag nobody sets is the failure
 * it exists to prevent.
 *
 * POSTURE. A process is in production posture when its raw `APP_ENV` is anything
 * other than exactly `dev` or `test`, with one exception: an UNSET `APP_ENV` on a
 * laptop or in a unit test (no `NODE_ENV=production`) is not production. The
 * Dockerfile sets `NODE_ENV=production`, so a container whose operator forgot
 * `APP_ENV` is still caught. Compose sets `APP_ENV=dev` explicitly for local runs.
 *
 * Messages name the variable, never its value: a refusal must not leak the secret
 * it is refusing.
 */

type Env = Record<string, unknown>;

export const PRODUCTION_POSTURE_REFUSE_CODE = 'config.dev_material_in_production_posture' as const;

/** The ten well-known Anvil / Hardhat account keys (public in every tutorial). */
export const KNOWN_DEV_PRIVATE_KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
  '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97',
  '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6',
] as const;

/** The standard Anvil / Hardhat test mnemonic. */
const KNOWN_DEV_MNEMONIC = 'test test test test test test test test test test test junk';

/** Local development chain ids: Anvil/Hardhat 31337, Ganache 1337. */
const DEV_CHAIN_IDS = new Set(['31337', '1337']);

/** Database passwords that are published in this repo's compose files and docs. */
const DEV_DATABASE_PASSWORDS = new Set(['intafaced', 'intafaced_ops', 'postgres', 'password', 'changeme']);

const PLACEHOLDER = /(?:^|[^a-z0-9])(?:dev|test)-only-|replace-?me|change-?me/i;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]', 'host.docker.internal']);

/** True when this process must be treated as a real (staging or production) server. */
export function isProductionPosture(env: Env = process.env): boolean {
  const appEnv = typeof env.APP_ENV === 'string' ? env.APP_ENV : undefined;
  if (isExplicitDevOrTest(appEnv)) return false;
  if (appEnv !== undefined && appEnv.trim() !== '') return true;
  return env.NODE_ENV === 'production';
}

function urlParts(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Every piece of development material found in `env`, by variable name. Empty when none, or when not in production posture. */
export function productionPostureIssues(env: Env = process.env): string[] {
  if (!isProductionPosture(env)) return [];
  const issues: string[] = [];
  for (const [key, raw] of Object.entries(env)) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (value === '') continue;
    // Variables only the test runner sets (TEST_DATABASE_URL points at a throwaway database).
    if (key.startsWith('TEST_')) continue;
    const lower = value.toLowerCase();

    if (PLACEHOLDER.test(value)) {
      issues.push(`${key} holds a dev/test placeholder value ("dev-only-", "test-only-", "replace-me" or "change-me")`);
    }
    if (KNOWN_DEV_PRIVATE_KEYS.some((k) => lower.includes(k) || lower.includes(k.slice(2)))) {
      issues.push(`${key} holds a well-known Anvil/Hardhat private key (public, anyone can spend from it)`);
    }
    if (lower.includes(KNOWN_DEV_MNEMONIC)) {
      issues.push(`${key} holds the well-known Anvil/Hardhat test mnemonic (public, anyone can derive its keys)`);
    }
    if (/CHAIN_ID/i.test(key) && DEV_CHAIN_IDS.has(value)) {
      issues.push(`${key} is ${value}, a local development chain id`);
    }
    if (/RPC_(?:URL|ENDPOINT)/i.test(key)) {
      const host = urlParts(value)?.hostname.toLowerCase();
      if (host !== undefined && LOCAL_HOSTS.has(host)) issues.push(`${key} points at a local chain node (${host})`);
    }
    if (/(?:^|_)DATABASE_URL$/i.test(key)) {
      const url = urlParts(value);
      if (url !== null) {
        const password = decodeURIComponent(url.password);
        const user = decodeURIComponent(url.username);
        if (password === '' && user !== '') {
          issues.push(`${key} has no database password`);
        } else if (password !== '' && (password === user || DEV_DATABASE_PASSWORDS.has(password.toLowerCase()))) {
          issues.push(`${key} uses a database password that is published in this repo (or equals the user name)`);
        }
      }
    }
  }
  return issues;
}

export class ProductionPostureError extends Error {
  readonly code = PRODUCTION_POSTURE_REFUSE_CODE;
  constructor(
    readonly appEnv: string | null,
    readonly issues: readonly string[],
  ) {
    super(
      `DEVELOPMENT MATERIAL IS NOT ALLOWED HERE (APP_ENV=${appEnv === null || appEnv === '' ? '<unset>' : appEnv}, ${PRODUCTION_POSTURE_REFUSE_CODE}). Refusing to start.\n` +
        `Only APP_ENV exactly "dev" or "test" may run on dev keys, the Anvil chain or published passwords.\n  - ${issues.join('\n  - ')}`,
    );
    this.name = 'ProductionPostureError';
  }
}

/** Throws `ProductionPostureError` if a production-posture process carries development material. */
export function assertProductionPosture(env: Env = process.env): void {
  const issues = productionPostureIssues(env);
  if (issues.length > 0) throw new ProductionPostureError(typeof env.APP_ENV === 'string' ? env.APP_ENV : null, issues);
}
