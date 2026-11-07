import { describe, expect, it } from 'vitest';
import { payloadHash } from '../admin/common.js';
import {
  NO_PAUSES,
  botOrdersHalted,
  canonicalScope,
  mirrorPausedReason,
  newBotPausedReason,
  pauseApprovalPayload,
  type PauseSnapshot,
} from './platform-pauses.js';

const snapshot = (over: Partial<Record<keyof PauseSnapshot, string[]>>): PauseSnapshot => ({
  leaderUserIds: new Set(over.leaderUserIds ?? []),
  botTypes: new Set(over.botTypes ?? []),
  symbols: new Set(over.symbols ?? []),
  marketIds: new Set(over.marketIds ?? []),
  symbolOfMarket: new Map((over.marketIds ?? []).map((id, i) => [id, over.symbols?.[i] ?? id])),
});

describe('canonicalScope (CB-ops-03)', () => {
  it('makes each scope canonical and refuses anything else by code', () => {
    expect(canonicalScope({ kind: 'symbol', value: ' eth/usdt ' })).toEqual({ kind: 'symbol', value: 'ETH/USDT' });
    expect(canonicalScope({ kind: 'bot_type', value: 'Grid' })).toEqual({ kind: 'bot_type', value: 'grid' });
    expect(canonicalScope({ kind: 'lead', value: ' 3fa2b1 ' })).toEqual({ kind: 'lead', value: '3fa2b1' });
    for (const bad of [
      { kind: 'symbol', value: 'ETHUSDT' },
      { kind: 'bot_type', value: 'dca' },
      { kind: 'lead', value: '' },
      { kind: 'market', value: 'x' },
    ] as const) {
      expect(() => canonicalScope(bad as never)).toThrow(expect.objectContaining({ code: 'copy_bots_scope_invalid' }));
    }
  });
});

describe('the gates read the active pauses', () => {
  it('refuses a mirror for a paused lead or a halted market, and nothing else', () => {
    expect(mirrorPausedReason(NO_PAUSES, 'leader-1', 'm-eth')).toBeNull();
    expect(mirrorPausedReason(snapshot({ leaderUserIds: ['leader-1'] }), 'leader-1', 'm-btc')).toBe(
      'Copying this lead is paused by the platform',
    );
    expect(mirrorPausedReason(snapshot({ leaderUserIds: ['leader-1'] }), 'leader-2', 'm-btc')).toBeNull();
    expect(mirrorPausedReason(snapshot({ symbols: ['ETH/USDT'], marketIds: ['m-eth'] }), 'leader-2', 'm-eth')).toBe(
      'Copying on ETH/USDT is paused by the platform',
    );
    expect(mirrorPausedReason(snapshot({ symbols: ['ETH/USDT'], marketIds: ['m-eth'] }), 'leader-2', 'm-btc')).toBeNull();
    // The copy driver's mirror plan keeps the fill's symbol where the market id goes: a halt on that symbol refuses it.
    expect(mirrorPausedReason(snapshot({ symbols: ['ETH/USDT'], marketIds: ['m-eth'] }), 'leader-2', 'ETH/USDT')).toBe(
      'Copying on ETH/USDT is paused by the platform',
    );
    expect(mirrorPausedReason(snapshot({ symbols: ['ETH/USDT'], marketIds: ['m-eth'] }), 'leader-2', 'ETHUSDT')).toBe(
      'Copying on ETH/USDT is paused by the platform',
    );
    expect(mirrorPausedReason(snapshot({ symbols: ['ETH/USDT'], marketIds: ['m-eth'] }), 'leader-2', 'BTC/USDT')).toBeNull();
  });

  it('refuses a new bot of a paused type or on a halted symbol', () => {
    const grid = snapshot({ botTypes: ['grid'] });
    expect(newBotPausedReason(grid, 'grid', 'BTC/USDT', 'm-btc')).toBe('New grid bots are paused by the platform');
    expect(newBotPausedReason(grid, 'twap', 'BTC/USDT', 'm-btc')).toBeNull();
    const eth = snapshot({ symbols: ['ETH/USDT'], marketIds: ['m-eth'] });
    expect(newBotPausedReason(eth, 'twap', 'ETH/USDT', 'm-eth')).toBe('Bots on ETH/USDT are paused by the platform');
    expect(newBotPausedReason(eth, 'twap', 'BTC/USDT', 'm-btc')).toBeNull();
  });

  it('stops running bots only on a halted symbol, never for a paused type', () => {
    expect(botOrdersHalted(snapshot({ botTypes: ['grid', 'twap'] }), 'BTC/USDT', 'm-btc')).toBe(false);
    expect(botOrdersHalted(snapshot({ symbols: ['ETH/USDT'] }), 'ETH/USDT')).toBe(true);
    expect(botOrdersHalted(snapshot({ marketIds: ['m-eth'] }), 'eth', 'm-eth')).toBe(true);
  });
});

describe('pauseApprovalPayload', () => {
  it('hashes to what the console files the approval with (apps/admin/src/lib/trade-ops/copy-bots-pauses.test.ts pins the same hash)', () => {
    const payload = pauseApprovalPayload({
      requestId: '3f2c1b7a-0d4e-4a5b-9c6d-7e8f9a0b1c2d',
      op: 'pause',
      kind: 'symbol',
      value: 'ETH/USDT',
    });
    expect(payloadHash(payload)).toBe('sha256:e767120e16c80b018b6fabde7b45f1f441fcc0c9ca13c549b63117b8c6349a7c');
    expect(pauseApprovalPayload({ requestId: 'r', op: 'resume', kind: 'lead', value: 'x' }).actionType).toBe('trade.copy_bots_resume');
  });
});
