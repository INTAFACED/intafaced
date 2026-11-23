/**
 * Unit card — compose stack passes DEX_QUOTE_DEPTH into svc-dex
 *
 * 1. Promise: host `.env` publishes live book depth. Blank / unset stays
 *    unpublished (quote refuses). Owner-explicit 50 is allowed.
 * 2. Break: compose interpolates :-50 → blank looks published.
 * 3. Done bar: docker-compose.apps.yml svc-dex has
 *    DEX_QUOTE_DEPTH: ${DEX_QUOTE_DEPTH:-}.
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-dex block only)
 * 6. RED: pin fails if the line drops, duplicates, or git-defaults 50
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

const LINE = /DEX_QUOTE_DEPTH:\s*\$\{DEX_QUOTE_DEPTH:-\}/;

describe('compose DEX_QUOTE_DEPTH for svc-dex', () => {
  it('wires svc-dex DEX_QUOTE_DEPTH from the host, unique once, no invented 50', () => {
    const block = dexServiceBlock(readFileSync(COMPOSE, 'utf8'));
    expect(block).toMatch(/SERVICE_NAME:\s*svc-dex/);
    expect(block).toMatch(LINE);
    expect(block).not.toMatch(/DEX_QUOTE_DEPTH:-50/);
    expect(block.match(/^\s+DEX_QUOTE_DEPTH:\s*\$\{DEX_QUOTE_DEPTH:-\}\s*$/gm)).toHaveLength(1);
  });
});
