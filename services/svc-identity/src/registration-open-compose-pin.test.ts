/**
 * Unit card — compose stack passes REGISTRATION_OPEN into svc-identity
 *
 * 1. Promise: host `.env` publishes the registration gate. Blank / unset
 *    stays unpublished (register refuses). Owner-explicit true is allowed.
 * 2. Break: compose interpolates :-true → blank looks published open.
 * 3. Done bar: docker-compose.apps.yml svc-identity has
 *    REGISTRATION_OPEN: ${REGISTRATION_OPEN:-}.
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-identity block only)
 * 6. RED: pin fails if the line drops, duplicates, or git-defaults true
 * 7. Collision: none — this pin only reads svc-identity. Does not restamp
 *    WEBAUTHN / JWT localhost defaults.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const COMPOSE = resolve(import.meta.dirname, '../../../docker-compose.apps.yml');

function identityServiceBlock(source: string): string {
  return composeServiceBlock(source, 'svc-identity');
}

const LINE = /REGISTRATION_OPEN:\s*\$\{REGISTRATION_OPEN:-\}/;

describe('compose REGISTRATION_OPEN for svc-identity', () => {
  it('wires svc-identity REGISTRATION_OPEN from the host, unique once, no invented true', () => {
    const block = identityServiceBlock(readFileSync(COMPOSE, 'utf8'));
    expect(block).toMatch(/SERVICE_NAME:\s*svc-identity/);
    expect(block).toMatch(LINE);
    expect(block).not.toMatch(/REGISTRATION_OPEN:-true/);
    expect(block.match(/^\s+REGISTRATION_OPEN:\s*\$\{REGISTRATION_OPEN:-\}\s*$/gm)).toHaveLength(1);
  });
});
