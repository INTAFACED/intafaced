import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { BOOK_KEYS_MORE_THAN_ONE_PER_MARKET } from './account-mode.js';
import { checkCloseQuantity, planProportionalClose, proportionalCloseFigures } from './desk-quantity.js';
import { unrealizedPnl } from './liquidation-planner.js';

const SCALE = 10n ** 18n;

describe('proportional close', () => {
  it('a 40/60 split sums to the one-shot close, and the remainder keeps 60 percent of the margin', () => {
    const size = parseAmount('1');
    const entry = parseAmount('50000');
    const exit = parseAmount('51000');
    const margin = parseAmount('5000');
    const first = proportionalCloseFigures({
      side: 'long',
      size,
      closeQty: parseAmount('0.4'),
      entryPrice: entry,
      exitPrice: exit,
      margin,
      marginInitial: margin,
    });
    const second = proportionalCloseFigures({
      side: 'long',
      size: first.remainQty,
      closeQty: first.remainQty,
      entryPrice: entry,
      exitPrice: exit,
      margin: first.remainMargin,
      marginInitial: first.remainInitial,
    });
    const full = unrealizedPnl('long', size, entry, exit);
    expect(formatAmount((first.realizedPnl + second.realizedPnl) as Amount)).toBe(formatAmount(full));
    expect(formatAmount(first.realizedPnl)).toBe('400');
    expect(formatAmount(first.remainQty)).toBe('0.6');
    expect(formatAmount(first.remainMargin)).toBe('3000');
    expect(formatAmount(first.marginSlice)).toBe('2000');
    expect(formatAmount((first.marginSlice + second.marginSlice) as Amount)).toBe('5000');
  });

  it('a dusty split still sums to the full-close P&L to the last decimal', () => {
    const size = SCALE;
    const entry = 0n as Amount;
    const exit = 1n as Amount;
    const margin = SCALE;
    const full = unrealizedPnl('long', size, entry, exit);
    const half = (size / 2n) as Amount;
    const first = proportionalCloseFigures({
      side: 'long',
      size,
      closeQty: half,
      entryPrice: entry,
      exitPrice: exit,
      margin,
      marginInitial: margin,
    });
    const second = proportionalCloseFigures({
      side: 'long',
      size: first.remainQty,
      closeQty: first.remainQty,
      entryPrice: entry,
      exitPrice: exit,
      margin: first.remainMargin,
      marginInitial: first.remainInitial,
    });
    expect(full).toBe(1n);
    expect(first.realizedPnl + second.realizedPnl).toBe(full);
  });

  it('quantity equal to the size is the full close', () => {
    const plan = planProportionalClose({
      closeId: 'close:p',
      positionId: 'p',
      userId: 'u',
      side: 'long',
      size: parseAmount('1'),
      closeQty: parseAmount('1'),
      entryPrice: parseAmount('50000'),
      exitPrice: parseAmount('51000'),
      margin: parseAmount('5000'),
      marginInitial: parseAmount('5000'),
      marginAsset: 'USDT',
      releaseSequence: 1,
    });
    expect(plan.close).toBe(true);
    if (!plan.close) return;
    expect(plan.full).toBe(true);
    expect(formatAmount(plan.realizedPnl)).toBe('1000');
  });

  it('refuses zero, negative, above size, off-step, and an unset lot', () => {
    const size = parseAmount('1');
    const lot = parseAmount('0.0001');
    expect(checkCloseQuantity({ quantity: 0n, size, lotSize: lot }).ok).toBe(false);
    expect(checkCloseQuantity({ quantity: -1n as Amount, size, lotSize: lot })).toMatchObject({
      code: 'trade.close_quantity_invalid',
    });
    expect(checkCloseQuantity({ quantity: parseAmount('2'), size, lotSize: lot })).toMatchObject({
      code: 'trade.close_quantity_exceeds_size',
    });
    expect(checkCloseQuantity({ quantity: parseAmount('0.00015'), size, lotSize: lot })).toMatchObject({
      code: 'trade.close_quantity_lot_step',
    });
    expect(checkCloseQuantity({ quantity: parseAmount('0.4'), size, lotSize: null })).toMatchObject({
      code: 'trade.lot_size_unset',
    });
  });
});

describe('the book keys a side', () => {
  it('the open unique index includes side, so hedge is a real mode', () => {
    const sql = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle', '0003_trade_futures_positions.sql'),
      'utf8',
    );
    expect(sql).toMatch(/positions_open_unique_idx"[\s\S]*"side"/);
    expect(BOOK_KEYS_MORE_THAN_ONE_PER_MARKET).toBe(true);
  });
});
