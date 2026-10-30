import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KNOWN_ROOM_CODES, roomRefusal } from './refusals';

const failure = (
  code: string | undefined,
  message = 'DIRECTION §8 / D26-P0-02 leader_share_bps is owner-only',
  reason: 'error' | 'uncertain' = 'error',
) => ({ ok: false as const, reason, message, ...(code ? { code } : {}) });

describe('roomRefusal', () => {
  it('maps every copy and algo code the service throws', () => {
    const service = readFileSync(new URL('../../../../../../services/svc-trade/src/copy/errors.ts', import.meta.url), 'utf8');
    const copyCodes = [...service.matchAll(/'(trade\.copy_[a-z_]+)'/g)].map((m) => m[1]!);
    expect(copyCodes.length).toBeGreaterThan(25);
    for (const code of new Set(copyCodes)) expect(KNOWN_ROOM_CODES, code).toContain(code);
  });
  it('maps every grid code the service throws, and the bot verification codes', () => {
    const service = readFileSync(new URL('../../../../../../services/svc-trade/src/grid/errors.ts', import.meta.url), 'utf8');
    const gridCodes = [...service.matchAll(/'(trade\.grid_[a-z_]+)'/g)].map((m) => m[1]!);
    expect(gridCodes.length).toBeGreaterThan(15);
    for (const code of [...new Set(gridCodes), 'trade.bots_verification_insufficient', 'trade.bots_verification_level_not_set'])
      expect(KNOWN_ROOM_CODES, code).toContain(code);
  });
  it('never repeats the service sentence', () => {
    const shown = roomRefusal(failure('trade.copy_jurisdiction_blank'));
    expect(JSON.stringify(shown)).not.toMatch(/DIRECTION|D26-P0|leader_share_bps|owner-only|residual/i);
    const unknown = roomRefusal(failure('trade.some_new_code'));
    expect(JSON.stringify(unknown)).not.toMatch(/DIRECTION|D26-P0|leader_share_bps|owner-only/i);
  });
  it('has plain words for the algo creation-gate codes', () => {
    for (const code of [
      'trade.algo_insufficient_balance',
      'trade.algo_balance_unreadable',
      'trade.algo_price_band',
      'trade.algo_volume_immature',
      'trade.algo_mark_policy_unset',
      'trade.fee_schedule_blank',
    ]) {
      const shown = roomRefusal(failure(code, 'AlgoMarkPolicy.maxAgeSeconds is unset — TRADE_FEE_SCHEDULE'));
      expect(shown.title.length, code).toBeGreaterThan(0);
      expect(JSON.stringify(shown), code).not.toMatch(/AlgoMarkPolicy|TRADE_FEE_SCHEDULE|unset —/);
    }
  });
  it('says a lost reply is unknown, not failed', () => {
    expect(roomRefusal(failure(undefined, 'x', 'uncertain')).title).toMatch(/can’t tell/);
  });
});

describe('screens never print a service sentence', () => {
  it('has no .residual, .statusLine or .message rendered from a service reply', () => {
    const dir = new URL('./', import.meta.url);
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.tsx'))) {
      const text = readFileSync(new URL(file, dir), 'utf8');
      expect(text, file).not.toMatch(/\.(residual|statusLine|residuals)\b/);
      expect(text, file).not.toMatch(/failure\.message|result\.message|\.message\}/);
    }
  });
});
