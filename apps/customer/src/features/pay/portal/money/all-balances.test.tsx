import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import type { Resource } from '../../../../shared/resource';
import { AllBalances } from './AllBalances';
import { settlementAssetsSchema, type SettlementAssets } from './settlement-assets-api';

// TEST DATA written for these tests: no real merchant or amount.
const MERCHANT = '11111111-1111-4111-8111-111111111111';
const read = (assets: SettlementAssets['assets']): Resource<SettlementAssets> => ({
  status: 'ready',
  data: { merchantId: MERCHANT, asOf: '2026-10-30T12:00:00.000Z', assets },
});
const zero = (assetCode: string) => ({ assetCode, clearing: '0', available: '0' });
const draw = (held: SettlementAssets['assets'], enabled: Resource<SettlementAssets>) =>
  renderToString(<AllBalances held={held} enabled={enabled} retry={() => undefined} test={false} />);
/** The table's body rows, as the text of each cell. */
const rowsOf = (html: string) =>
  [...html.matchAll(/<tr[^>]*>(.*?)<\/tr>/g)]
    .map((m) =>
      [...m[1]!.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((c) =>
        c[1]!
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;|\s+/g, ' ')
          .trim(),
      ),
    )
    .filter((cells) => cells.length > 0);

describe('All balances on Money (J-merchant-07 #1)', () => {
  it('a new business: one row per asset it settles in, each reading the ledger’s zero', () => {
    const out = draw([], read([zero('USDT'), zero('EUR')]));
    expect(out).toContain('All balances');
    const rows = rowsOf(out);
    expect(rows.map((r) => r[0])).toEqual(['USDT', 'EUR']);
    for (const [, available, clearing] of rows) {
      expect(available).toMatch(/^0(\.0+)?\s/);
      expect(clearing).toMatch(/^0(\.0+)?\s/);
    }
  });

  it('a held asset keeps its own figures; an enabled asset with nothing yet is added once, at zero', () => {
    const out = draw([{ assetCode: 'USDT', clearing: '40', available: '0' }], read([zero('USDT'), zero('ETH')]));
    const rows = rowsOf(out);
    expect(rows.map((r) => r[0])).toEqual(['USDT', 'ETH']);
    expect(rows[0]![2]).toMatch(/^40(\.0+)?\s/);
  });

  it('a list that is not set is a refusal in words, with no row and no zero', () => {
    const out = draw([], {
      status: 'failed',
      failure: { ok: false, reason: 'error', code: 'pay.settlement_assets_unset', message: 'pay.settlement_assets_unset' },
    });
    expect(out).toContain('No list of the assets your account settles in is set');
    expect(out).not.toContain('pay.settlement_assets_unset');
    expect(rowsOf(out)).toEqual([]);
    expect(out).not.toMatch(/>0(\.0+)?</);
  });

  it('an unreadable balance is never a zero', () => {
    const out = draw([], {
      status: 'failed',
      failure: { ok: false, reason: 'error', code: 'pay.metrics_balance_unavailable', message: 'pay.metrics_balance_unavailable' },
    });
    expect(out).toContain('We can’t show your balances right now.');
    expect(rowsOf(out)).toEqual([]);
    expect(out).not.toMatch(/>0(\.0+)?</);
  });

  it('parses the service read, and refuses an empty list (blank is a refusal, never an empty answer)', () => {
    const wire = { merchantId: MERCHANT, asOf: '2026-10-30T12:00:00.000Z', assets: [zero('USDT')] };
    expect(settlementAssetsSchema.safeParse(wire).success).toBe(true);
    expect(settlementAssetsSchema.safeParse({ ...wire, assets: [] }).success).toBe(false);
    expect(settlementAssetsSchema.safeParse({ ...wire, assets: [{ assetCode: 'USDT', clearing: '0.5e1', available: '0' }] }).success).toBe(
      false,
    );
  });
});
