/**
 * Unit card — staging deploy forces INTERNAL_SERVICE_BODY_BIND=require
 *
 * 1. Promise: a staging host whose `.env` lacks INTERNAL_SERVICE_BODY_BIND
 *    still boots. APP_ENV=staging is production posture, where every service
 *    holding INTERNAL_SERVICE_SECRET exits 1 unless the value is `require`
 *    (config.s2s_body_bind_not_required), and docker-compose.apps.yml
 *    defaults it to accept-both.
 * 2. Break: drop the export and the fleet crash-loops under
 *    `restart: unless-stopped` until the health step times out.
 * 3. Done bar: the remote start script exports the value before `up`, and
 *    the health step treats 3+ restarts as broken without printing logs.
 * 4. Class N
 * 5. Paths: .github/workflows/staging-deploy.yml
 * 6. RED: pin fails if the export moves after `up`, or the crash-loop arm
 *    or the restart count disappears.
 * 7. Collision: compose-app-env-required-pin.test.ts pins APP_ENV on the
 *    same remote calls.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const wf = readFileSync(resolve(ROOT, '.github/workflows/staging-deploy.yml'), 'utf8');

describe('staging deploy body-bind posture', () => {
  it('exports INTERNAL_SERVICE_BODY_BIND=require before compose up', () => {
    const exp = wf.indexOf('export INTERNAL_SERVICE_BODY_BIND=require');
    const up = wf.indexOf('APP_ENV=staging docker compose -f docker-compose.apps.yml up -d');
    expect(exp).toBeGreaterThan(-1);
    expect(up).toBeGreaterThan(exp);
  });

  it('health step fails a crash loop at 3+ restarts instead of waiting out the timeout', () => {
    expect(wf).toContain('restarts={{.RestartCount}}');
    expect(wf).toContain(`*' restarts='[3-9]' '*|*' restarts='[1-9][0-9]*) broken=`);
  });

  it('never prints container logs into the public job log', () => {
    expect(wf).not.toMatch(/^\s*docker (compose [^\n]*)?logs\b/m);
  });
});
