import type { PrivatePositionUpdate } from './hub.js';
import { isLiveZeroBlotterPayload } from './hub.js';

/**
 * Frozen private positions wire shape — no invented blotter keys.
 * Matches svc-trade `GET /api/v1/positions` parse + hub fan-out only.
 */
export const PRIVATE_POSITION_WIRE_KEYS = [
  'positionId',
  'userId',
  'marketId',
  'symbol',
  'status',
  'side',
  'contracts',
  'entryPrice',
  'markPrice',
  'notional',
  'leverage',
  'collateral',
  'unrealizedPnl',
  'realizedPnl',
  'liquidationPrice',
  'marginMode',
  'fundingPaid',
  'closingReason',
  'ts',
] as const satisfies readonly (keyof PrivatePositionUpdate)[];

const PRIVATE_POSITION_WIRE_KEY_SET = new Set<string>(PRIVATE_POSITION_WIRE_KEYS);

/** Snapshot envelope only. Row keys stay on `PRIVATE_POSITION_WIRE_KEYS`. */
const PRIVATE_POSITION_SNAPSHOT_ENVELOPE_KEYS = new Set<string>(['channel', 'type', 'userId', 'positions']);

export type PrivatePositionWirePayload = PrivatePositionUpdate & { readonly channel: 'positions' };

export function freezePrivatePositionUpdate(update: PrivatePositionUpdate): PrivatePositionWirePayload {
  const payload: PrivatePositionWirePayload = {
    channel: 'positions',
    positionId: update.positionId,
    userId: update.userId,
    marketId: update.marketId,
    symbol: update.symbol,
    status: update.status,
    side: update.side,
    contracts: update.contracts,
    entryPrice: update.entryPrice,
    markPrice: update.markPrice,
    notional: update.notional,
    leverage: update.leverage,
    collateral: update.collateral,
    unrealizedPnl: update.unrealizedPnl,
    realizedPnl: update.realizedPnl,
    liquidationPrice: update.liquidationPrice,
    marginMode: update.marginMode,
    fundingPaid: update.fundingPaid,
    ts: update.ts,
  };
  if (update.closingReason !== undefined) {
    return { ...payload, closingReason: update.closingReason };
  }
  return payload;
}

export function encodePrivatePositionFrame(update: PrivatePositionUpdate): string {
  return JSON.stringify(freezePrivatePositionUpdate(update));
}

export function encodePrivatePositionsSnapshotFrame(userId: string, positions: readonly PrivatePositionUpdate[]): string {
  return JSON.stringify({
    channel: 'positions',
    type: 'snapshot',
    userId,
    positions: positions.map((row) => freezePrivatePositionUpdate(row)),
  });
}

/** Reject live-zero blotters and keys outside the frozen catalog. */
export function assertPrivatePositionWireHonest(value: unknown): void {
  if (isLiveZeroBlotterPayload(value)) {
    throw new Error('ws-private: refused invented positions blotter on wire');
  }
  if (value === null || typeof value !== 'object') return;
  const rec = value as Record<string, unknown>;
  if (rec.channel !== 'positions') return;
  if (rec.type === 'snapshot') {
    assertPrivatePositionSnapshotHonest(rec);
    return;
  }
  assertPrivatePositionRowHonest(rec);
}

function assertPrivatePositionSnapshotHonest(rec: Record<string, unknown>): void {
  for (const key of Object.keys(rec)) {
    if (!PRIVATE_POSITION_SNAPSHOT_ENVELOPE_KEYS.has(key)) {
      throw new Error(`ws-private: unknown position wire key ${key}`);
    }
  }
  if (!Array.isArray(rec.positions)) {
    throw new Error('ws-private: positions snapshot must be an array');
  }
  for (const row of rec.positions) {
    assertPrivatePositionRowHonest(row);
  }
}

function assertPrivatePositionRowHonest(row: unknown): void {
  if (row === null || typeof row !== 'object') {
    throw new Error('ws-private: position row must be an object');
  }
  const rec = row as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (key === 'channel') continue;
    if (!PRIVATE_POSITION_WIRE_KEY_SET.has(key)) {
      throw new Error(`ws-private: unknown position wire key ${key}`);
    }
  }
}
