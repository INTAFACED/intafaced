import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('svc-tax compose mount', () => {
  it('fleet block exists on 4020 with refuse-closed owner map', () => {
    const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
    const match = compose.match(/^  svc-tax:\n(?:.*\n)*?(?=^  [a-z#]|\Z)/m);
    expect(match, 'svc-tax service block missing from docker-compose.apps.yml').toBeTruthy();
    const block = match![0];
    expect(block).toContain("HTTP_PORT: '4020'");
    expect(block).toContain('LEDGER_URL: http://svc-ledger:4001');
    expect(block).toContain('BANK_URL: http://svc-bank:4009');
    expect(block).toMatch(/TAX_JURISDICTION_MAP_JSON:\s*\$\{TAX_JURISDICTION_MAP_JSON:-\}/);
    expect(block).toMatch(/TAX_HISTORY_YEARS:\s*\$\{TAX_HISTORY_YEARS:-\}/);
    expect(block).not.toMatch(/TAX_HISTORY_YEARS:\s*\$\{TAX_HISTORY_YEARS:-10\}/);
    expect(block).toContain('DATABASE_URL: postgres://svc_tax:${SVC_TAX_DB_PASSWORD:-svc_tax}@postgres:5432/intafaced');
    expect(block).toContain('<<: *needs-schema');
    expect(block).toMatch(/svc-ledger:\s*\n\s*condition: service_healthy/);
    expect(compose).toMatch(/TAX_URL: http:\/\/svc-tax:4020/);
  });
});
