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
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const wf = readFileSync(resolve(ROOT, '.github/workflows/staging-deploy.yml'), 'utf8');

// The heredoc body of a step: the script that actually runs on the host.
const remoteScript = (step: string): string => {
  const start = wf.indexOf(`- name: ${step}`);
  expect(start, `step "${step}" missing`).toBeGreaterThan(-1);
  const open = wf.indexOf("<<'REMOTE'\n", start);
  const close = wf.indexOf('\n          REMOTE\n', open);
  expect(open).toBeGreaterThan(start);
  expect(close).toBeGreaterThan(open);
  return wf.slice(open, close);
};

// The `run: |` body of a step, as the runner's bash receives it (its 10-space indent removed).
const runScript = (step: string): string => {
  const start = wf.indexOf(`- name: ${step}\n`);
  expect(start, `step "${step}" missing`).toBeGreaterThan(-1);
  const lines = wf.slice(wf.indexOf('run: |\n', start) + 'run: |\n'.length).split('\n');
  const body: string[] = [];
  for (const line of lines) {
    if (line.trim() !== '' && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
};

const bash = (script: string, env: Record<string, string>) =>
  spawnSync('bash', ['-c', script], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });

describe('staging deploy fails closed by name (#10210)', () => {
  const SECRETS = ['STAGING_SSH_HOST', 'STAGING_SSH_USER', 'STAGING_SSH_PRIVATE_KEY', 'STAGING_SSH_KNOWN_HOSTS'];

  it('stays dispatch-only, behind the staging environment', () => {
    const on = wf.slice(wf.indexOf('\non:\n') + 1, wf.indexOf('\npermissions: {}'));
    expect(on).toMatch(/^on:\n  workflow_dispatch:\n/);
    expect(on).not.toMatch(/^\s{2}(push|schedule|pull_request|pull_request_target|repository_dispatch|workflow_run):/m);
    expect(wf).toMatch(/^    environment: staging$/m);
  });

  it('with no host secrets set, the secrets step exits 1 naming each missing one', () => {
    const run = bash(runScript('Required secrets are present'), Object.fromEntries(SECRETS.map((n) => [n, ''])));
    expect(run.status).toBe(1);
    for (const name of SECRETS) {
      expect(run.stdout).toContain(`::error::required environment secret ${name} is not set on the staging environment`);
    }
  });

  it('names only the secret that is missing, and passes with all four set', () => {
    const set = Object.fromEntries(SECRETS.map((n) => [n, 'x']));
    const one = bash(runScript('Required secrets are present'), { ...set, STAGING_SSH_KNOWN_HOSTS: '' });
    expect(one.status).toBe(1);
    expect(one.stdout).toContain('STAGING_SSH_KNOWN_HOSTS is not set');
    expect(one.stdout).not.toContain('STAGING_SSH_HOST is not set');
    expect(bash(runScript('Required secrets are present'), set).status).toBe(0);
  });

  it('the secrets step runs before any step that reaches the host', () => {
    const secrets = wf.indexOf('- name: Required secrets are present');
    for (const step of ['Configure the ssh transport', 'Send the deployment unit', 'Pull, verify and start']) {
      expect(wf.indexOf(`- name: ${step}`), step).toBeGreaterThan(secrets);
    }
  });
});

describe('staging deploy beta posture', () => {
  it('posture is a choice of beta or staging, beta by default, and anything else stops the run', () => {
    expect(wf).toMatch(
      /      posture:\n[^\n]*\n        required: true\n        default: beta\n        type: choice\n        options:\n          - beta\n          - staging\n/,
    );
    const check = runScript('Posture is beta or staging');
    expect(bash(check, { POSTURE: 'beta' }).status).toBe(0);
    expect(bash(check, { POSTURE: 'staging' }).status).toBe(0);
    const bad = bash(check, { POSTURE: "beta'; id #" });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('::error::posture must be beta or staging');
  });

  it('the host-side start script sets the beta switch (or clears it) before compose up, still under APP_ENV=staging', () => {
    const remote = remoteScript('Pull, verify and start');
    const beta = remote.indexOf('beta) export INTAFACED_BETA_POSTURE=test-networks ;;');
    const plain = remote.indexOf('staging) export INTAFACED_BETA_POSTURE= ;;');
    const up = remote.indexOf('APP_ENV=staging docker compose -f docker-compose.apps.yml up -d');
    expect(beta).toBeGreaterThan(-1);
    expect(plain).toBeGreaterThan(-1);
    expect(up).toBeGreaterThan(beta);
    expect(up).toBeGreaterThan(plain);
    expect(wf).toContain(`"APP_ENV='$APP_ENV' POSTURE='$POSTURE' REPO='$repo'`);
  });
});

describe('staging deploy body-bind posture', () => {
  it('the host-side start script exports INTERNAL_SERVICE_BODY_BIND=require before compose up', () => {
    const remote = remoteScript('Pull, verify and start');
    const exp = remote.indexOf('export INTERNAL_SERVICE_BODY_BIND=require');
    const up = remote.indexOf('APP_ENV=staging docker compose -f docker-compose.apps.yml up -d');
    expect(exp).toBeGreaterThan(-1);
    expect(up).toBeGreaterThan(exp);
  });

  it('health step fails a crash loop at 3+ restarts, but only after the OK arms', () => {
    const remote = remoteScript('Every container is healthy');
    expect(remote).toContain('restarts={{.RestartCount}}');
    const loop = remote.indexOf(`*' restarts='[3-9]' '*|*' restarts='[1-9][0-9]*) broken=`);
    expect(loop).toBeGreaterThan(-1);
    // RestartCount is lifetime: a healthy container compose left untouched may carry old restarts
    for (const ok of [
      `*' status=running '*' health=healthy') ;;`,
      `*' status=running '*' health=none') ;;`,
      `*' status=exited exit=0 '*) ;;`,
    ]) {
      const at = remote.indexOf(ok);
      expect(at, ok).toBeGreaterThan(-1);
      expect(at, `${ok} must come before the restarts arm`).toBeLessThan(loop);
    }
    expect(loop).toBeLessThan(remote.indexOf(`*' health=starting') pending=1 ;;`));
  });

  it('never prints container logs into the public job log', () => {
    const code = wf
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(code).not.toMatch(/\bdocker\b[^\n]*\blogs\b/);
  });
});
