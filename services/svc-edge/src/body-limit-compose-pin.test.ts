/**
 * Unit card — compose stack passes EDGE_BODY_LIMIT_BYTES into svc-edge
 *
 * 1. Promise: host `.env` EDGE_BODY_LIMIT_BYTES reaches the container.
 *    Unset / blank do not become 1048576. Boot refuses. Owner may set 1048576.
 * 2. Break: compose `:-1048576` or env.ts `.default(1_048_576)` looks published
 *    when the operator never set the body ceiling.
 * 3. Done bar: docker-compose.apps.yml svc-edge has
 *    EDGE_BODY_LIMIT_BYTES: ${EDGE_BODY_LIMIT_BYTES:-}
 *    env.ts has no `.default(1_048_576)`
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-edge block only) + env.ts
 * 6. RED: pin fails if the unique key drops, compose bakes 1048576, env.ts
 *    git-defaults 1048576, EDGE_TRUST_PROXY appears, or EDGE_RATE_LIMIT_* /
 *    DEFAULT_REGION / JWT lines are restamped
 * 7. Collision: rate-limit-compose-flags-pin.test.ts — this pin does not
 *    restamp EDGE_RATE_LIMIT_* / DEFAULT_REGION / JWT secrets
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function edgeServiceBlock(source: string): string {
  return composeServiceBlock(source, 'svc-edge');
}

const BODY_LIMIT = /^\s+EDGE_BODY_LIMIT_BYTES:\s*\$\{EDGE_BODY_LIMIT_BYTES:-\}\s*$/gm;
const RATE_ENABLED = /^\s+EDGE_RATE_LIMIT_ENABLED:\s*\$\{EDGE_RATE_LIMIT_ENABLED:-true\}\s*$/gm;
const RATE_MAX = /^\s+EDGE_RATE_LIMIT_MAX:\s*\$\{EDGE_RATE_LIMIT_MAX:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const RATE_WINDOW = /^\s+EDGE_RATE_LIMIT_WINDOW_MS:\s*\$\{EDGE_RATE_LIMIT_WINDOW_MS:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const DEFAULT_REGION = /^\s+DEFAULT_REGION:\s*\$\{DEFAULT_REGION:-XX\}\s*$/gm;
const JWT_ACCESS = /^\s+JWT_ACCESS_SECRET:\s*\$\{JWT_ACCESS_SECRET:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const JWT_ISSUER = /^\s+JWT_ISSUER:\s*\$\{JWT_ISSUER:-intafaced\}\s*$/gm;
const JWT_AUDIENCE = /^\s+JWT_AUDIENCE:\s*\$\{JWT_AUDIENCE:-intafaced\.api\}\s*$/gm;

describe('compose body-limit for svc-edge', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const envTs = readFileSync(join(ROOT, 'services/svc-edge/src/env.ts'), 'utf8');
  const block = edgeServiceBlock(compose);

  it('env.ts refuses blank body-limit — no 1048576 default', () => {
    expect(envTs).toMatch(/EDGE_BODY_LIMIT_BYTES:\s*z\.coerce\s*\.number\(\)\s*\.int\(\)\s*\.min\(1024\)\s*\.max\(32 \* 1024 \* 1024\),/);
    expect(envTs).not.toMatch(/EDGE_BODY_LIMIT_BYTES:[\s\S]{0,200}\.default\(1_048_576\)/);
    expect(envTs).not.toMatch(/EDGE_BODY_LIMIT_BYTES:[\s\S]{0,200}\.default\(1048576\)/);
  });

  it('compose svc-edge block is empty pass-through (never invent 1048576)', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-edge/);
    expect(block.match(BODY_LIMIT)).toHaveLength(1);
    expect(block).not.toMatch(/EDGE_BODY_LIMIT_BYTES:\s*\$\{EDGE_BODY_LIMIT_BYTES:-1048576\}/);
  });

  it('does not set EDGE_TRUST_PROXY or restamp EDGE_RATE_LIMIT / DEFAULT_REGION / JWT secrets', () => {
    expect(block).not.toMatch(/EDGE_TRUST_PROXY:/);
    expect(block.match(RATE_ENABLED)).toHaveLength(1);
    expect(block.match(RATE_MAX)).toHaveLength(1);
    expect(block.match(RATE_WINDOW)).toHaveLength(1);
    expect(block.match(DEFAULT_REGION)).toHaveLength(1);
    expect(block.match(JWT_ACCESS)).toHaveLength(1);
    expect(block.match(JWT_ISSUER)).toHaveLength(1);
    expect(block.match(JWT_AUDIENCE)).toHaveLength(1);
  });
});
