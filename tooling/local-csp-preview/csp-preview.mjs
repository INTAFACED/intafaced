#!/usr/bin/env node
// LOCAL CSP PREVIEW. Serves the production build of the customer app behind the SAME security headers / CSP the
// customer nginx image ships (apps/customer/nginx.conf + security-headers.conf.template + csp-origins.envsh), using
// the real nginx:1.30.5-alpine image and its real entrypoint (envsubst) to render the headers. Backend = TEST-data stub.
//
//   node tooling/local-csp-preview/csp-preview.mjs start    start the stub + two nginx containers, print the links
//   node tooling/local-csp-preview/csp-preview.mjs stop     stop exactly what `start` recorded (PIDs / container names)
//   node tooling/local-csp-preview/csp-preview.mjs status   what is running
//
// Ports (change with CSP_PREVIEW_BASE_PORT, default 18080): base = nginx with origins CONFIGURED, base+1 = nginx with
// every origin variable EMPTY (as shipped), base+2 = API stub, base+3 = CSP report sink, base+4 = LiveKit stand-in.
// It never touches any other port, process or database, and `stop` only kills the PID / containers it recorded.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const customer = join(repo, 'apps', 'customer');
const STATE = join(here, '.state');
const PIDFILE = join(STATE, 'pids.json');
const BASE = Number(process.env.CSP_PREVIEW_BASE_PORT ?? 18080);
const PORTS = { configured: BASE, bare: BASE + 1, api: BASE + 2, sink: BASE + 3, livekit: BASE + 4, academyConfigured: BASE + 5, academyBare: BASE + 6 };
const IMAGE = 'nginx:1.30.5-alpine'; // the tag apps/customer/Dockerfile uses for its runtime stage
// The production build hides the Academy (it is a hidden feature there), so two more copies serve the local-test-stack build
// (VITE_LOCAL_TEST=1: hidden rooms open under a ribbon) behind the same headers, to exercise Academy live sessions and video.
const RIBBON_DIST = join(STATE, 'dist-ribbon');
const INSTANCES = [
  { kind: 'configured', port: PORTS.configured, dist: join(customer, 'dist'), configured: true },
  { kind: 'bare', port: PORTS.bare, dist: join(customer, 'dist'), configured: false },
  { kind: 'academyConfigured', port: PORTS.academyConfigured, dist: RIBBON_DIST, configured: true },
  { kind: 'academyBare', port: PORTS.academyBare, dist: RIBBON_DIST, configured: false },
];
const nameOf = (i) => `csp-preview-customer-${i.port}`;
// The deploy-time variables for the "configured" instance. Test values: a local LiveKit stand-in and a fake storage host.
const CONFIGURED_ENV = {
  CUSTOMER_LIVEKIT_ORIGIN: `ws://127.0.0.1:${PORTS.livekit}`,
  CUSTOMER_STORAGE_ORIGIN: 'https://storage.csp-preview.invalid',
};

const say = (m) => process.stdout.write(m + '\n');
const fail = (m) => {
  process.stderr.write('csp-preview: ' + m + '\n');
  process.exit(1);
};
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const free = (port) =>
  new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => (s.destroy(), resolve(false)));
    s.once('error', () => resolve(true));
  });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const readPids = () => (existsSync(PIDFILE) ? JSON.parse(readFileSync(PIDFILE, 'utf8')) : null);

/** Generates everything the containers mount, from the repo's own files. Returns the mount arguments. */
export function prepare() {
  mkdirSync(STATE, { recursive: true });
  const template = readFileSync(join(customer, 'security-headers.conf.template'), 'utf8');
  const cspLine = template.split('\n').find((l) => l.startsWith('add_header Content-Security-Policy "'));
  if (!cspLine) throw new Error('security-headers.conf.template has no Content-Security-Policy line');
  // Second template: the SAME policy, report-only, with a report-uri. The enforced header stays untouched and byte-identical.
  const reportOnly = cspLine
    .replace('add_header Content-Security-Policy "', 'add_header Content-Security-Policy-Report-Only "')
    .replace(/" always;$/, '; report-uri /__csp-report" always;');
  writeFileSync(join(STATE, 'csp-report-only.conf.template'), `# Local preview only: duplicate of the CSP above in report-only mode so violations reach the local sink.\n${reportOnly}\n`);

  let conf = readFileSync(join(customer, 'nginx.conf'), 'utf8');
  const need = (needle) => {
    if (!conf.includes(needle)) throw new Error(`apps/customer/nginx.conf no longer contains "${needle}"; update csp-preview.mjs`);
  };
  need('proxy_pass http://svc-edge:4000;');
  need('proxy_pass http://svc-ws:4014/;');
  need('location ^~ /assets/ {');
  conf = conf
    .replaceAll('proxy_pass http://svc-edge:4000;', `proxy_pass http://host.docker.internal:${PORTS.api};`)
    .replaceAll('proxy_pass http://svc-ws:4014/;', `proxy_pass http://host.docker.internal:${PORTS.api}/;`)
    // every place the repo includes the enforced snippet also gets the report-only duplicate
    .replaceAll(
      'include /etc/nginx/snippets/security-headers.conf;',
      'include /etc/nginx/snippets/security-headers.conf;\n    include /etc/nginx/snippets/csp-report-only.conf;',
    )
    .replace(
      'location ^~ /assets/ {',
      `# --- local preview additions (not in the shipped nginx.conf) ---
    location = /__csp-report { proxy_pass http://host.docker.internal:${PORTS.sink}/__csp-report; }
    location = /__csp-preview/violations { proxy_pass http://host.docker.internal:${PORTS.sink}/violations; add_header Cache-Control "no-store" always; }
    location = /__csp-preview/clear { proxy_pass http://host.docker.internal:${PORTS.sink}/clear; }
    location ^~ /__csp-preview/ {
        alias /preview/checklist/;
        add_header Cache-Control "no-store" always;
        include /etc/nginx/snippets/security-headers.conf;
        include /etc/nginx/snippets/csp-report-only.conf;
    }
    # --- end local preview additions ---

    location ^~ /assets/ {`,
    );
  writeFileSync(join(STATE, 'nginx.conf'), conf);

  // The image entrypoint only sources .envsh files that are executable; the repo copy is not, so mount an identical copy.
  copyFileSync(join(customer, 'csp-origins.envsh'), join(STATE, '16-customer-csp-origins.envsh'));
  chmodSync(join(STATE, '16-customer-csp-origins.envsh'), 0o755);
  rmSync(join(STATE, 'checklist'), { recursive: true, force: true });
  cpSync(join(here, 'checklist'), join(STATE, 'checklist'), { recursive: true });
  return [
    ['-v', `${join(STATE, 'nginx.conf')}:/etc/nginx/conf.d/default.conf:ro`],
    ['-v', `${join(customer, 'security-headers.conf.template')}:/etc/nginx/templates/security-headers.conf.template:ro`],
    ['-v', `${join(STATE, 'csp-report-only.conf.template')}:/etc/nginx/templates/csp-report-only.conf.template:ro`],
    ['-v', `${join(customer, 'security-headers-api.conf')}:/etc/nginx/snippets/security-headers-api.conf:ro`],
    ['-v', `${join(STATE, '16-customer-csp-origins.envsh')}:/docker-entrypoint.d/16-customer-csp-origins.envsh:ro`],
    ['-v', `${join(STATE, 'checklist')}:/preview/checklist:ro`],
  ].flat();
}

async function start() {
  if (readPids() && (alive(readPids().stub) || run('docker', ['ps', '-q', '--filter', `name=csp-preview-customer-`]).stdout.trim()))
    fail('already running (see `status`); run `stop` first');
  const instances = INSTANCES.filter((i) => existsSync(join(i.dist, 'index.html')));
  for (const [name, port] of Object.entries(PORTS))
    if (!(await free(port))) fail(`port ${port} (${name}) is already in use by something else; set CSP_PREVIEW_BASE_PORT to another range`);
  if (!existsSync(join(customer, 'dist', 'index.html'))) fail('apps/customer/dist is missing. Build first: pnpm --filter @intafaced/customer build');
  const info = run('docker', ['info', '--format', '{{.ServerVersion}}']);
  if (info.status !== 0) fail('Docker is not running (docker info failed). Start Docker Desktop yourself, then retry.');
  if (run('docker', ['image', 'inspect', IMAGE]).status !== 0)
    fail(`image ${IMAGE} is not on this machine; pull it once (docker pull ${IMAGE}) or re-run with network access`);
  const mounts = prepare();

  mkdirSync(STATE, { recursive: true });
  const log = openSync(join(STATE, 'stub.log'), 'a');
  const stub = spawn(process.execPath, [join(here, 'stub.mjs')], {
    detached: true,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      CSP_PREVIEW_STATE: STATE,
      CSP_PREVIEW_API_PORT: String(PORTS.api),
      CSP_PREVIEW_SINK_PORT: String(PORTS.sink),
      CSP_PREVIEW_LIVEKIT_PORT: String(PORTS.livekit),
      CSP_PREVIEW_STORAGE_ORIGIN: CONFIGURED_ENV.CUSTOMER_STORAGE_ORIGIN,
    },
  });
  stub.unref();
  const record = { stub: stub.pid, containers: [], startedAt: new Date().toISOString(), ports: PORTS };
  writeFileSync(PIDFILE, JSON.stringify(record, null, 2));

  for (const inst of instances) {
    const kind = inst.kind;
    const envArgs = Object.entries(inst.configured ? CONFIGURED_ENV : {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const out = run('docker', [
      'run', '-d', '--rm', '--name', nameOf(inst), '--label', 'csp-preview=1',
      '--add-host', 'host.docker.internal:host-gateway',
      '-p', `127.0.0.1:${inst.port}:80`,
      '-e', 'NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx/snippets', '-e', 'NGINX_ENVSUBST_FILTER=^CUSTOMER_CSP_',
      '-v', `${inst.dist}:/usr/share/nginx/html:ro`,
      ...envArgs, ...mounts, IMAGE,
    ]);
    if (out.status !== 0) {
      await stop(true);
      fail(`docker run (${kind}) failed: ${out.stderr.trim()}`);
    }
    record.containers.push({ name: nameOf(inst), id: out.stdout.trim().slice(0, 12), kind, port: inst.port });
    writeFileSync(PIDFILE, JSON.stringify(record, null, 2));
  }
  // wait for both to answer
  for (const inst of instances) {
    const port = inst.port;
    let ok = false;
    for (let i = 0; i < 40 && !ok; i++) {
      try {
        ok = (await fetch(`http://127.0.0.1:${port}/customer-deployment.json`)).ok;
      } catch {
        /* not up yet */
      }
      if (!ok) await new Promise((r) => setTimeout(r, 250));
    }
    if (!ok) {
      const logs = run('docker', ['logs', '--tail', '30', nameOf(inst)]);
      await stop(true);
      fail(`nginx on ${port} did not come up:\n${logs.stdout}${logs.stderr}`);
    }
  }
  say('');
  say('LOCAL CSP PREVIEW is running. Test data only; nothing real.');
  say(`  Start here (checklist + live violation list): http://localhost:${PORTS.configured}/__csp-preview/`);
  say(`  Customer app, origins configured:             http://localhost:${PORTS.configured}/login`);
  say(`  Customer app, origins EMPTY (as shipped):     http://localhost:${PORTS.bare}/login`);
  if (instances.length > 2) {
    say(`  Academy copy, origins configured (ribbon build): http://localhost:${PORTS.academyConfigured}/login`);
    say(`  Academy copy, origins EMPTY (ribbon build):      http://localhost:${PORTS.academyBare}/login`);
  } else say('  (no ribbon build found: Academy copies not started; build it, see LOCAL-CSP-PREVIEW.md)');
  say(`  Stub PID ${record.stub}; containers ${record.containers.map((c) => c.name).join(', ')}`);
  say('  Stop with: node tooling/local-csp-preview/csp-preview.mjs stop');
}

async function stop(quiet = false) {
  const rec = readPids();
  if (!rec) return quiet || say('nothing recorded; nothing to stop');
  for (const name of INSTANCES.map(nameOf)) {
    // only containers carrying our label are removed
    const mine = run('docker', ['ps', '-aq', '--filter', `name=^${name}$`, '--filter', 'label=csp-preview=1']).stdout.trim();
    if (mine) run('docker', ['rm', '-f', name]);
  }
  if (rec.stub && alive(rec.stub)) {
    const cmd = run('ps', ['-o', 'command=', '-p', String(rec.stub)]).stdout;
    if (cmd.includes('local-csp-preview/stub.mjs')) process.kill(rec.stub, 'SIGTERM');
    else say(`PID ${rec.stub} is no longer our stub (${cmd.trim()}); left alone`);
  }
  rmSync(PIDFILE, { force: true });
  if (!quiet) say('stopped: stub and both nginx containers');
}

function status() {
  const rec = readPids();
  if (!rec) return say('not running (no pid file)');
  say(`stub PID ${rec.stub}: ${alive(rec.stub) ? 'alive' : 'DEAD'}`);
  for (const c of rec.containers) {
    const up = run('docker', ['ps', '-q', '--filter', `name=^${c.name}$`]).stdout.trim();
    say(`container ${c.name} (port ${c.port}, ${c.kind}): ${up ? 'up' : 'DOWN'}`);
  }
  say(`started ${rec.startedAt}`);
}

const cmd = process.argv[2];
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (cmd === 'start') await start();
  else if (cmd === 'stop') await stop();
  else if (cmd === 'status') status();
  else fail('usage: csp-preview.mjs start | stop | status');
}
