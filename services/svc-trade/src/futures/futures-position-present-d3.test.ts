/**
 * Maintenance on a position row is planLadderRung's maintenanceRequired.
 * The presenter does not import the test ladder and does not hard-null the field.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'position-service.ts'), 'utf8');
const present = src.slice(src.indexOf('function presentPosition'), src.indexOf('export function storedEntryAfterFill'));
const listed = src.slice(src.indexOf('private async presentListed'), src.indexOf('private async maintenanceAt'));

describe('position present uses the liquidation ladder for maintenance', () => {
  it('does not import DEFAULT_FUTURES_LADDER_POLICY', () => {
    expect(src).not.toMatch(/DEFAULT_FUTURES_LADDER_POLICY/);
  });

  it('maintenanceAt calls planLadderRung and presentPosition does not hard-null maintenance', () => {
    const maintenance = src.slice(src.indexOf('private async maintenanceAt'), src.indexOf('type ReduceOnlyOutcome'));
    expect(maintenance).toMatch(/planLadderRung\(/);
    expect(maintenance).toMatch(/maintenanceRequired/);
    expect(present).not.toMatch(/maintenanceMargin:\s*null/);
    expect(present).not.toMatch(/nextFundingTimestamp/);
    expect(listed).toMatch(/tryMarkForMarking\(/);
  });

  it('listOpen presents through presentListed', () => {
    const listOpen = src.slice(src.indexOf('async listOpen'), src.indexOf('async listClosed'));
    // The only extras listOpen passes are the fill figures (fees), which carry no mark and no maintenance figure.
    expect(listOpen).toMatch(/this\.presentListed\(row, figures\.get\(row\.id\)\)/);
    expect(listOpen).not.toMatch(/presentPosition\(row,\s*\{/);
    const figures = src.slice(src.indexOf('private async matchedFigures'), src.indexOf('async get('));
    expect(figures).not.toMatch(/markPrice|maintenanceMargin|liquidationPrice/);
  });
});
