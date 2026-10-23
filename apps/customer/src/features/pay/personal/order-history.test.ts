import { describe, expect, it } from 'vitest';
import { historyRefusal } from './OrderHistory';
import { bpsPercent } from './OrderReceipt';
import { orderHistoryCopy } from './order-history-copy';

const { t } = orderHistoryCopy.forLocale('en');
const refused = (message: string, code = 'BAD_REQUEST') => ({ ok: false as const, reason: 'error' as const, message, code });

describe('order history refusals', () => {
  it('names the range cap the service sent', () => {
    expect(historyRefusal(refused('p2p.export_range_too_large: at most 90 days per file'), t, (iso) => iso)).toBe(
      'Choose at most 90 days per file.',
    );
  });
  it('names the row count and the row cap', () => {
    expect(historyRefusal(refused('p2p.export_too_many_rows: 1200 rows, at most 1000 per file'), t, (iso) => iso)).toBe(
      'This range has 1200 orders and one file holds at most 1000. Choose a shorter range.',
    );
  });
  it('says when a used-up daily receipt quota resets, and that a per-order one does not', () => {
    const daily = refused('p2p.receipt_quota_reached: daily quota 20 used; resets at 2026-10-24T00:00:00.000Z');
    expect(historyRefusal(daily, t, (iso) => `at ${iso}`)).toBe(
      'You have used today’s receipts. You can get more from at 2026-10-24T00:00:00.000Z.',
    );
    const perOrder = refused('p2p.receipt_quota_reached: 5 downloads of this receipt used; does not reset');
    expect(historyRefusal(perOrder, t, (iso) => iso)).toBe('You have downloaded this receipt as many times as allowed.');
  });
  it('names an unset owner value and leaves any other refusal to the shared failure', () => {
    expect(historyRefusal(refused('p2p.config_unset: P2P_EXPORT_MAX_ROWS'), t, (iso) => iso)).toBe(
      'This needs a setting the operator has left blank: P2P_EXPORT_MAX_ROWS.',
    );
    expect(historyRefusal(refused('p2p.trade_not_found'), t, (iso) => iso)).toBeNull();
  });
});

describe('bpsPercent', () => {
  it('writes basis points as an exact percent', () => {
    expect(bpsPercent(0)).toBe('0');
    expect(bpsPercent(25)).toBe('0.25');
    expect(bpsPercent(150)).toBe('1.5');
    expect(bpsPercent(1000)).toBe('10');
  });
});
