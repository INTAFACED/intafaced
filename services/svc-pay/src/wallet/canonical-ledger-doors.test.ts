import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Withdraw and deposit ledger posts belong on the two canonical doors.
 * A second engine that calls the same recipes is a second money path.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEEDLES = ['recipes.withdrawHold(', 'recipes.withdrawSettle(', 'recipes.withdrawReverse(', 'recipes.deposit('] as const;
const ALLOWED = new Set(['user-money-service.ts', 'payment-service.ts']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
      continue;
    }
    if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

describe('canonical ledger doors', () => {
  it('posts withdraw and deposit recipes only from user-money-service and payment-service', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const base = file.slice(file.lastIndexOf('/') + 1);
      const text = readFileSync(file, 'utf8');
      for (const needle of NEEDLES) {
        if (text.includes(needle) && !ALLOWED.has(base)) offenders.push(`${base} ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
