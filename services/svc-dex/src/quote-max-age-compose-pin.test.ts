/**
 * Unit card — compose stack passes QUOTE_MAX_AGE_MS into svc-dex
 *
 * 1. Promise: host `.env` publishes live quote freshness. Blank / unset stays
 *    unpublished (quote refuses). Owner-explicit 2000 is allowed.
 * 2. Break: compose interpolates :-2000 → blank looks published.
 * 3. Done bar: docker-compose.apps.yml svc-dex has
 *    QUOTE_MAX_AGE_MS: ${QUOTE_MAX_AGE_MS:-}.
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-dex block only)
 * 6. RED: pin fails if the line drops, duplicates, or git-defaults 2000
 * 7. Collision: none — this pin only reads svc-dex
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const COMPOSE = resolve(import.meta.dirname, '../../../docker-compose.apps.yml');

function dexServiceBlock(source: string): string {
  return composeServiceBlock(source, 'svc-dex');
}

const LINE = /QUOTE_MAX_AGE_MS:\s*\$\{QUOTE_MAX_AGE_MS:-\}/;

describe('compose QUOTE_MAX_AGE_MS for svc-dex', () => {
  it('wires svc-dex QUOTE_MAX_AGE_MS from the host, unique once, no invented 2000', () => {
    const block = dexServiceBlock(readFileSync(COMPOSE, 'utf8'));
    expect(block).toMatch(/SERVICE_NAME:\s*svc-dex/);
    expect(block).toMatch(LINE);
    expect(block).not.toMatch(/QUOTE_MAX_AGE_MS:-2000/);
    expect(block.match(/^\s+QUOTE_MAX_AGE_MS:\s*\$\{QUOTE_MAX_AGE_MS:-\}\s*$/gm)).toHaveLength(1);
  });
});
