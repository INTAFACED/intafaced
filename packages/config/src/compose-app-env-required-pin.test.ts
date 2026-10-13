/**
 * Unit card — real-deploy compose has NO default APP_ENV (#4610)
 *
 * 1. Promise: a host that forgets APP_ENV cannot become an explicit `dev`.
 *    `docker-compose.apps.yml` (the staging/prod unit) refuses to start
 *    instead, so the local-test guard (`isExplicitDevOrTest`, #4606) never
 *    sees a `dev` nobody chose.
 * 2. Break: `APP_ENV: ${APP_ENV:-dev}` (or any `:-` / `-` default) turns an
 *    unset variable into an explicit `dev` and waves fake sanctions lists,
 *    `local-test:` approvals and screening `off` through.
 * 3. Done bar: every APP_ENV assignment in docker-compose.apps.yml is
 *    `${APP_ENV:?...}`; docker-compose.yml and docker-compose.outreach.yml
 *    never set APP_ENV at all (infra-only / overlay); staging-deploy.yml
 *    passes APP_ENV to every remote `docker compose` call.
 * 4. Class N
 * 5. Paths: docker-compose*.yml, .github/workflows/staging-deploy.yml
 * 6. RED: pin fails on any APP_ENV default, or on a file that gains one.
 * 7. Collision: staging fail-closed value is pinned by staging-deploy.yml
 *    itself; this pin only covers the compose side.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const ASSIGNMENT = /^\s*APP_ENV:\s*(.*)$/gm;
const REQUIRED = /^\$\{APP_ENV:\?[^}]+\}$/;

describe('compose APP_ENV has no default in real-deploy files (#4610)', () => {
  const apps = read('docker-compose.apps.yml');
  const values = [...apps.matchAll(ASSIGNMENT)].map((m) => (m[1] ?? '').trim());

  it('docker-compose.apps.yml sets APP_ENV on the shared anchor and on admin', () => {
    expect(values).toHaveLength(2);
  });

  it('every APP_ENV assignment is ${APP_ENV:?message} — refuses to start when unset', () => {
    for (const value of values) expect(value).toMatch(REQUIRED);
  });

  it('no APP_ENV default of any shape (:- or -) anywhere in the file', () => {
    expect(apps).not.toMatch(/\$\{APP_ENV:?-/);
    expect(apps).not.toMatch(/APP_ENV:\s*['"]?(dev|test|staging|prod)\b/);
  });

  it('infra-only and overlay compose files never set APP_ENV', () => {
    for (const file of ['docker-compose.yml', 'docker-compose.outreach.yml']) {
      expect(read(file), `${file} must not set APP_ENV`).not.toMatch(/\bAPP_ENV\b/);
    }
  });

  it('staging-deploy.yml passes APP_ENV into every remote docker compose call', () => {
    const wf = read('.github/workflows/staging-deploy.yml');
    expect(wf).toMatch(/APP_ENV=staging docker compose -f docker-compose\.apps\.yml up -d/);
    // the post-deploy health step runs `compose ps`, which also needs APP_ENV
    expect(wf).toMatch(
      /"APP_ENV='\$APP_ENV' bash -s"[^\n]*<<'REMOTE'\n\s+set -euo pipefail\n\s+cd "\$HOME\/intafaced-staging"\n\n\s+report\(\)/,
    );
  });

  it('.env.example keeps the local-dev convenience (APP_ENV=dev) for platform:up', () => {
    expect(read('.env.example')).toMatch(/^APP_ENV=dev$/m);
  });
});
