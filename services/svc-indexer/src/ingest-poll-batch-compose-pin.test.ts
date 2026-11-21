/**
 * Unit card — compose stack passes ingest poll interval and batch size into svc-indexer
 *
 * 1. Promise: INDEXER_POLL_INTERVAL_MS and INDEXER_BATCH_SIZE from host `.env`
 *    reach the container. Poll still git-defaults 2000 ms (timeout mill is
 *    out of scope). Batch size has no invented 200 — blank/unset refuse.
 * 2. Break: compose booted indexer with chain id / empty RPC / zero venue /
 *    start height / finality / ingest kill but no poll cadence or batch size →
 *    a host cannot bound ingest blast radius from `.env`.
 * 3. Done bar: docker-compose.apps.yml svc-indexer has
 *    INDEXER_POLL_INTERVAL_MS: ${INDEXER_POLL_INTERVAL_MS:-2000}
 *    INDEXER_BATCH_SIZE: ${INDEXER_BATCH_SIZE:-}
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-indexer block only)
 * 6. RED: pin fails if a unique key drops, duplicates in the indexer block,
 *    poll default is not 2000, or batch interpolates :-200
 * 7. Collision: existing chain/RPC/venue/start/finality/ingest pins — this pin
 *    does not restamp those keys, invent INDEXER_RPC_URL, invent a venue, or
 *    add LEDGER_URL / signing keys
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const COMPOSE = resolve(import.meta.dirname, '../../../docker-compose.apps.yml');
const ENV_TS = resolve(import.meta.dirname, './env.ts');

function indexerServiceBlock(source: string): string {
  return composeServiceBlock(source, 'svc-indexer');
}

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

const POLL = /^\s+INDEXER_POLL_INTERVAL_MS:\s*\$\{INDEXER_POLL_INTERVAL_MS:-2000\}\s*$/gm;
const BATCH = /^\s+INDEXER_BATCH_SIZE:\s*\$\{INDEXER_BATCH_SIZE:-\}\s*$/gm;

describe('compose ingest poll interval and batch size for svc-indexer', () => {
  const compose = readFileSync(COMPOSE, 'utf8');
  const envTs = readFileSync(ENV_TS, 'utf8');
  const block = indexerServiceBlock(compose);

  it('env.ts still defaults INDEXER_POLL_INTERVAL_MS 2000; INDEXER_BATCH_SIZE has no git-default 200', () => {
    expect(envTs).toMatch(/INDEXER_POLL_INTERVAL_MS:\s*z\.coerce\.number\(\)\.int\(\)\.min\(100\)\.max\(600_000\)\.default\(2_000\)/);
    expect(envTs).not.toMatch(/INDEXER_BATCH_SIZE:[\s\S]*?\.default\(200\)/);
  });

  it('wires unique host pass-through keys once; poll defaults 2000, batch empty default', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-indexer/);
    expect(block.match(POLL)).toHaveLength(1);
    expect(block.match(BATCH)).toHaveLength(1);
    expect(countAssignments(block, 'INDEXER_POLL_INTERVAL_MS')).toBe(1);
    expect(countAssignments(block, 'INDEXER_BATCH_SIZE')).toBe(1);
  });

  it('does not restamp chain/rpc/venue/start/finality/ingest or invent ledger/signing', () => {
    expect(block).toMatch(/INDEXER_CHAIN_ID:\s*\$\{PROTOCOL_CHAIN_ID:-\}/);
    expect(block).not.toMatch(/INDEXER_CHAIN_ID:.*31337/);
    expect(block).toMatch(/INDEXER_RPC_URL:\s*\$\{INDEXER_RPC_URL:-\}/);
    expect(block).not.toMatch(/INDEXER_RPC_URL:.*evm:8545/);
    expect(block).toMatch(/INDEXER_VENUE_ADDRESS:\s*\$\{INDEXER_VENUE_ADDRESS:-\}/);
    expect(block).not.toMatch(/INDEXER_VENUE_ADDRESS:.*0x0116/);
    expect(block).toMatch(/INDEXER_START_HEIGHT:\s*\$\{INDEXER_START_HEIGHT:-\}/);
    expect(block).not.toMatch(/INDEXER_START_HEIGHT:.*:-0/);
    expect(block).toMatch(/INDEXER_FINALITY_DEPTH:\s*\$\{INDEXER_FINALITY_DEPTH:-\}/);
    expect(block).not.toMatch(/INDEXER_FINALITY_DEPTH:.*:-64/);
    expect(block).not.toMatch(/INDEXER_BATCH_SIZE:.*:-200/);
    expect(block).toMatch(/INDEXER_INGEST_ENABLED:\s*\$\{INDEXER_INGEST_ENABLED:-true\}/);
    expect(countAssignments(block, 'INDEXER_CHAIN_ID')).toBe(1);
    expect(countAssignments(block, 'INDEXER_RPC_URL')).toBe(1);
    expect(countAssignments(block, 'INDEXER_VENUE_ADDRESS')).toBe(1);
    expect(countAssignments(block, 'INDEXER_START_HEIGHT')).toBe(1);
    expect(countAssignments(block, 'INDEXER_FINALITY_DEPTH')).toBe(1);
    expect(countAssignments(block, 'INDEXER_INGEST_ENABLED')).toBe(1);
    expect(countAssignments(block, 'LEDGER_URL')).toBe(0);
    expect(countAssignments(block, 'JWT_ACCESS_SECRET')).toBe(0);
    expect(block).not.toMatch(/PRIVATE_KEY|SIGNING_KEY/i);
  });
});
