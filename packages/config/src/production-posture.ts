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
 * `APP_ENV` is still caught. Compose defaults `APP_ENV` to `dev` (`${APP_ENV:-dev}`) for local runs, so a host that forgets it
 * is unguarded; the staging file should require it (`${APP_ENV:?}`).
 *
 * Messages name the variable, never its value: a refusal must not leak the secret
 * it is refusing.
 *
 * TWO KINDS OF REFUSAL, one guard. Development material (above) and one setting: S2S body binding. In production
 * posture a process that holds `INTERNAL_SERVICE_SECRET` must also say `INTERNAL_SERVICE_BODY_BIND=require`, or it
 * refuses to start with its own code (`config.s2s_body_bind_not_required`). It used to be a boot warning. It is a refusal
 * now because the setting that was safe to leave soft has stopped being soft:
 *   - the tRPC door is already `require` in code (#4667) and ignores this variable, so the only thing the variable still
 *     decides is the raw `/internal` REST routes, where the migration default `accept-both` leaves a captured service
 *     signature replayable against any body for 300 seconds;
 *   - no in-repo caller signs v1 any more (every outbound client uses `serviceAuthHeadersForBody`), so `require` refuses
 *     no honest caller; every service that verifies on raw routes installs `retainRawBody` first, so it does not 401 them
 *     as `body-unavailable` either;
 *   - the launch services' own suites (svc-ledger, -identity, -ops, -notify, -trade, -edge) pass with `require` exported, and each
 *     raw route module answers an honest v2 call under it (survey and run in `docs/decisions/s2s-body-bind.md`).
 * A warning nobody reads leaves the hole open on the one host where it matters. There is no flag that turns this off,
 * for the same reason as the rest of the guard. `accept-both` stays the default for local runs and tests (APP_ENV dev/test
 * is not production posture), so nothing on a laptop changes.
 */

type Env = Record<string, unknown>;

export const PRODUCTION_POSTURE_REFUSE_CODE = 'config.dev_material_in_production_posture' as const;

/** The twenty well-known Anvil / Hardhat account keys (public in every tutorial; Anvil ships ten, Hardhat twenty). */
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
  '0xf214f2b2cd398c806f84e317254e0f0b801d0643303237d97a22a48e01628897',
  '0x701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82',
  '0xa267530f49f8280200edf313ee7af6b827f2a8bce2897751d06a843f644967b1',
  '0x47c99abed3324a2707c28affff1267e45918ec8c3f20b8aa892e8b065d2942dd',
  '0xc526ee95bf44d8fc405a158bb884d9d1238d99f0612e9f33d006bb0789009aaa',
  '0x8166f546bab6da521a8369cab06c5d2b9e46670292d85c875ee9ec20e84ffb61',
  '0xea6c44ac03bff858b476bba40716402b03e41b8e97e276d1baec7c37d42484a0',
  '0x689af8efa8c651a91ad287602527f3af2fe9f6501a7ac4b061667b5a93e037fd',
  '0xde9be858da4a475276426320d5e9262ecfc3ba460bfac56360bfa6c4c28b4ee0',
  '0xdf57089febbacf7ba0bc227dafbffa9fc08a93fdc68e1e42411a14efcf23656e',
] as const;

/**
 * Addresses nobody should hold real value at: the twenty Anvil / Hardhat accounts and the first ten contract
 * addresses account 0 deploys (the `PROTOCOL_*_ADDRESS` values in `.env.example`). Whoever holds the
 * public account-0 key controls them on any chain. Compared case-insensitively.
 */
export const KNOWN_DEV_ADDRESSES = [
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
  '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  '0x976EA74026E726554dB657fA54763abd0C3a0aa9',
  '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955',
  '0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f',
  '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720',
  '0xBcd4042DE499D14e55001CcbB24a551F3b954096',
  '0x71bE63f3384f5fb98995898A86B02Fb2426c5788',
  '0xFABB0ac9d68B0B445fB7357272Ff202C5651694a',
  '0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec',
  '0xdF3e18d64BC6A983f673Ab319CCaE4f1a57C7097',
  '0xcd3B766CCDd6AE721141F452C550Ca635964ce71',
  '0x2546BcD3c84621e976D8185a91A922aE77ECEc30',
  '0xbDA5747bFD65F08deb54cb465eB87D40e51B197E',
  '0xdD2FD4581271e230360230F9337D5c0430Bf44C0',
  '0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199',
  '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
  '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9',
  '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9',
  '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707',
  '0x0165878A594ca255338adfa4d48449f69242Eb8F',
  '0xa513E6E4b8f2a923D98304ec87F64353C4D5C853',
  '0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6',
  '0x8A791620dd6260079BF849Dc5567aDC3F2FdC318',
] as const;

/** The standard Anvil / Hardhat test mnemonic. */
const KNOWN_DEV_MNEMONIC = 'test test test test test test test test test test test junk';

/** Local development chain ids: Anvil/Hardhat 31337, Ganache 1337. */
const DEV_CHAIN_IDS = new Set([31337, 1337]);

/**
 * Database passwords that are published in this repo's compose files, init SQL and docs. The init SQL creates every
 * `svc_<name>` role with its own name as the password (list kept in step with `tooling/infra/postgres-init/01-service-schemas.sql`
 * by a test), plus `intafaced_ops`, and compose connects the data lake as `svc_connect_lake`. An exact list, not a
 * prefix: a strong password that merely starts `svc_` is fine.
 */
const SERVICE_ROLE_NAMES = [
  'identity',
  'ledger',
  'token',
  'matching',
  'trade',
  'pay',
  'p2p',
  'blueprint',
  'bank',
  'launch',
  'academy',
  'market',
  'mining_pool',
  'agents',
  'core_ops',
  'ops',
  'notify',
  'support',
  'quant',
  'chain',
  'indexer',
  'bridge',
  'protocol',
  'connect_lake',
] as const;
export const PUBLISHED_DATABASE_PASSWORDS: ReadonlySet<string> = new Set([
  ...SERVICE_ROLE_NAMES.map((name) => `svc_${name}`),
  'intafaced',
  'intafaced_ops',
  'postgres',
  'password',
  'changeme',
]);

/** "dev-only-" / "test-only-" at a word start, or a whole-word "replace-me" / "change-me" (not "exchange-metrics"). */
const PLACEHOLDER = /(?:^|[^a-z0-9])(?:dev|test)[-_]only[-_]|(?:^|[^a-z0-9])(?:replace|change)[-_]?me(?:$|[^a-z0-9])/i;
/** Service names compose gives the local chain node. */
const LOCAL_CHAIN_HOSTNAMES = new Set(['evm', 'anvil', 'hardhat', 'ganache', 'host.docker.internal']);

/** True for loopback in any spelling, `*.localhost`, and the local chain node's compose name. */
function isLocalChainHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::' || host === '::1') return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (/^::ffff:(?:127\.|7f)/.test(host)) return true;
  return LOCAL_CHAIN_HOSTNAMES.has(host);
}

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

/** decodeURIComponent that never throws: a malformed escape is compared as written. */
function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const KNOWN_DEV_KEYS_LOWER = KNOWN_DEV_PRIVATE_KEYS.flatMap((k) => [k, k.slice(2)]);
const KNOWN_DEV_ADDRESSES_LOWER = KNOWN_DEV_ADDRESSES.map((a) => a.toLowerCase());
const DB_URL = /^(?:postgres|postgresql|redis|rediss|nats|tls|amqp|amqps):\/\//i;
/** Variables only the test runner sets (TEST_DATABASE_URL points at a throwaway database). */
const TEST_RUNNER_KEY = /^TEST_DATABASE_URL(?:_[A-Z0-9_]+)?$/;

/** What is wrong with the credentials inside one connection URL, by kind. Empty when nothing. */
function credentialIssues(key: string, value: string, env: Env): string[] {
  const issues: string[] = [];
  for (const part of value.split(',')) {
    const text = part.trim();
    if (!DB_URL.test(text)) continue;
    const url = urlParts(text);
    if (url === null) continue;
    const user = decoded(url.username);
    const password = decoded(url.password) || url.searchParams.get('password') || '';
    const isPostgres = /^postgres(?:ql)?:/i.test(text);
    if (password === '') {
      const pgPassword = typeof env.PGPASSWORD === 'string' && env.PGPASSWORD.trim() !== '';
      if (isPostgres && user !== '' && !pgPassword && !url.searchParams.get('sslcert')) {
        issues.push(`${key} has no database password (and no PGPASSWORD or client certificate)`);
      }
    } else if (password === user || PUBLISHED_DATABASE_PASSWORDS.has(password.toLowerCase())) {
      issues.push(`${key} uses a connection password that is published in this repo (or equals the user name)`);
    }
  }
  return issues;
}

/** Every piece of development material found in `env`, by variable name. Empty when none, or when not in production posture. */
export function productionPostureIssues(env: Env = process.env): string[] {
  if (!isProductionPosture(env)) return [];
  const issues: string[] = [];
  for (const [key, raw] of Object.entries(env)) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (value === '') continue;
    if (TEST_RUNNER_KEY.test(key)) continue;
    const lower = value.toLowerCase();

    if (PLACEHOLDER.test(value)) {
      issues.push(`${key} holds a dev/test placeholder value ("dev-only-", "test-only-", "replace-me" or "change-me")`);
    }
    if (KNOWN_DEV_KEYS_LOWER.some((k) => lower.includes(k))) {
      issues.push(`${key} holds a well-known Anvil/Hardhat private key (public, anyone can spend from it)`);
    }
    if (lower.includes(KNOWN_DEV_MNEMONIC)) {
      issues.push(`${key} holds the well-known Anvil/Hardhat test mnemonic (public, anyone can derive its keys)`);
    }
    if (KNOWN_DEV_ADDRESSES_LOWER.some((a) => lower.includes(a))) {
      issues.push(`${key} holds a well-known Anvil/Hardhat address (its keys are public, so anyone controls it on a real chain)`);
    }
    if (/CHAIN_IDS?$/i.test(key)) {
      // The schemas parse these with Number(), so 0x7a69, 031337 and 31337.0 all boot as chain 31337. A list counts too.
      for (const part of value.split(/[,\s]+/)) {
        const id = Number(part);
        if (part !== '' && Number.isFinite(id) && DEV_CHAIN_IDS.has(id))
          issues.push(`${key} includes ${part}, a local development chain id`);
      }
    }
    if (/(?:^|_)(?:RPC|BUNDLER)(?:_|$)|(?:^|_)(?:INDEXER|PROTOCOL|CHAIN)_WS_URL$|CHAIN_URL$/i.test(key)) {
      for (const part of value.split(',')) {
        const host = urlParts(part.trim())?.hostname;
        if (host !== undefined && isLocalChainHost(host)) issues.push(`${key} points at a local chain node (${host.toLowerCase()})`);
      }
    }
    // By the shape of the value, not the variable name: DATABASE_URL, OPS_DB_URL, CONNECT_DATA_LAKE_TSDB_URL, ...
    issues.push(...credentialIssues(key, value, env));
    if (/^PGPASSWORD$/i.test(key) && PUBLISHED_DATABASE_PASSWORDS.has(value.toLowerCase())) {
      issues.push(`${key} is a database password that is published in this repo`);
    }
  }
  return issues;
}

/** Refusal code for a production-posture process that holds the service secret but does not bind signed calls to their body. */
export const S2S_BODY_BIND_REFUSE_CODE = 'config.s2s_body_bind_not_required' as const;

/**
 * What is wrong with S2S body binding, as one line per problem. Empty when not in production posture, when the
 * process holds no `INTERNAL_SERVICE_SECRET` (it does not speak service-to-service), or when
 * `INTERNAL_SERVICE_BODY_BIND` is exactly `require`. Unset, `accept-both`, a typo and a different case all refuse:
 * only the exact value closes the replay, and the schema's own default is the weak one.
 */
export function productionPostureS2sIssues(env: Env = process.env): string[] {
  if (!isProductionPosture(env)) return [];
  const secret = env.INTERNAL_SERVICE_SECRET;
  if (typeof secret !== 'string' || secret.trim() === '') return [];
  if (env.INTERNAL_SERVICE_BODY_BIND === 'require') return [];
  return [
    'INTERNAL_SERVICE_BODY_BIND must be exactly "require" where INTERNAL_SERVICE_SECRET is set: any other value (or none) ' +
      'leaves signed service calls replayable against any body for 300 seconds. Fix: set INTERNAL_SERVICE_BODY_BIND=require ' +
      '(docs/decisions/s2s-body-bind.md)',
  ];
}

export class ProductionPostureError extends Error {
  readonly code: typeof PRODUCTION_POSTURE_REFUSE_CODE | typeof S2S_BODY_BIND_REFUSE_CODE;
  constructor(
    readonly appEnv: string | null,
    readonly issues: readonly string[],
    code: typeof PRODUCTION_POSTURE_REFUSE_CODE | typeof S2S_BODY_BIND_REFUSE_CODE = PRODUCTION_POSTURE_REFUSE_CODE,
  ) {
    const shown = `APP_ENV=${appEnv === null || appEnv === '' ? '<unset>' : appEnv}`;
    super(
      code === S2S_BODY_BIND_REFUSE_CODE
        ? `SERVICE CALLS MUST BE BOUND TO THEIR BODY HERE (${shown}, ${code}). Refusing to start.\n` +
            `Only APP_ENV exactly "dev" or "test" may run on the migration setting.\n  - ${issues.join('\n  - ')}`
        : `DEVELOPMENT MATERIAL IS NOT ALLOWED HERE (${shown}, ${code}). Refusing to start.\n` +
            `Only APP_ENV exactly "dev" or "test" may run on dev keys, the Anvil chain or published passwords.\n  - ${issues.join('\n  - ')}`,
    );
    this.code = code;
    this.name = 'ProductionPostureError';
  }
}

/**
 * Throws `ProductionPostureError` if a production-posture process carries development material or does not bind
 * service calls to their body. Everything wrong is listed in one error, so a fix is one restart, not two: the code is
 * `config.dev_material_in_production_posture` when any development material is present (the S2S line rides along),
 * `config.s2s_body_bind_not_required` when that setting is the only problem.
 */
export function assertProductionPosture(env: Env = process.env): void {
  const material = productionPostureIssues(env);
  const s2s = productionPostureS2sIssues(env);
  if (material.length === 0 && s2s.length === 0) return;
  const appEnv = typeof env.APP_ENV === 'string' ? env.APP_ENV : null;
  throw new ProductionPostureError(
    appEnv,
    [...material, ...s2s],
    material.length > 0 ? PRODUCTION_POSTURE_REFUSE_CODE : S2S_BODY_BIND_REFUSE_CODE,
  );
}
