/**
 * Unit card — compose stack passes WEBAUTHN_ENABLED into svc-identity
 *
 * 1. Promise: host `.env` can kill WebAuthn without redeploying TOTP
 *    (env.ts already declares WEBAUTHN_ENABLED).
 * 2. Break: compose booted identity without the name → operator stop is a
 *    no-op and the container keeps the schema default forever.
 * 3. Done bar: docker-compose.apps.yml svc-identity has
 *    WEBAUTHN_ENABLED: ${WEBAUTHN_ENABLED:-true} (boolish default true).
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-identity block only)
 * 6. RED: pin fails if the line drops off the svc-identity service block
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

const LINE = /WEBAUTHN_ENABLED:\s*\$\{WEBAUTHN_ENABLED:-true\}/;

describe('compose WEBAUTHN_ENABLED kill-switch for svc-identity', () => {
  it('wires svc-identity WEBAUTHN_ENABLED from the host, unique once', () => {
    const block = identityServiceBlock(readFileSync(COMPOSE, 'utf8'));
    expect(block).toMatch(/SERVICE_NAME:\s*svc-identity/);
    expect(block).toMatch(LINE);
    expect(block.match(/^\s+WEBAUTHN_ENABLED:\s*\$\{WEBAUTHN_ENABLED:-true\}\s*$/gm)).toHaveLength(1);
  });
});
