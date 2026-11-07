import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

function marketComposeBlock(compose: string): string {
  const start = compose.search(/^  svc-market:/m);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = compose.slice(start);
  const next = rest.slice(1).search(/^  [a-z0-9-]+:/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('market.commerce — the owner sets the house commission on the host only', () => {
  it('.env.example leaves it blank (public repo; the value is in the private records), so a copied example refuses', () => {
    const line = read('.env.example')
      .split(/\r?\n/)
      .find((l) => l.startsWith('MARKET_HOUSE_COMMISSION_BPS='));
    expect(line).toBe('MARKET_HOUSE_COMMISSION_BPS=');
  });

  it('compose is pass-through with no seeded default', () => {
    const block = marketComposeBlock(read('docker-compose.apps.yml'));
    expect(block).toMatch(/MARKET_HOUSE_COMMISSION_BPS:\s*\$\{MARKET_HOUSE_COMMISSION_BPS:-\}/);
    expect(block).not.toMatch(/MARKET_HOUSE_COMMISSION_BPS:\s*\$\{MARKET_HOUSE_COMMISSION_BPS:-0\}/);
    expect(block).not.toMatch(/MARKET_HOUSE_COMMISSION_BPS:\s*['"]?0['"]?\s*$/m);
  });

  it('schema still has no in-code default', () => {
    const envTs = read('services/svc-market/src/env.ts');
    const decl = envTs.slice(envTs.indexOf('MARKET_HOUSE_COMMISSION_BPS:'));
    expect(decl.slice(0, 400)).toMatch(/marketHouseCommissionBpsSchema/);
    expect(decl.slice(0, 400)).not.toMatch(/\.default\(/);
    const bps = read('services/svc-market/src/house-commission-bps.ts');
    expect(bps).toMatch(/\.optional\(\)/);
    expect(bps).not.toMatch(/\.default\(/);
    expect(bps).toMatch(/trim\(\) === ''/);
  });
});
