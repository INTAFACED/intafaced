/**
 * Unit card — compose stack passes IDENTITY_MAX_SUB_ACCOUNTS into svc-identity
 *
 * 1. Promise: host `.env` publishes the live-partition cap. Blank / unset
 *    stays unpublished (create refuses). Owner-explicit 25 is allowed.
 * 2. Break: compose interpolates :-25 → blank looks published.
 * 3. Done bar: docker-compose.apps.yml svc-identity has
 *    IDENTITY_MAX_SUB_ACCOUNTS: ${IDENTITY_MAX_SUB_ACCOUNTS:-}.
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-identity block only)
 * 6. RED: pin fails if the line drops, duplicates, or git-defaults 25
 * 7. Collision: none — this pin only reads svc-identity
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const COMPOSE = resolve(import.meta.dirname, '../../../docker-compose.apps.yml');

function identityServiceBlock(source: string): string {
  return composeServiceBlock(source, 'svc-identity');
}

const LINE = /IDENTITY_MAX_SUB_ACCOUNTS:\s*\$\{IDENTITY_MAX_SUB_ACCOUNTS:-\}/;

describe('compose IDENTITY_MAX_SUB_ACCOUNTS for svc-identity', () => {
  it('wires svc-identity IDENTITY_MAX_SUB_ACCOUNTS from the host, unique once, no invented 25', () => {
    const block = identityServiceBlock(readFileSync(COMPOSE, 'utf8'));
    expect(block).toMatch(/SERVICE_NAME:\s*svc-identity/);
    expect(block).toMatch(LINE);
    expect(block).not.toMatch(/IDENTITY_MAX_SUB_ACCOUNTS:-25/);
    expect(block.match(/^\s+IDENTITY_MAX_SUB_ACCOUNTS:\s*\$\{IDENTITY_MAX_SUB_ACCOUNTS:-\}\s*$/gm)).toHaveLength(1);
  });
});
