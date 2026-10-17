/**
 * Present fills unrealised PnL from the mark the service actually read.
 * A missing mark stays null with a reason. It is never a hardcoded 0.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'position-service.ts'), 'utf8');
const present = src.slice(src.indexOf('function presentPosition'), src.indexOf('export function storedEntryAfterFill'));

describe('position present values unrealised PnL from the mark', () => {
  it('uses the close planner helper and does not hard-null or invent 0', () => {
    expect(present).toMatch(/unrealizedPnl\(/);
    expect(present).toMatch(/positionPercentage\(/);
    expect(present).not.toMatch(/unrealizedPnl:\s*null/);
    expect(present).not.toMatch(/unrealizedPnl:\s*['"]0['"]/);
    expect(present).not.toMatch(/percentage:\s*null/);
    expect(present).not.toMatch(/contractSize:\s*null/);
  });
});
