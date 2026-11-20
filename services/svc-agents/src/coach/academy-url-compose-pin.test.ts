/**
 * Unit card — compose stack sets ACADEMY_URL for svc-agents
 *
 * 1. Promise: coach cites academy spine over S2S when ACADEMY_URL is set
 * 2. Break: compose boots agents without ACADEMY_URL → envCoachGrounding empty forever
 * 3. Done bar: docker-compose.apps.yml svc-agents has ACADEMY_URL → svc-academy:4016
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml
 * 6. RED: pin fails if ACADEMY_URL drops off the agents service block
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const COMPOSE = resolve(import.meta.dirname, '../../../../docker-compose.apps.yml');

function agentsServiceBlock(source: string): string {
  return composeServiceBlock(source, 'svc-agents');
}

describe('compose ACADEMY_URL for coach grounding', () => {
  it('wires svc-agents ACADEMY_URL to the academy internal surface', () => {
    const block = agentsServiceBlock(readFileSync(COMPOSE, 'utf8'));
    expect(block).toMatch(/ACADEMY_URL:\s*http:\/\/svc-academy:4016/);
    expect(block).toMatch(/SERVICE_NAME:\s*svc-agents/);
  });
});
