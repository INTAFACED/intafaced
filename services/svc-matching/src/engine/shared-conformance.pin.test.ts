/**
 * D-S-06 shared matching rows — Fiat pins.
 *
 * Law: docs/adr/2026-09-18-matching-shared-conformance.md
 *
 * Source-scan only: a runtime import of the engine would require built
 * workspace packages. These assertions go red if Fiat drifts from the spec
 * INTACORE must import. They do not run a second engine.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../../..');
const ADR = join(ROOT, 'docs/adr/2026-09-18-matching-shared-conformance.md');
const CONTRACT_SCHEMAS = join(ROOT, 'packages/exchange-contract/src/schemas.ts');

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

function enumValues(source: string, exportName: string): string[] {
  const match = source.match(new RegExp(`export const ${exportName} = z\\.enum\\(\\[([^\\]]+)\\]\\)`));
  expect(match, `${exportName} in exchange-contract`).toBeTruthy();
  const inner = match?.[1] ?? '';
  return [...inner.matchAll(/'([^']+)'/g)].flatMap((m) => (m[1] ? [m[1]] : []));
}

describe('D-S-06 shared matching conformance pins', () => {
  it('ADR exists and names the shared rows a chain engineer would open', () => {
    expect(existsSync(ADR), ADR).toBe(true);
    const text = readFileSync(ADR, 'utf8');
    for (const token of [
      'GTC',
      'IOC',
      'FOK',
      'PO',
      'GTD',
      'GTT',
      'tif_missing',
      'CANCEL_RESTING_CONTINUE',
      'self_trade_prevention',
      'taker pays the book',
      'byte-identical',
      'take_profit',
      'precision.price',
      'Do not copy the TypeScript engine',
    ] as const) {
      expect(text, `ADR missing token: ${token}`).toContain(token);
    }
    expect(text).toMatch(/\*\*Status:\*\* proposed/);
    expect(text).toMatch(/\*\*Status note:\*\* \*\*Proposed \(spec\)\.\*\*/);
    expect(text).not.toMatch(/self-Accepted/);
  });

  it('TIF enum is one list: exchange-contract === KNOWN_TIF', () => {
    const schemas = readFileSync(CONTRACT_SCHEMAS, 'utf8');
    const coreTif = readFileSync(join(HERE, 'core-tif.ts'), 'utf8');
    const known = coreTif.match(/export const KNOWN_TIF = \[([^\]]+)\] as const satisfies readonly TimeInForce\[\]/);
    expect(known, 'KNOWN_TIF in core-tif.ts').toBeTruthy();
    const inner = known?.[1] ?? '';
    const engineTif = [...inner.matchAll(/'([^']+)'/g)].flatMap((m) => (m[1] ? [m[1]] : []));
    expect(enumValues(schemas, 'timeInForceSchema')).toEqual(engineTif);
    expect(engineTif).toEqual(['GTC', 'IOC', 'FOK', 'PO', 'GTD', 'GTT']);
    expect(coreTif).toContain('tif is required; missing TIF is not GTC');
  });

  it('sides are buy/sell only', () => {
    expect(enumValues(readFileSync(CONTRACT_SCHEMAS, 'utf8'), 'orderSideSchema')).toEqual(['buy', 'sell']);
  });

  it('public order types include take_profit; engine native types do not', () => {
    expect(enumValues(readFileSync(CONTRACT_SCHEMAS, 'utf8'), 'orderTypeSchema')).toEqual([
      'market',
      'limit',
      'stop',
      'stop_limit',
      'take_profit',
    ]);
    const types = readFileSync(join(HERE, 'types.ts'), 'utf8');
    expect(types).toContain("Exclude<z.infer<typeof orderTypeSchema>, 'take_profit'>");
    expect(types).toContain('the product layer maps down to `stop`/`stop_limit`');
  });

  it('STP v1 is expire-resting continue-taker, never a self-fill', () => {
    const stp = readFileSync(join(HERE, 'self-trade.ts'), 'utf8');
    expect(stp).toContain("export const SELF_TRADE_PREVENTION = 'self_trade_prevention'");
    expect(stp).toContain('expire the resting maker, continue the taker');
    expect(stp).toContain('Do not invent a self-fill');
    expect(stp).toContain('CANCEL_RESTING_CONTINUE');
    expect(existsSync(join(HERE, 'self-trade.test.ts'))).toBe(true);
  });

  it('fill price is the maker price (taker pays the book)', () => {
    const types = readFileSync(join(HERE, 'types.ts'), 'utf8');
    expect(types).toContain('the taker pays the book');
  });

  it('book.ts matching path forbids clock, randomness, and float money', () => {
    const body = stripComments(readFileSync(join(HERE, 'book.ts'), 'utf8'));
    expect(body).not.toMatch(/\bDate\.now\s*\(/);
    expect(body).not.toMatch(/\bnew Date\s*\(/);
    expect(body).not.toMatch(/\bMath\.random\s*\(/);
    expect(body).not.toMatch(/\bcrypto\.randomUUID\s*\(/);
    const header = readFileSync(join(HERE, 'book.ts'), 'utf8').slice(0, 2500);
    expect(header).toContain('price-time priority');
    expect(header).toContain('a JS `number` holding a price or a quantity');
  });

  it('determinism pins and one-book fairness pins still exist', () => {
    expect(existsSync(join(HERE, 'book.test.ts'))).toBe(true);
    expect(existsSync(join(HERE, 'dual-target-one-book.test.ts'))).toBe(true);
    expect(existsSync(join(HERE, 'core-tif.test.ts'))).toBe(true);
    expect(existsSync(join(HERE, 'journal-replay.ts'))).toBe(true);
    const replay = readFileSync(join(HERE, 'journal-replay.ts'), 'utf8');
    expect(replay).toContain('export function serializeBooks');
    const bookTest = readFileSync(join(HERE, 'book.test.ts'), 'utf8');
    expect(bookTest).toContain("describe('price-time priority'");
    expect(bookTest).toContain('round-trips through a snapshot byte for byte');
    expect(bookTest).toContain('contains no floating-point value anywhere');
    const tifTest = readFileSync(join(HERE, 'core-tif.test.ts'), 'utf8');
    expect(tifTest).toContain('omitted tif refuses tif_missing; nothing rests; not GTC');
  });
});
