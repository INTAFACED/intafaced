/**
 * ops.support Done-bar leftover was "no fleet container / INTERNAL_SERVICE_SECRET".
 * Both are on tip. This pin fails if compose drops the desk or the S2S secret,
 * which would make identity grounding 401 and look like "every account unread".
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMPOSE = resolve(import.meta.dirname, '../../../docker-compose.apps.yml');
const ROUTES = resolve(import.meta.dirname, '../../svc-edge/src/routes.ts');

function serviceBlock(source: string, name: string): string {
  const match = source.match(new RegExp(`^  ${name}:\\n(?:.*\\n)*?(?=^  [a-z]|\\Z)`, 'm'));
  if (!match) throw new Error(`${name} service block missing from docker-compose.apps.yml`);
  return match[0];
}

describe('ops.support fleet compose pin', () => {
  it('runs svc-support with internal secret, identity URL, and postgres role', () => {
    const block = serviceBlock(readFileSync(COMPOSE, 'utf8'), 'svc-support');
    expect(block).toMatch(/\*internal-secret/);
    expect(block).toMatch(/SERVICE_NAME:\s*svc-support/);
    expect(block).toMatch(/HTTP_PORT:\s*'4017'/);
    expect(block).toMatch(/DATABASE_URL:\s*postgres:\/\/svc_support:\$\{SVC_SUPPORT_DB_PASSWORD:-svc_support\}@postgres:5432\/intafaced/);
    expect(block).toMatch(/IDENTITY_URL:\s*http:\/\/svc-identity:4002/);
    expect(block).not.toMatch(/^\s+LEDGER_URL:/m);
    expect(block).toMatch(/svc-identity:\s*\{\s*condition:\s*service_healthy\s*\}/);
  });

  it('points the edge door at that container (not localhost-in-compose)', () => {
    const edge = serviceBlock(readFileSync(COMPOSE, 'utf8'), 'svc-edge');
    expect(edge).toMatch(/SUPPORT_URL:\s*http:\/\/svc-support:4017/);
    const routes = readFileSync(ROUTES, 'utf8');
    expect(routes).toMatch(/prefix: '\/api\/support'[\s\S]*envVar: 'SUPPORT_URL'/);
  });
});
