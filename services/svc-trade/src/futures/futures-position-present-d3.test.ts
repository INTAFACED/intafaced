/**
 * Maintenance on a position row is planLadderRung's maintenanceRequired.
 * The presenter does not import the test ladder and does not hard-null the field.
 */

import { parseAmount as amt, formatAmount } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { DOOR_USER_ID, positionsOver, storedPositionRow } from './testing/doors.js';
import { planLadderRung, type FuturesLadderPolicy } from './maintenance-ladder.js';

/** An owner policy for the test: one band, so the maintenance figure is easy to check by hand. */
const POLICY: FuturesLadderPolicy = {
  tiers: [{ uptoDepthBps: Number.MAX_SAFE_INTEGER, maintenanceBps: 500 }],
  marginCallBps: 12_000,
  targetBps: 15_000,
  maxTrancheBps: 10_000,
};
const DEPTH = amt('1000000');
const ladder = (policy?: FuturesLadderPolicy) => ({
  depth: {
    async depthNotional() {
      return DEPTH;
    },
  },
  ...(policy ? { policy } : {}),
});

describe('position present uses the liquidation ladder for maintenance', () => {
  it('does not import DEFAULT_FUTURES_LADDER_POLICY', async () => {
    // No owner policy: maintenance is null with its reason, never a placeholder figure.
    const { service, feed } = positionsOver([storedPositionRow()], { ladder: ladder() });
    feed('51000');
    const [row] = await service.listOpen(DOOR_USER_ID);
    expect(row!.markPrice).toBe('51000');
    expect(row!.maintenanceMargin).toBeNull();
    expect(row!.fieldReasons?.maintenanceMargin).toBe('maintenance_policy_unset');
    expect(row!.liquidationPrice).toBeNull();
  });

  it('maintenanceAt calls planLadderRung and presentPosition does not hard-null maintenance', async () => {
    const stored = storedPositionRow();
    const { service, feed } = positionsOver([stored], { ladder: ladder(POLICY) });
    feed('51000');
    const [row] = await service.listOpen(DOOR_USER_ID);
    const rung = planLadderRung({
      position: {
        positionId: stored.id,
        userId: stored.user_id,
        side: 'long',
        size: amt('1'),
        entryPrice: amt('50000'),
        margin: amt('5000'),
        marginAsset: 'USDT',
      },
      markPrice: amt('51000'),
      depthNotional: DEPTH,
      policy: POLICY,
    });
    expect(row!.maintenanceMargin).toBe(formatAmount(rung.maintenanceRequired));
    expect(row!.maintenanceMargin).toBe('2550');
    expect(row).not.toHaveProperty('nextFundingTimestamp');
  });

  it('listOpen presents through presentListed', async () => {
    // listOpen reads the mark itself (the fill figures carry none): dark is null with a reason, then the fed price.
    const { service, feed, marks } = positionsOver([storedPositionRow()], { ladder: ladder(POLICY) });
    const [dark] = await service.listOpen(DOOR_USER_ID);
    expect(dark!.markPrice).toBeNull();
    expect(dark!.maintenanceMargin).toBeNull();
    expect(dark!.liquidationPrice).toBeNull();
    expect(dark!.fieldReasons).toMatchObject({ markPrice: 'mark_missing', maintenanceMargin: 'mark_missing' });
    feed('49000');
    const [lit] = await service.listOpen(DOOR_USER_ID);
    expect(lit!.markPrice).toBe('49000');
    expect(lit!.maintenanceMargin).not.toBeNull();
    expect(lit!.fees).toBeNull();
    marks.clear('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    expect((await service.listOpen(DOOR_USER_ID))[0]!.markPrice).toBeNull();
  });
});
