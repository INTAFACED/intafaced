/**
 * listOpen reads the mark gate. It does not invent a price, including 0.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'position-service.ts'), 'utf8');

describe('listOpen does not invent marks', () => {
  it('reads tryMarkForMarking and never writes a zero mark', () => {
    const listOpen = src.slice(src.indexOf('async listOpen'), src.indexOf('async listClosed'));
    const listed = src.slice(src.indexOf('private async presentListed'), src.indexOf('private async maintenanceAt'));
    expect(listOpen).toMatch(/this\.presentListed\(row\)/);
    expect(listOpen).not.toMatch(/markPrice\s*\(/);
    expect(listed).toMatch(/tryMarkForMarking\(/);
    expect(listed).not.toMatch(/markPrice:\s*['"]0['"]/);
    expect(listed).not.toMatch(/formatAmount\(0n\)/);
  });
});
