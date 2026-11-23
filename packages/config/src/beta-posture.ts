import { BETA_POSTURE_ENV, BETA_POSTURE_VALUE } from './app-env.js';

/**
 * THE BETA POSTURE'S BOOT CHECK — test networks only, or no start.
 *
 * `INTAFACED_BETA_POSTURE=test-networks` beside `APP_ENV=staging` lets TEST networks and labelled TEST stand-ins run
 * on a hosted beta (app-env.ts, `isBetaPosture`). It loosens nothing else: the process is still in production posture
 * (production-posture.ts runs first in `loadEnv`), so dev keys, published passwords and blank owner values still
 * refuse. What this check adds is the other half of the bargain: a beta process with any mainnet, real bank or real
 * card route configured refuses to start, so a beta can never touch real money by a setting.
 *
 * It runs inside `loadEnv`, like the production posture, so every service gets it with no per-service wiring.
 * Unset or blank switch: nothing to check, and nothing is opened. Messages name the variable, never its value.
 */

type Env = Record<string, unknown>;

export const BETA_POSTURE_REFUSE_CODE = 'config.beta_posture_refused' as const;

/**
 * The public TEST networks a beta may name by chain id. Fail-closed: a chain id not on this list (a mainnet, a local
 * dev chain, a typo) refuses. Adding a testnet here is the only way to open one.
 */
export const BETA_TESTNET_CHAIN_IDS: ReadonlyMap<number, string> = new Map([
  [11155111, 'Ethereum Sepolia'],
  [560048, 'Ethereum Hoodi'],
  [17000, 'Ethereum Holesky'],
  [84532, 'Base Sepolia'],
  [421614, 'Arbitrum Sepolia'],
  [11155420, 'OP Sepolia'],
  [80002, 'Polygon Amoy'],
  [998, 'HyperEVM testnet'],
]);

/** Hosts of known mainnet endpoints; any host with a `mainnet` label (eth-mainnet.g.alchemy.com, mainnet.infura.io) also counts. */
const MAINNET_HOSTS = new Set(['api.hyperliquid.xyz', 'cloudflare-eth.com', 'eth.llamarpc.com', 'base.llamarpc.com']);

function isMainnetHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (MAINNET_HOSTS.has(host)) return true;
  return host.split('.').some((label) => label === 'mainnet' || label.startsWith('mainnet-') || label.endsWith('-mainnet'));
}

/**
 * A bank or card partner setting (`BANK_*_PARTNER`, `BANK_*_ISSUER`, `BANK_*_SCHEME`): on a beta it must name no
 * partner or a stand-in. Today's schemas allow nothing else; this keeps a future live value from reaching a beta.
 */
const BANK_ROUTE_KEY = /^BANK_[A-Z0-9_]*(?:PARTNER|ISSUER|SCHEME)$/;
const BANK_STAND_IN_VALUE = /^(?:none|off|test|[a-z0-9]+(?:-[a-z0-9]+)*-sim)$/;

export class BetaPostureError extends Error {
  readonly code = BETA_POSTURE_REFUSE_CODE;
  constructor(readonly issues: readonly string[]) {
    super(
      `BETA POSTURE REFUSED (${BETA_POSTURE_REFUSE_CODE}). Refusing to start.\n` +
        `${BETA_POSTURE_ENV}=${BETA_POSTURE_VALUE} runs only beside APP_ENV=staging, on TEST networks and labelled TEST stand-ins.\n  - ${issues.join('\n  - ')}`,
    );
    this.name = 'BetaPostureError';
  }
}

/** Every reason this process may not run in the beta posture. Empty when the switch is unset, or set and clean. */
export function betaPostureIssues(env: Env = process.env): string[] {
  const raw = env[BETA_POSTURE_ENV];
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  const issues: string[] = [];
  if (raw !== BETA_POSTURE_VALUE) {
    issues.push(`${BETA_POSTURE_ENV} is set to a value other than ${BETA_POSTURE_VALUE}`);
    return issues;
  }
  if (env.APP_ENV !== 'staging') {
    issues.push(`${BETA_POSTURE_ENV} is set but APP_ENV is not exactly staging (the beta posture never runs in prod, dev or test)`);
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    const v = value.trim();
    if (key.endsWith('_CHAIN_ID')) {
      const id = Number(v);
      if (!Number.isInteger(id) || !BETA_TESTNET_CHAIN_IDS.has(id)) {
        issues.push(`${key} names a chain that is not a public TEST network (a mainnet route)`);
      }
      continue;
    }
    if (BANK_ROUTE_KEY.test(key)) {
      if (!BANK_STAND_IN_VALUE.test(v))
        issues.push(`${key} names a bank or card partner that is not a TEST stand-in (a real bank or card route)`);
      continue;
    }
    for (const part of v.split(',')) {
      let url: URL;
      try {
        url = new URL(part.trim());
      } catch {
        continue;
      }
      if (/^(?:https?|wss?):$/.test(url.protocol) && isMainnetHost(url.hostname)) {
        issues.push(`${key} points at a mainnet endpoint (a mainnet route)`);
        break;
      }
    }
  }
  return issues;
}

/** Throws `BetaPostureError` when the beta switch is set and anything above refuses it. */
export function assertBetaPosture(env: Env = process.env): void {
  const issues = betaPostureIssues(env);
  if (issues.length > 0) throw new BetaPostureError(issues);
}
