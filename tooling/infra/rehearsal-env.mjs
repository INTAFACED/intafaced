#!/usr/bin/env node
/**
 * The settings for the stack rehearsal (.github/workflows/stack-rehearsal.yml): the containerised stack booted on a
 * throwaway runner with APP_ENV=staging, the way a hosted deploy starts it.
 *
 *   node tooling/infra/rehearsal-env.mjs <env-file> <roles-sql-file>
 *
 * Starts from .env.example and changes only what production posture refuses (packages/config/src/production-posture.ts):
 * every `dev-only-` secret and every published `svc_<name>` database password gets a fresh random value, made on the
 * runner and gone with it; APP_ENV is staging, the beta posture is on, signed service calls bind their body, and
 * svc-identity gets an https origin. The roles file rotates each role to its new password, since the database's init
 * SQL creates them with the published one. Only names are printed, never a value: the Actions log is public.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** What production posture needs that .env.example leaves at its local value. */
export const POSTURE = {
  APP_ENV: 'staging',
  INTAFACED_BETA_POSTURE: 'test-networks',
  INTERNAL_SERVICE_BODY_BIND: 'require',
  WEBAUTHN_RP_ID: 'localhost',
  WEBAUTHN_ORIGIN: 'https://localhost:8090',
};

/**
 * TEST stand-ins for owner values the compose file requires and .env.example leaves blank, so the rehearsal can start at
 * all. They live on the throwaway runner only and the run lists them as what a hosted stack still needs from the owner.
 * The values are the local test stack's (tooling/scripts/local-stack-services/). The AI gateway runs only under
 * `--profile ai`, which the rehearsal does not start; compose still reads its settings, so they point at nothing.
 */
export const TEST_STAND_INS = {
  EDGE_RATE_LIMIT_MAX: '6000',
  EDGE_RATE_LIMIT_WINDOW_MS: '60000',
  EDGE_BODY_LIMIT_BYTES: '1048576',
  RECONCILE_CRON_MINUTES: '60',
  MATCHING_SNAPSHOT_EVERY: '0',
  MATCHING_OPERATOR_IDS: '00000000-0000-4000-8000-00000000000a,00000000-0000-4000-8000-00000000000b',
  LOAN_QUOTE_ASSET_ID: 'USDT',
  LOAN_SWEEP_BATCH_SIZE: '1',
  TRANSFER_BATCH_SIZE: '1',
  IDENTITY_SIGNUP_CLOSED_COUNTRIES: 'AQ',
  NOTIFY_REQUIRED_CHANNELS: 'none',
  INDEXER_VENUE_ADDRESS: '0x0000000000000000000000000000000000000000',
  INDEXER_START_HEIGHT: '0',
  INDEXER_FINALITY_DEPTH: '2',
  INDEXER_BATCH_SIZE: '50',
  LITELLM_CONFIG_PATH: '/dev/null',
  LITELLM_MASTER_KEY: 'TEST-rehearsal-gateway-not-started',
};

/**
 * Production posture refuses the local chain (.env.example's Anvil, chain 31337), and the beta posture runs TEST networks
 * only: the rehearsal points the protocol and the indexer at the public Base Sepolia testnet's own endpoint. Always set.
 */
export const TEST_NETWORK = {
  PROTOCOL_CHAIN_ID: '84532',
  PROTOCOL_RPC_URL: 'https://sepolia.base.org',
  INDEXER_RPC_URL: 'https://sepolia.base.org',
};

const LINE = /^([A-Z][A-Z0-9_]*)=(.*)$/;
const DB_PASSWORD = /\$\{(SVC_([A-Z_]+)_DB_PASSWORD):-/g;

/**
 * @param {{ example: string, compose: string, random?: () => string, extra?: Record<string, string | undefined> }} input
 * @returns {{ env: Map<string, string>, roles: { role: string, name: string }[], generated: string[], standIns: string[] }}
 */
export function rehearsalEnv({ example, compose, random = () => randomBytes(32).toString('hex'), extra = {} }) {
  const env = new Map();
  const generated = [];
  for (const raw of example.split('\n')) {
    const m = LINE.exec(raw.trim());
    if (!m) continue;
    const [, name, value] = m;
    if (value.replace(/^["']/, '').startsWith('dev-only-')) {
      env.set(name, random());
      generated.push(name);
    } else {
      env.set(name, value);
    }
  }
  const standIns = [];
  for (const [name, value] of Object.entries(TEST_STAND_INS)) {
    if (env.get(name)) continue;
    env.set(name, value);
    standIns.push(name);
  }
  for (const [name, value] of Object.entries({ ...TEST_NETWORK, ...POSTURE })) env.set(name, value);
  const roles = [];
  for (const [, name, svc] of compose.matchAll(DB_PASSWORD)) {
    if (roles.some((r) => r.name === name)) continue;
    env.set(name, random());
    generated.push(name);
    roles.push({ role: `svc_${svc.toLowerCase()}`, name });
  }
  for (const [name, value] of Object.entries(extra)) if (value) env.set(name, value);
  return { env, roles, generated, standIns };
}

/** One ALTER ROLE per rotated role; the values are hex, so the quoting is plain. */
export function rolesSql(env, roles) {
  return roles.map(({ role, name }) => `ALTER ROLE ${role} PASSWORD '${env.get(name)}';`).join('\n') + '\n';
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [envFile, sqlFile] = process.argv.slice(2);
  if (!envFile || !sqlFile) {
    console.error('usage: node tooling/infra/rehearsal-env.mjs <env-file> <roles-sql-file>');
    process.exit(2);
  }
  const { env, roles, generated, standIns } = rehearsalEnv({
    example: readFileSync(join(ROOT, '.env.example'), 'utf8'),
    compose: readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8'),
    extra: {
      INTAFACED_SANCTIONS_REGIONS: process.env.INTAFACED_SANCTIONS_REGIONS,
      INTAFACED_SANCTIONS_LIST_SOURCE: process.env.INTAFACED_SANCTIONS_LIST_SOURCE,
    },
  });
  // Actions masks a registered value wherever it would appear later in this job's public log.
  if (process.env.GITHUB_ACTIONS === 'true') for (const name of generated) console.log(`::add-mask::${env.get(name)}`);
  writeFileSync(envFile, [...env].map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  writeFileSync(sqlFile, rolesSql(env, roles), { mode: 0o600 });
  console.log(
    `posture: ${Object.entries(POSTURE)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`,
  );
  console.log(`fresh random values (names only): ${generated.join(' ')}`);
  console.log(`TEST stand-ins for blank owner values (a hosted stack needs the owner's): ${standIns.join(' ') || 'none'}`);
  console.log(`roles rotated: ${roles.map((r) => r.role).join(' ')}`);
}
