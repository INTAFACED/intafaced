import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Balance-table row for pool size.
 *
 * The schema header says a pool's size is the sum of the ledger stake
 * accounts behind its open positions, and this service stores no balance.
 * `EarnService.poolSize` already reads those accounts. This row used to
 * answer with `SUM(principal)` over the positions table.
 */

const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md'), 'utf8');

function balanceTableAnswer(question: string): string {
  const row = readme.split('\n').find((line) => line.startsWith(`| ${question}`));
  if (!row) throw new Error(`balance table has no row for ${question}`);
  const cells = row
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
  if (cells[0] !== question || cells[1] === undefined) {
    throw new Error(`balance table row for ${question} did not parse`);
  }
  return cells[1];
}

describe('svc-bank balance table: how big is a pool', () => {
  it('names the sum of ledger stake accounts, not SUM(principal) over positions', () => {
    const answer = balanceTableAnswer('How big is a pool?');
    expect(answer).not.toContain('SUM(principal)');
    expect(answer).toContain('ledger.balance(earnStakeAccount(');
  });
});
