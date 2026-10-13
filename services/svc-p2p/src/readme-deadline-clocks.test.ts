import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The deadline table and the created-expiry crash row must not state live
 * clocks. Production installs owner-published integers and throws when blank.
 */

const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md'), 'utf8');
const lines = readme.split('\n');

function deadlineTable(source: string): string {
  const rows = source.split('\n');
  const header = rows.findIndex((line) => /^\|\s*State\s*\|/.test(line) && line.includes('Deadline'));
  if (header < 0) {
    throw new Error('deadline table header missing');
  }
  const body: string[] = [];
  for (let i = header; i < rows.length; i++) {
    if (i > header && !rows[i]!.startsWith('|')) break;
    body.push(rows[i]!);
  }
  return body.join('\n');
}

function statesTwoMinuteCreatedExpiry(line: string): boolean {
  return /2[ -]?min/i.test(line) && /created|expir/i.test(line);
}

const UNSET_CODES = [
  'p2p.escrow_deadline_unset',
  'p2p.payment_deadline_unset',
  'p2p.release_deadline_unset',
  'p2p.dispute_sla_unset',
] as const;

describe('svc-p2p README deadline clocks', () => {
  it('does not state invented live clocks and names the blank-env refusals', () => {
    const table = deadlineTable(readme);
    expect(table).not.toMatch(/\b2 min\b/);
    expect(table).not.toMatch(/\b15 min\b/);
    expect(table).not.toMatch(/\b30 min\b/);
    expect(table).not.toMatch(/\b7 days\b/);

    const line340 = lines[339] ?? '';
    expect(statesTwoMinuteCreatedExpiry(line340)).toBe(false);

    const createdExpiry = lines.find((line) => line.includes('after the inventory reserve')) ?? '';
    expect(createdExpiry).not.toBe('');
    expect(statesTwoMinuteCreatedExpiry(createdExpiry)).toBe(false);
    expect(createdExpiry).not.toMatch(/\b2 min\b/);

    for (const code of UNSET_CODES) {
      expect(readme).toContain(code);
    }
    expect(readme).toMatch(/owner-published integers/);
  });
});
