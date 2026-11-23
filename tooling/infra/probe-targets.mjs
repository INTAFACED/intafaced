#!/usr/bin/env node
/**
 * The hosted beta's health probes (#10250), written from docker-compose.apps.yml so no service can be left out.
 *
 * Prometheus scrapes /metrics from only a few processes, so `ServiceDown` once saw nothing of every other service. Now
 * the blackbox exporter (docker-compose.yml, profile `beta`) asks each service with a compose healthcheck the same
 * question its healthcheck asks, from outside the container, and prometheus.yaml's `app-health` job reads its targets
 * from probe-targets.json, which this file writes. The services come from `docker compose config`, the resolved file
 * (anchors, merges and the infra file it includes), never a hand-kept list. A healthcheck this file cannot translate
 * refuses by service name, so a new kind of check is translated here before it can land unprobed.
 *
 * Usage (from the repo root): node tooling/infra/probe-targets.mjs           write probe-targets.json
 *                             node tooling/infra/probe-targets.mjs --check   fail if it is stale
 * Its test: probe-targets.test.mjs.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INFRA = import.meta.dirname;
const ROOT = join(INFRA, '..', '..');
export const OUT = join(INFRA, 'probe-targets.json');

/**
 * The resolved compose file, every profile, read the same on every machine: no `.env` and none of the caller's
 * variables. A variable with a default keeps it; one with none (`${X:?why}`) gets a placeholder (a path, since some are bind mounts), so compose resolves
 * without a secret. Not `--no-interpolate`: some compose versions then refuse a `${A:-/x}:${A:-/x}` volume. No port or
 * healthcheck is a variable, so no placeholder reaches the probe list (probeOf refuses a port that isn't a number).
 */
export function composeConfig(file = join(ROOT, 'docker-compose.apps.yml')) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  for (const k of ['DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT']) if (process.env[k]) env[k] = process.env[k];
  for (const f of [file, join(ROOT, 'docker-compose.yml')]) {
    for (const [, name, op] of readFileSync(f, 'utf8').matchAll(/\$\{(\w+)(:?[-?+])?/g)) {
      if (op !== '-' && op !== ':-') env[name] = '/probe-targets-placeholder';
    }
  }
  const json = execFileSync('docker', ['compose', '-f', file, '--env-file', '/dev/null', '--profile', '*', 'config', '--format', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  return JSON.parse(json);
}

/** A loopback URL in a healthcheck, as its sibling containers reach it: the service's compose name, not 127.0.0.1. */
function urlFor(service, cmd) {
  const m = /\bhttps?:\/\/(?:127\.0\.0\.1|localhost)(?::(\d+))?(\/[^\s'"|>]*)?/.exec(cmd);
  if (!m) return null;
  return `http://${service}:${m[1] ?? '80'}${m[2] ?? '/'}`;
}

/**
 * One probe for one service: what its healthcheck asks, asked from outside. `module` is a blackbox.yaml module.
 * Returns null for a service with no healthcheck, or one that starts only in a profile the beta does not run.
 */
export function probeOf(service, def) {
  const hc = def.healthcheck;
  if (!hc || hc.disable || !Array.isArray(hc.test) || hc.test[0] === 'NONE') return null;
  const profiles = def.profiles ?? [];
  if (profiles.length && !profiles.includes('beta')) return null;
  const cmd = hc.test.slice(1).join(' ');
  const env = def.environment ?? {};
  // tooling/infra/healthcheck.mjs: the port and path it reads, in its order.
  if (/\btooling\/infra\/healthcheck\.mjs\b/.test(cmd)) {
    const port = env.HEALTHCHECK_PORT ?? env.HTTP_PORT ?? env.PORT ?? '3000';
    const path = env.HEALTHCHECK_PATH ?? '/health';
    if (!/^\d+$/.test(String(port)))
      throw new Error(`${service}: healthcheck.mjs port is ${port}, not a number: translate it in probe-targets.mjs`);
    return { service, module: 'http_2xx', target: `http://${service}:${port}${path}` };
  }
  // An EVM node's check asks for the block number over JSON-RPC, which is a POST.
  if (/\bcast block-number\b/.test(cmd)) {
    const url = urlFor(service, cmd);
    if (url) return { service, module: 'evm_rpc', target: url };
  }
  if (/\bpg_isready\b/.test(cmd)) return { service, module: 'tcp_connect', target: `${service}:5432` };
  if (/\bredis-cli\b.*\bping\b/.test(cmd)) return { service, module: 'tcp_connect', target: `${service}:6379` };
  if (/\b(?:curl|wget)\b/.test(cmd)) {
    const url = urlFor(service, cmd);
    if (url) return { service, module: 'http_2xx', target: url };
  }
  throw new Error(`${service}: its healthcheck (${hc.test.join(' ')}) has no probe: translate it in tooling/infra/probe-targets.mjs`);
}

/** Prometheus file_sd groups, one per service, sorted by name. `__param_module` picks the blackbox module. */
export function targetsOf(config) {
  const probes = Object.entries(config.services ?? {})
    .map(([name, def]) => probeOf(name, def))
    .filter(Boolean)
    .sort((a, b) => a.service.localeCompare(b.service));
  if (probes.length === 0) throw new Error('no service with a healthcheck was found: refusing to write an empty probe list');
  return probes.map((p) => ({ targets: [p.target], labels: { service: p.service, __param_module: p.module } }));
}

/** The file's text, in the shape prettier keeps: one group per service, its target and labels on one line each. */
export const render = (config) =>
  `[\n${targetsOf(config)
    .map(
      (g) =>
        `  {\n    "targets": ${JSON.stringify(g.targets)},\n    "labels": ${JSON.stringify(g.labels)
          .replace(/^\{(.*)\}$/, '{ $1 }')
          .replaceAll('":', '": ')
          .replaceAll(',"', ', "')}\n  }`,
    )
    .join(',\n')}\n]\n`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = render(composeConfig());
  if (process.argv.includes('--check')) {
    if (readFileSync(OUT, 'utf8') !== text) {
      console.error('tooling/infra/probe-targets.json is stale: run node tooling/infra/probe-targets.mjs');
      process.exit(1);
    }
  } else {
    writeFileSync(OUT, text);
  }
}
