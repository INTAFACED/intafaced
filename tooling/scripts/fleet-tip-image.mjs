#!/usr/bin/env node
/**
 * D26-P2-04 — fleet tip-image law (executable).
 *
 * Local `pnpm platform:up` must build from this tree. Staging must tag a
 * GHCR digest onto the unqualified compose name and `up --no-build` so Hub
 * namesquatting and host-disk rebuilds cannot become the fleet.
 *
 *   pnpm fleet:tip-images
 *   node tooling/scripts/fleet-tip-image.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

function read(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

function fail(msg) {
  console.error(`✖ fleet-tip-image: ${msg}`);
  process.exitCode = 1;
}

const pkgRaw = read('package.json');
if (!pkgRaw) {
  fail('package.json missing');
  process.exit(1);
}
const pkg = JSON.parse(pkgRaw);
const up = pkg.scripts?.['platform:up'] ?? '';
const reset = pkg.scripts?.['platform:reset'] ?? '';

if (up !== 'docker compose -f docker-compose.apps.yml up -d --build') {
  fail(
    `platform:up must be exactly "docker compose -f docker-compose.apps.yml up -d --build" (got ${JSON.stringify(up)}). Local fleet without --build is yesterday's image.`,
  );
}
if (!reset.includes('docker compose -f docker-compose.apps.yml up -d --build')) {
  fail('platform:reset must rebuild (--build) after down -v — otherwise reset leaves a mixed-generation fleet.');
}
if (/\bup\b/.test(up) && /--no-build/.test(up)) {
  fail('platform:up must not pass --no-build; that flag is the staging digest path, not the laptop path.');
}

const compose = read('docker-compose.apps.yml');
if (!compose) {
  fail('docker-compose.apps.yml missing — that file is the fleet unit (staging ADR).');
} else {
  if (!/^ {2}image: intafaced\/app:dev\s*$/m.test(compose) && !/^  image: intafaced\/app:dev\s*$/m.test(compose)) {
    fail(
      'docker-compose.apps.yml must name image: intafaced/app:dev (unqualified). Changing the name without updating the staging tag step re-opens Hub namesquatting.',
    );
  }
  if (!/dockerfile:\s*Dockerfile/.test(compose)) {
    fail('compose must build the shared app image from the repo-root Dockerfile — do not invent a second runtime Dockerfile.');
  }
  if (!/image: intafaced\/vendor-shell:dev/.test(compose)) {
    fail('vendor-shell must keep image: intafaced/vendor-shell:dev (same namesquat shape; staging tags this too).');
  }
}

const dockerfile = read('Dockerfile');
if (!dockerfile) {
  fail('root Dockerfile missing — one image for the platform; do not split into thirteen.');
} else if (!/FROM node:22-bookworm-slim AS base/.test(dockerfile)) {
  fail('root Dockerfile base stage missing — this is the fleet runtime, not a new kit.');
}

const staging = read('.github/workflows/staging-deploy.yml');
if (!staging) {
  fail('staging-deploy.yml missing — digest→tag→inspect→up --no-build is the remote law.');
} else {
  if (!/docker tag[\s\S]{0,80}intafaced\/app:dev/.test(staging)) {
    fail('staging-deploy.yml must docker tag the pulled digest to intafaced/app:dev so compose never Hub-pulls.');
  }
  if (!/docker compose -f docker-compose\.apps\.yml up -d --no-build/.test(staging)) {
    fail('staging remote up must be --no-build after digest tag — --build on the host replaces reviewed bytes.');
  }
  if (/APP_ENV=staging docker compose -f docker-compose\.apps\.yml up -d --build/.test(staging)) {
    fail('staging must not up --build; that is the local path.');
  }
}

const threat = read('docs/THREAT-MODEL-STAGING-DEPLOY.md');
if (!threat || !/namesquat/i.test(threat) || !/intafaced\/app:dev/.test(threat)) {
  fail('docs/THREAT-MODEL-STAGING-DEPLOY.md must keep the unqualified-name / namesquatting section.');
}

const adr = read('docs/adr/2026-08-08-staging-deploy-path.md');
if (!adr || !/Consume the existing Docker unit/.test(adr)) {
  fail('staging ADR must keep “Consume the existing Docker unit” — D26-P2-04 does not invent a second image strategy.');
}

const runbook = read('docs/runbooks/FLEET-TIP-IMAGES.md');
if (!runbook || !/D26-P2-04/.test(runbook) || !/pnpm platform:up/.test(runbook)) {
  fail('docs/runbooks/FLEET-TIP-IMAGES.md must exist and name D26-P2-04 + platform:up.');
}

if (process.exitCode) {
  console.error('  D26-P2-04 fleet tip-image law is broken. Do not add a second compose/image kit to paper over it.');
  process.exit(process.exitCode);
}

console.log('✓ fleet-tip-image — local platform:up --build; compose intafaced/app:dev; staging digest-tag + up --no-build');
process.exit(0);
