import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function executionServiceBlock(source: string): string {
  return composeServiceBlock(source, 'svc-execution');
}

describe('compose TRADE_URL pin for svc-execution', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const block = executionServiceBlock(compose);

  it('pins TRADE_URL to fleet trade service', () => {
    expect(block).toMatch(/TRADE_URL:\s*http:\/\/svc-trade:4004/);
  });

  it('starts after svc-trade is healthy for OMS book snapshot', () => {
    expect(block).toMatch(/depends_on:\s*\n\s+svc-trade:\s*\{\s*condition:\s*service_healthy\s*\}/);
  });
});
