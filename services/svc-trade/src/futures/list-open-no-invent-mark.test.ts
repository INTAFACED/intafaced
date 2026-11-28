/**
 * listOpen reads the mark gate. It does not invent a price, including 0.
 */

import { describe, expect, it } from 'vitest';
import { DOOR_MARKET_ID, DOOR_NOW, DOOR_USER_ID, positionsOver, storedPositionRow } from './testing/doors.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

describe('listOpen does not invent marks', () => {
  it('reads tryMarkForMarking and never writes a zero mark', async () => {
    const { service, marks, feed, queries } = positionsOver([storedPositionRow()]);
    // No quote: the row lists with a null mark and its reason, never '0', and nothing is written.
    const [dark] = await service.listOpen(DOOR_USER_ID);
    expect(dark!.markPrice).toBeNull();
    expect(dark!.fieldReasons?.markPrice).toBe('mark_missing');
    // A quote too old to mark with is unusable, still not '0'.
    marks.set({ marketId: DOOR_MARKET_ID, price: '51000', quality: 'mid', asOfMs: DOOR_NOW.getTime() - 24 * 3_600_000 });
    const [stale] = await service.listOpen(DOOR_USER_ID);
    expect(stale!.markPrice).toBeNull();
    expect(stale!.fieldReasons?.markPrice).toBe('mark_unusable');
    // A usable quote is what the row shows.
    feed('51000');
    const [lit] = await service.listOpen(DOOR_USER_ID);
    expect(lit!.markPrice).toBe('51000');
    expect(queries.every((q) => /^\s*SELECT/i.test(q))).toBe(true);
  });
});

// Kept source pins: what these read is wired where no test can call it yet, or on paths a behaviour test does not drive.
// Each pin stays until a behaviour test holds the same property on every path.
describe('kept source pins', () => {
  const src = readFileSync(join(here, 'position-service.ts'), 'utf8');

  it('reads tryMarkForMarking and never writes a zero mark (kept source pin)', () => {
    const listOpen = src.slice(src.indexOf('async listOpen'), src.indexOf('async listClosed'));
    const listed = src.slice(src.indexOf('private async presentListed'), src.indexOf('private async maintenanceAt'));
    // The fill figures it passes (fees) carry no mark, so presentListed still reads one itself.
    expect(listOpen).toMatch(/this\.presentListed\(row, figures\.get\(row\.id\)\)/);
    const figures = src.slice(src.indexOf('private async matchedFigures'), src.indexOf('async get('));
    expect(figures).not.toMatch(/markPrice/);
    expect(listOpen).not.toMatch(/markPrice\s*\(/);
    expect(listed).toMatch(/tryMarkForMarking\(/);
    expect(listed).not.toMatch(/markPrice:\s*['"]0['"]/);
    expect(listed).not.toMatch(/formatAmount\(0n\)/);
  });
});
