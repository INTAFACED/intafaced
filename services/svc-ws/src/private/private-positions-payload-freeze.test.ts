import { describe, expect, it } from 'vitest';
import type { PrivatePositionUpdate } from './hub.js';
import {
  PRIVATE_POSITION_WIRE_KEYS,
  assertPrivatePositionWireHonest,
  encodePrivatePositionFrame,
  encodePrivatePositionsSnapshotFrame,
  freezePrivatePositionUpdate,
} from './private-positions-payload-freeze.js';

function position(overrides: Partial<PrivatePositionUpdate> = {}): PrivatePositionUpdate {
  return {
    positionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    userId: 'user-a',
    marketId: 'BTC-USDT-PERP',
    symbol: 'BTC/USDT:USDT',
    status: 'open',
    side: 'long',
    contracts: '2',
    entryPrice: '60000',
    markPrice: '60100',
    notional: '120200',
    leverage: '10',
    collateral: '12020',
    unrealizedPnl: '200',
    realizedPnl: '0',
    liquidationPrice: '54000',
    marginMode: 'cross',
    fundingPaid: '0',
    ts: '2026-07-31T00:00:00.000Z',
    ...overrides,
  };
}

describe('private positions payload freeze', () => {
  it('exports a frozen key catalog aligned with PrivatePositionUpdate', () => {
    expect(PRIVATE_POSITION_WIRE_KEYS).toContain('positionId');
    expect(PRIVATE_POSITION_WIRE_KEYS).toContain('closingReason');
    expect(PRIVATE_POSITION_WIRE_KEYS).not.toContain('positions');
  });

  it('freezePrivatePositionUpdate emits only catalog keys plus channel', () => {
    const frozen = freezePrivatePositionUpdate(position({ closingReason: 'operator' }));
    expect(frozen.channel).toBe('positions');
    expect(frozen.closingReason).toBe('operator');
    for (const key of Object.keys(frozen)) {
      if (key === 'channel') continue;
      expect(PRIVATE_POSITION_WIRE_KEYS).toContain(key);
    }
    expect(Object.keys(frozen)).not.toContain('positions');
  });

  it('encodePrivatePositionFrame rejects invented blotter wrappers', () => {
    const frame = encodePrivatePositionFrame(position());
    expect(() => assertPrivatePositionWireHonest(JSON.parse(frame))).not.toThrow();
    expect(() => assertPrivatePositionWireHonest({ channel: 'positions', positions: [] })).toThrow(/invented positions blotter/i);
    expect(() => assertPrivatePositionWireHonest({ channel: 'positions', ...position(), inventedMid: '1' })).toThrow(
      /unknown position wire key inventedMid/,
    );
  });

  it('snapshot frames freeze each row and keep explicit snapshot type', () => {
    const frame = encodePrivatePositionsSnapshotFrame('user-a', [position()]);
    const parsed = JSON.parse(frame) as { type: string; positions: Array<Record<string, unknown>> };
    expect(parsed.type).toBe('snapshot');
    expect(parsed.positions[0]?.channel).toBe('positions');
    expect(parsed.positions[0]?.inventedMid).toBeUndefined();
    assertPrivatePositionWireHonest(parsed);
  });

  it('refuses a positions snapshot whose positions value is not an array, including an invented envelope key', () => {
    expect(() =>
      assertPrivatePositionWireHonest({
        channel: 'positions',
        type: 'snapshot',
        userId: 'user-a',
        positions: { blotter: true },
        inventedMid: '1',
      }),
    ).toThrow(/unknown position wire key inventedMid/);
    expect(() =>
      assertPrivatePositionWireHonest({
        channel: 'positions',
        type: 'snapshot',
        userId: 'user-a',
        positions: { blotter: true },
      }),
    ).toThrow(/positions snapshot must be an array/);
    expect(() =>
      assertPrivatePositionWireHonest({
        channel: 'positions',
        type: 'snapshot',
        userId: 'user-a',
        positions: [freezePrivatePositionUpdate(position())],
        inventedMid: '1',
      }),
    ).toThrow(/unknown position wire key inventedMid/);
    expect(() =>
      assertPrivatePositionWireHonest({
        channel: 'positions',
        type: 'snapshot',
        userId: 'user-a',
        positions: [{ ...freezePrivatePositionUpdate(position()), inventedMid: '1' }],
      }),
    ).toThrow(/unknown position wire key inventedMid/);
    expect(() => assertPrivatePositionWireHonest(JSON.parse(encodePrivatePositionsSnapshotFrame('user-a', [position()])))).not.toThrow();
  });
});
