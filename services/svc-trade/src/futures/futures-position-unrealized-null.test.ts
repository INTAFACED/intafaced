/**
 * Present fills unrealised PnL from the mark the service actually read.
 * A missing mark stays null with a reason. It is never a hardcoded 0.
 */

import { describe, expect, it } from 'vitest';
import { DOOR_USER_ID, positionsOver, storedPositionRow } from './testing/doors.js';

describe('position present values unrealised PnL from the mark', () => {
  it('uses the close planner helper and does not hard-null or invent 0', async () => {
    // A long of 1 at 50000 with 5000 initial margin, marked at 51000: +1000, which is 20% of initial margin.
    const long = positionsOver([storedPositionRow({ contract_size: '0.01' })]);
    long.feed('51000');
    const [lit] = await long.service.listOpen(DOOR_USER_ID);
    expect(lit).toMatchObject({ markPrice: '51000', unrealizedPnl: '1000', percentage: '20', contractSize: '0.01' });
    // The same row, short, at 51000: a loss, not a zero.
    const short = positionsOver([storedPositionRow({ side: 'short' })]);
    short.feed('51000');
    const [loss] = await short.service.listOpen(DOOR_USER_ID);
    expect(loss).toMatchObject({ unrealizedPnl: '-1000', percentage: '-20', contractSize: null });
    expect(loss!.fieldReasons?.contractSize).toBe('contract_size_not_recorded');
    // No mark: null with its reason, never '0'.
    const dark = positionsOver([storedPositionRow()]);
    const [none] = await dark.service.listOpen(DOOR_USER_ID);
    expect(none).toMatchObject({ markPrice: null, unrealizedPnl: null, percentage: null });
    expect(none!.fieldReasons).toMatchObject({ unrealizedPnl: 'mark_missing', percentage: 'mark_missing' });
  });
});
