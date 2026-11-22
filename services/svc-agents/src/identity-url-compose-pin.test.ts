/**
 * Unit card — compose stack sets IDENTITY_URL for svc-agents affiliate producer
 *            + LEDGER_URL refuse-closed (no silent localhost feeCharge)
 *
 * 1. Promise: after usage feeCharge, accrue + payout can reach identity S2S.
 *    Metering posts only to an owner-set ledger — unset LEDGER_URL must refuse
 *    boot rather than invent http://localhost:4001.
 * 2. Break: compose boots agents without IDENTITY_URL → noop forever even
 *    though identity is on the same network. env.ts LEDGER_URL default
 *    localhost → createLedgerClient + feeCharge against a guessed book.
 * 3. Done bar: docker-compose.apps.yml svc-agents has
 *    IDENTITY_URL: http://svc-identity:4002
 *    LEDGER_URL: http://svc-ledger:4001
 *    env.ts IDENTITY_URL is optional URL with no localhost default
 *    (blank/unset → no navigator identity port). Live identity.session.read
 *    refuses `no_live_session` rather than using a caller fixture as live truth.
 *    env.ts LEDGER_URL is a required URL with no localhost default.
 * 4. Class M (producer wire + ledger URL — identity owns rates; no invent book)
 * 5. Paths: docker-compose.apps.yml (svc-agents block only) + env.ts + index.ts
 * 6. RED: pin fails if IDENTITY_URL / LEDGER_URL drops, env defaults localhost,
 *    or AGENTS_PROVIDER mock / AUTH_HEADER / JWT_* / key-no-value upstream
 *    lines are restamped. Do not default AGENTS_PROVIDER to upstream.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function agentsServiceBlock(source: string): string {
  return composeServiceBlock(source, 'svc-agents');
}

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

const IDENTITY = /^\s+IDENTITY_URL:\s*http:\/\/svc-identity:4002\s*$/gm;
const LEDGER = /^\s+LEDGER_URL:\s*http:\/\/svc-ledger:4001\s*$/gm;
const HEADER = /^\s+AGENTS_UPSTREAM_AUTH_HEADER:\s*\$\{AGENTS_UPSTREAM_AUTH_HEADER:-x-api-key\}\s*$/gm;
const PREFIX = /^\s+AGENTS_UPSTREAM_AUTH_PREFIX:\s*\$\{AGENTS_UPSTREAM_AUTH_PREFIX:-\}\s*$/gm;
const JWT_TTL = /^\s+JWT_ACCESS_TTL_SECONDS:\s*\$\{JWT_ACCESS_TTL_SECONDS:-900\}\s*$/gm;
const JWT_ISS = /^\s+JWT_ISSUER:\s*\$\{JWT_ISSUER:-intafaced\}\s*$/gm;
const JWT_AUD = /^\s+JWT_AUDIENCE:\s*\$\{JWT_AUDIENCE:-intafaced\.api\}\s*$/gm;

describe('compose IDENTITY_URL for agents affiliate producer', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const envTs = readFileSync(join(ROOT, 'services/svc-agents/src/env.ts'), 'utf8');
  const block = agentsServiceBlock(compose);

  it('env.ts declares optional IDENTITY_URL with no localhost default', () => {
    expect(envTs).toMatch(/IDENTITY_URL:\s*blankAsAbsent\(z\.string\(\)\.url\(\)\.optional\(\)\)/);
    expect(envTs).not.toMatch(/IDENTITY_URL:[\s\S]*localhost:4002/);
  });

  it('env.ts declares required LEDGER_URL with no localhost default', () => {
    const ledgerDecl = envTs.slice(envTs.indexOf('LEDGER_URL:'));
    expect(ledgerDecl).toMatch(/LEDGER_URL:\s*z\.string\(\)\.url\(\)/);
    expect(ledgerDecl.slice(0, 160)).not.toMatch(/\.default\(/);
    expect(ledgerDecl.slice(0, 200)).not.toMatch(/localhost:4001/);
    expect(envTs).not.toMatch(/LEDGER_URL:\s*z\.string\(\)\.url\(\)\.default\('http:\/\/localhost:4001'\)/);
  });

  it('compose svc-agents block pins IDENTITY_URL to svc-identity once', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-agents/);
    expect(block.match(IDENTITY)).toHaveLength(1);
    expect(countAssignments(block, 'IDENTITY_URL')).toBe(1);
  });

  it('compose svc-agents block pins LEDGER_URL to svc-ledger once (no localhost)', () => {
    expect(block.match(LEDGER)).toHaveLength(1);
    expect(countAssignments(block, 'LEDGER_URL')).toBe(1);
    expect(block).not.toMatch(/localhost:4001/);
  });

  it('index constructs the ledger client from env.LEDGER_URL only', () => {
    const indexSrc = readFileSync(join(ROOT, 'services/svc-agents/src/index.ts'), 'utf8');
    expect(indexSrc).toMatch(/createLedgerClient\(env\.LEDGER_URL/);
    expect(indexSrc).not.toMatch(/localhost:4001/);
  });

  it('blank / unset IDENTITY_URL does not invent a navigator identity port', () => {
    const indexSrc = readFileSync(join(ROOT, 'services/svc-agents/src/index.ts'), 'utf8');
    expect(indexSrc).toMatch(/const navigatorIdentitySessionPort = env\.IDENTITY_URL\s*\n\s*\? createHttpNavigatorIdentitySessionPort/);
    expect(indexSrc).not.toMatch(/localhost:4002/);
    expect(indexSrc).not.toMatch(/createHttpNavigatorIdentitySessionPort\(\{\s*identityUrl:\s*'http/);
  });

  it('live identity miss discards the caller fixture (session-run + invokeDataTool)', () => {
    const sessionRun = readFileSync(join(ROOT, 'services/svc-agents/src/navigator/session-run.ts'), 'utf8');
    const router = readFileSync(join(ROOT, 'services/svc-agents/src/router.ts'), 'utf8');
    expect(sessionRun).toMatch(/sessionFixture = liveSession\.ok \? liveSession\.session : null/);
    expect(sessionRun).not.toMatch(/if \(liveSession\.ok\) sessionFixture = liveSession\.session;/);
    expect(router).toMatch(/const tool = input\.tool\.trim\(\)/);
    expect(router).toMatch(/plane === 'live' && tool === 'identity\.session\.read'/);
    expect(router).not.toMatch(/input\.tool === 'identity\.session\.read'/);
    expect(router).toMatch(/readLiveNavigatorSession\(/);
    expect(router).toMatch(/session = liveSession\.ok \? liveSession\.session : null/);
    expect(router).not.toMatch(/if \(liveSession\) session = liveSession;/);
    expect(router).not.toMatch(/navigatorIdentitySessionPort\.read\([^)]*\)\.catch\(\(\) => null\)/);
  });

  it('does not restamp AGENTS_PROVIDER mock, AUTH_HEADER, JWT_*, or key-no-value upstream', () => {
    expect(block).toMatch(/AGENTS_PROVIDER:\s*\$\{AGENTS_PROVIDER:-mock\}/);
    expect(block).not.toMatch(/AGENTS_PROVIDER:\s*\$\{AGENTS_PROVIDER:-upstream\}/);
    expect(block.match(HEADER)).toHaveLength(1);
    expect(block.match(PREFIX)).toHaveLength(1);
    expect(block.match(JWT_TTL)).toHaveLength(1);
    expect(block.match(JWT_ISS)).toHaveLength(1);
    expect(block.match(JWT_AUD)).toHaveLength(1);
    expect(block).toMatch(/^\s+AGENTS_UPSTREAM_BASE_URL:\s*$/m);
    expect(block).toMatch(/^\s+AGENTS_UPSTREAM_API_KEY:\s*$/m);
    expect(block).toMatch(/^\s+AGENTS_UPSTREAM_HEADERS:\s*$/m);
    expect(block).toMatch(/^\s+AGENTS_UPSTREAM_MODELS:\s*$/m);
    expect(block).toMatch(/^\s+AGENTS_UPSTREAM_COMPLETIONS_PATH:\s*$/m);
    expect(block).toMatch(/^\s+AGENTS_UPSTREAM_EMBEDDINGS_PATH:\s*$/m);
    expect(block).toMatch(/^\s+AGENTS_ROUTING_TABLE:\s*$/m);
  });
});
