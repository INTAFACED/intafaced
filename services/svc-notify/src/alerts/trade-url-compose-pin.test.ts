/**
 * Unit card — compose stack sets TRADE_URL for svc-notify
 *
 * 1. Promise: #1586 + README — live marks when TRADE_URL points at trade public REST
 * 2. Break: compose booted notify without TRADE_URL → canFire false forever while trade is up
 * 3. Done bar: docker-compose.apps.yml svc-notify has TRADE_URL → svc-trade (same as bank)
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (deploy wiring for this wall)
 * 6. RED: pin fails if TRADE_URL drops off the notify service block
 * 7. Collision: none on Denon open PRs
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const COMPOSE = resolve(import.meta.dirname, '../../../../docker-compose.apps.yml');

function notifyServiceBlock(source: string): string {
  return composeServiceBlock(source, 'svc-notify');
}

describe('compose TRADE_URL for price watches', () => {
  it('wires svc-notify TRADE_URL to the trade public surface (not dark forever)', () => {
    const block = notifyServiceBlock(readFileSync(COMPOSE, 'utf8'));
    expect(block).toMatch(/TRADE_URL:\s*http:\/\/svc-trade:4004/);
    // Bank already has the same surface — keep the paths aligned so marks agree.
    expect(block).toMatch(/SERVICE_NAME:\s*svc-notify/);
  });

  it('waits for trade healthy when compose sets the mark feed', () => {
    const block = notifyServiceBlock(readFileSync(COMPOSE, 'utf8'));
    expect(block).toMatch(/svc-trade:\s*\n\s*condition:\s*service_healthy/);
  });
});
