import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('svc-ops compose mount', () => {
  it('fleet block exists on 4022 with warehouse refuse-closed and OPS_URL on the edge', () => {
    const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
    const block = composeServiceBlock(compose, 'svc-ops');
    expect(block).toContain("HTTP_PORT: '4022'");
    expect(block).toContain('SERVICE_NAME: svc-ops');
    expect(block).toContain('OPS_CUSTODY_WRAP:');
    expect(block).toContain('OPS_CUSTODY_FREEZE_POLICY:');
    expect(block).toContain('IDENTITY_URL: http://svc-identity:4002');
    expect(compose).toMatch(/OPS_URL: http:\/\/svc-ops:4022/);
  });
});
