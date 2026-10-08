/**
 * Unit card — compose stack passes usage window + upstream timeout into svc-agents
 *            + env refuse-closed for metering kill-switch and fee asset
 *
 * 1. Promise: AGENTS_USAGE_WINDOW_MINUTES and AGENTS_UPSTREAM_TIMEOUT_MS from
 *    host `.env` reach the container (env.ts already declares them).
 *    Blank window refuses — never 60. Owner explicit 60 is allowed.
 *    Unset AGENTS_METERING_ENABLED refuses `agents.metering_enabled_unset`.
 *    Unset AGENTS_FEE_ASSET_ID must refuse, never invent IFC.
 * 2. Break: compose `:-60` makes blank look published. env.ts `.default(60)`
 *    invents a bill window when the operator never set one. env.ts
 *    `bool.default(true)` / `.default('IFC')` bills and invents an owner asset
 *    when the operator never set them.
 * 3. Done bar: docker-compose.apps.yml svc-agents has
 *    AGENTS_USAGE_WINDOW_MINUTES: ${AGENTS_USAGE_WINDOW_MINUTES:?missing — copy .env.example to .env}
 *    AGENTS_UPSTREAM_TIMEOUT_MS: ${AGENTS_UPSTREAM_TIMEOUT_MS:-60000}
 *    env.ts AGENTS_USAGE_WINDOW_MINUTES has no .default(60)
 *    env.ts AGENTS_METERING_ENABLED unset/blank refuses agents.metering_enabled_unset
 *    env.ts AGENTS_FEE_ASSET_ID has no default('IFC')
 * 4. Class M (kill-switch + owner asset — no silent feeCharge / no invent IFC)
 * 5. Paths: docker-compose.apps.yml (svc-agents block only) + env.ts
 * 6. RED: pin fails if a unique key drops, window git-default 60 returns, timeout
 *    drifts from 60000, or metering / provider / fee / UPSTREAM urls are
 *    restamped; env.ts fail-open defaults return.
 * 7. Collision: academy-url-compose-pin.test.ts — this pin does not restamp
 *    ACADEMY_URL. Do not invent AGENTS_ROUTING_TABLE JSON.
 *    Compose metering is `:?missing` (never `:-true`). `:-IFC` stays this
 *    file's restamp guard (fee-asset compose fail-open is out of this PR).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function agentsServiceBlock(source: string): string {
  const match = source.match(/^  svc-agents:\n(?:.*\n)*?(?=^  [a-z]|\Z)/m);
  if (!match) throw new Error('svc-agents service block missing from docker-compose.apps.yml');
  return match[0];
}

const WINDOW = /^\s+AGENTS_USAGE_WINDOW_MINUTES:\s*\$\{AGENTS_USAGE_WINDOW_MINUTES:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const METERING = /^\s+AGENTS_METERING_ENABLED:\s*\$\{AGENTS_METERING_ENABLED:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const TIMEOUT = /^\s+AGENTS_UPSTREAM_TIMEOUT_MS:\s*\$\{AGENTS_UPSTREAM_TIMEOUT_MS:-60000\}\s*$/gm;

describe('compose usage window and upstream timeout for svc-agents', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const envTs = readFileSync(join(ROOT, 'services/svc-agents/src/env.ts'), 'utf8');
  const block = agentsServiceBlock(compose);

  it('env.ts still declares the flags this pin tracks, matching compose defaults', () => {
    expect(envTs).toMatch(/AGENTS_USAGE_WINDOW_MINUTES:\s*z\.coerce\s*\.number\(\)\s*\.int\(\)\s*\.min\(1\)\s*\.max\(1440\)/);
    expect(envTs).not.toMatch(/AGENTS_USAGE_WINDOW_MINUTES:\s*z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(1440\)\.default\(60\)/);
    expect(envTs).toMatch(/AGENTS_UPSTREAM_TIMEOUT_MS:\s*z\.coerce\.number\(\)\.int\(\)\.min\(1_000\)\.max\(600_000\)\.default\(60_000\)/);
  });

  it('env.ts refuses unset metering (agents.metering_enabled_unset) and unset fee asset (must not invent IFC)', () => {
    expect(envTs).not.toMatch(/AGENTS_METERING_ENABLED:\s*bool\.default\(true\)/);
    expect(envTs).toMatch(/AGENTS_METERING_ENABLED:\s*z\.preprocess\(/);
    expect(envTs).toMatch(/agents\.metering_enabled_unset/);
    expect(envTs).not.toMatch(/AGENTS_FEE_ASSET_ID:\s*z\.string\(\)\.default\('IFC'\)/);
    expect(envTs).toMatch(/AGENTS_FEE_ASSET_ID:\s*z\.string\(\)\.min\(1\)/);
    const feeDecl = envTs.slice(envTs.indexOf('AGENTS_FEE_ASSET_ID:'));
    expect(feeDecl.slice(0, 120)).not.toMatch(/\.default\(/);
  });

  it('compose svc-agents block passes unique keys once; window has no git-default 60; timeout 60000', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-agents/);
    expect(block.match(WINDOW)).toHaveLength(1);
    expect(block.match(TIMEOUT)).toHaveLength(1);

    const windowHits = compose.match(/^\s+AGENTS_USAGE_WINDOW_MINUTES:/gm) ?? [];
    const timeoutHits = compose.match(/^\s+AGENTS_UPSTREAM_TIMEOUT_MS:/gm) ?? [];
    expect(windowHits, 'AGENTS_USAGE_WINDOW_MINUTES must appear once').toHaveLength(1);
    expect(timeoutHits, 'AGENTS_UPSTREAM_TIMEOUT_MS must appear once').toHaveLength(1);
  });

  it('does not restamp metering / provider / fee / UPSTREAM urls or invent routing JSON', () => {
    expect(block).toMatch(/AGENTS_PROVIDER:\s*\$\{AGENTS_PROVIDER:-mock\}/);
    expect(block).toMatch(/AGENTS_FEE_ASSET_ID:\s*\$\{AGENTS_FEE_ASSET_ID:-IFC\}/);
    expect(block.match(METERING)).toHaveLength(1);
    expect(block).not.toMatch(/AGENTS_METERING_ENABLED:-true/);
    expect(block).toMatch(/^\s+AGENTS_UPSTREAM_BASE_URL:\s*$/m);
    expect(block).toMatch(/^\s+AGENTS_UPSTREAM_API_KEY:\s*$/m);
    expect(block).toMatch(/^\s+AGENTS_ROUTING_TABLE:\s*$/m);
    expect(block).not.toMatch(/AGENTS_ROUTING_TABLE:\s*\$\{AGENTS_ROUTING_TABLE:-\{/);
  });
});
