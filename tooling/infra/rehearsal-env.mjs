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

const LINE = /^([A-Z][A-Z0-9_]*)=(.*)$/;
const DB_PASSWORD = /\$\{(SVC_([A-Z_]+)_DB_PASSWORD):-/g;

/**
 * @param {{ example: string, compose: string, random?: () => string, extra?: Record<string, string | undefined> }} input
 * @returns {{ env: Map<string, string>, roles: { role: string, name: string }[], generated: string[] }}
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
  for (const [name, value] of Object.entries(POSTURE)) env.set(name, value);
  const roles = [];
  for (const [, name, svc] of compose.matchAll(DB_PASSWORD)) {
    if (roles.some((r) => r.name === name)) continue;
    env.set(name, random());
    generated.push(name);
    roles.push({ role: `svc_${svc.toLowerCase()}`, name });
  }
  for (const [name, value] of Object.entries(extra)) if (value) env.set(name, value);
  return { env, roles, generated };
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
  const { env, roles, generated } = rehearsalEnv({
    example: readFileSync(join(ROOT, '.env.example'), 'utf8'),
    compose: readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8'),
    extra: {
      INTAFACED_SANCTIONS_REGIONS: process.env.INTAFACED_SANCTIONS_REGIONS,
      INTAFACED_SANCTIONS_LIST_SOURCE: process.env.INTAFACED_SANCTIONS_LIST_SOURCE,
    },
  });
  writeFileSync(envFile, [...env].map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  writeFileSync(sqlFile, rolesSql(env, roles), { mode: 0o600 });
  console.log(
    `posture: ${Object.entries(POSTURE)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`,
  );
  console.log(`fresh random values (names only): ${generated.join(' ')}`);
  console.log(`roles rotated: ${roles.map((r) => r.role).join(' ')}`);
}
