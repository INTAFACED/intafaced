/**
 * The beta's health probes (#10250): every app service with a compose healthcheck is probed, the list cannot go stale,
 * the probes really tell a live service from a dead one, and a failed probe fires `ServiceDown`.
 *
 * In Docker, with the images docker-compose.yml runs (prom/blackbox-exporter, prom/prometheus for promtool):
 *  - probe-targets.json is what probe-targets.mjs writes from `docker compose config` today;
 *  - a new service with a healthcheck is probed, one in a profile the beta does not run is not, and a healthcheck the
 *    generator cannot translate refuses by the service's name;
 *  - Prometheus reads that file and the compose file mounts it, and the exporter runs in profile `beta`;
 *  - each blackbox.yaml module, run by the pinned exporter, passes a live target and fails a dead one;
 *  - the alert rules' unit tests fail when `ServiceDown` stops reading the probes.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { composeConfig, render, targetsOf, OUT } from './probe-targets.mjs';

const INFRA = import.meta.dirname;
const COMPOSE = readFileSync(join(INFRA, '..', '..', 'docker-compose.yml'), 'utf8');
const imageOf = (service) => {
  const m = new RegExp(`^  ${service}:\\n(?:    .*\\n)*?    image: (\\S+)`, 'm').exec(COMPOSE);
  assert.ok(m, `docker-compose.yml has no image for ${service}`);
  return m[1];
};
const blockOf = (service) => {
  const m = new RegExp(`^  ${service}:\\n((?:    .*\\n|\\s*\\n)*)`, 'm').exec(COMPOSE);
  assert.ok(m, `docker-compose.yml has no ${service} service`);
  return m[1];
};
const run = (args) => spawnSync('docker', args, { encoding: 'utf8' });
const containers = [];
const dirs = [];
after(() => {
  for (const id of containers) run(['rm', '-f', id]);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tempDir = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(d, 0o755); // the images run as `nobody`
  dirs.push(d);
  return d;
};

test('probe-targets.json is what docker-compose.apps.yml gives today, and holds every service with a healthcheck', () => {
  const config = composeConfig();
  assert.equal(readFileSync(OUT, 'utf8'), render(config), 'stale: run node tooling/infra/probe-targets.mjs');
  const probed = new Set(targetsOf(config).map((g) => g.labels.service));
  const withHealthcheck = Object.entries(config.services)
    .filter(([, d]) => d.healthcheck && !(d.profiles ?? []).some((p) => p !== 'beta'))
    .map(([n]) => n);
  assert.ok(withHealthcheck.length >= 30, `only ${withHealthcheck.length} services with a healthcheck were read`);
  assert.deepEqual([...probed].sort(), withHealthcheck.sort());
  // The ones #10250 names: services no scrape job sees.
  for (const s of ['svc-bank', 'svc-pay', 'svc-identity', 'postgres', 'redis']) assert.ok(probed.has(s), `${s} is not probed`);
});

test('a new service with a healthcheck is probed; one outside the beta is not; an unknown check refuses by name', () => {
  const node = { test: ['CMD', 'node', '/app/tooling/infra/healthcheck.mjs'] };
  const services = {
    'svc-new': { healthcheck: node, environment: { HTTP_PORT: '4099' } },
    'svc-next': { healthcheck: node, environment: { HEALTHCHECK_PORT: '3200', HEALTHCHECK_PATH: '/', HTTP_PORT: '1' } },
    'svc-curl': { healthcheck: { test: ['CMD', 'curl', '-fsS', 'http://127.0.0.1:4098/health'] } },
    'svc-beta': { profiles: ['beta'], healthcheck: node, environment: { HTTP_PORT: '4097' } },
    'svc-fix': { profiles: ['fix'], healthcheck: node, environment: { HTTP_PORT: '4096' } },
    'svc-off': { healthcheck: { disable: true, test: ['NONE'] } },
    'no-check': {},
  };
  assert.deepEqual(targetsOf({ services }), [
    { targets: ['http://svc-beta:4097/health'], labels: { service: 'svc-beta', __param_module: 'http_2xx' } },
    { targets: ['http://svc-curl:4098/health'], labels: { service: 'svc-curl', __param_module: 'http_2xx' } },
    { targets: ['http://svc-new:4099/health'], labels: { service: 'svc-new', __param_module: 'http_2xx' } },
    { targets: ['http://svc-next:3200/'], labels: { service: 'svc-next', __param_module: 'http_2xx' } },
  ]);
  assert.throws(
    () => targetsOf({ services: { 'svc-odd': { healthcheck: { test: ['CMD', '/bin/check-me'] } } } }),
    /svc-odd: its healthcheck \(CMD \/bin\/check-me\) has no probe: translate it in tooling\/infra\/probe-targets\.mjs/,
  );
  assert.throws(() => targetsOf({ services: { 'no-check': {} } }), /refusing to write an empty probe list/);
});

test('Prometheus reads the probe list, the compose file mounts it, and the exporter runs in profile beta', () => {
  const prom = readFileSync(join(INFRA, 'prometheus.yaml'), 'utf8');
  const job = prom.slice(prom.indexOf('- job_name: app-health'));
  assert.match(job, /files: \['probe-targets\.json'\]/);
  assert.match(job, /replacement: blackbox-exporter:9115/);
  assert.match(blockOf('prometheus'), /- \.\/tooling\/infra\/probe-targets\.json:\/etc\/prometheus\/probe-targets\.json:ro/);
  const bb = blockOf('blackbox-exporter');
  assert.match(bb, /profiles: \['beta'\]/);
  assert.match(bb, /- \.\/tooling\/infra\/blackbox\.yaml:\/etc\/blackbox\/blackbox\.yaml:ro/);
  assert.doesNotMatch(bb, /ports:/);
});

test('each probe module passes a live target and fails a dead one, in the pinned exporter', () => {
  // One container: busybox httpd stands in for the services (CGI answers), beside the exporter with blackbox.yaml.
  const www = tempDir('probe-www-');
  mkdirSync(join(www, 'cgi-bin'));
  const cgi = (name, status, body) => {
    const f = join(www, 'cgi-bin', name);
    writeFileSync(f, `#!/bin/sh\nprintf 'Status: ${status}\\r\\nContent-Type: application/json\\r\\n\\r\\n%s' '${body}'\n`);
    chmodSync(f, 0o755);
  };
  cgi('health', '200 OK', '{"status":"ok"}');
  cgi('sick', '503 Service Unavailable', '{"status":"down"}');
  cgi('rpc', '200 OK', '{"jsonrpc":"2.0","id":1,"result":"0x1"}');
  cgi('rpc-error', '200 OK', '{"jsonrpc":"2.0","id":1,"error":{"code":-32601}}');
  const id = execFileSync(
    'docker',
    [
      'run',
      '-d',
      '--name',
      `probe-test-${randomBytes(4).toString('hex')}`,
      '-v',
      `${join(INFRA, 'blackbox.yaml')}:/etc/blackbox/blackbox.yaml:ro`,
      '-v',
      `${www}:/www:ro`,
      '--entrypoint',
      'sh',
      imageOf('blackbox-exporter'),
      '-c',
      'httpd -p 8545 -h /www && exec blackbox_exporter --config.file=/etc/blackbox/blackbox.yaml',
    ],
    { encoding: 'utf8' },
  ).trim();
  containers.push(id);
  const ready = run([
    'exec',
    id,
    'sh',
    '-c',
    'for i in $(seq 60); do wget -qO- http://127.0.0.1:9115/-/healthy >/dev/null 2>&1 && exit 0; sleep 0.5; done; exit 1',
  ]);
  assert.equal(ready.status, 0, run(['logs', id]).stderr);
  const probe = (module, target) => {
    const r = run(['exec', id, 'wget', '-qO-', `http://127.0.0.1:9115/probe?module=${module}&target=${encodeURIComponent(target)}`]);
    assert.equal(r.status, 0, r.stderr);
    const m = /^probe_success (\d)$/m.exec(r.stdout);
    assert.ok(m, r.stdout);
    return Number(m[1]);
  };
  assert.equal(probe('http_2xx', 'http://127.0.0.1:8545/cgi-bin/health'), 1);
  assert.equal(probe('http_2xx', 'http://127.0.0.1:8545/cgi-bin/sick'), 0);
  assert.equal(probe('http_2xx', 'http://127.0.0.1:1/health'), 0);
  assert.equal(probe('tcp_connect', '127.0.0.1:8545'), 1);
  assert.equal(probe('tcp_connect', '127.0.0.1:1'), 0);
  assert.equal(probe('evm_rpc', 'http://127.0.0.1:8545/cgi-bin/rpc'), 1);
  assert.equal(probe('evm_rpc', 'http://127.0.0.1:8545/cgi-bin/rpc-error'), 0);
});

const promtool = (dir, args) =>
  run(['run', '--rm', '--entrypoint', 'promtool', '-v', `${dir}:/cfg:ro`, '-w', '/cfg', imageOf('prometheus'), ...args]);

test('the rule tests fail on a planted fault: ServiceDown no longer reading the probes', () => {
  const dir = tempDir('alerts-probe-planted-');
  copyFileSync(join(INFRA, 'prometheus-alerts.test.yaml'), join(dir, 'prometheus-alerts.test.yaml'));
  const rules = readFileSync(join(INFRA, 'prometheus-alerts.yaml'), 'utf8');
  const planted = rules.replace(/(expr: up\{job!~"prometheus\|app-health"\} == 0) or probe_success\{job="app-health"\} == 0\n/, '$1\n');
  assert.notEqual(planted, rules, 'the plant did not apply');
  writeFileSync(join(dir, 'prometheus-alerts.yaml'), planted);
  const r = promtool(dir, ['test', 'rules', 'prometheus-alerts.test.yaml']);
  assert.notEqual(r.status, 0, 'promtool passed a planted fault');
  assert.match(r.stdout + r.stderr, /svc-bank is down/);
});
