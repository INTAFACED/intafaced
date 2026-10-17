import { renderToString } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { RefundHistoryView, refundHref } from './Refunds';
import type { Payment, PaymentEvent } from './schemas';
import { parsePortalRoute } from './routes';
const payment: Payment = {
  id: '11111111-1111-4111-8111-111111111111',
  merchantId: '22222222-2222-4222-8222-222222222222',
  profileId: null,
  amount: '9007199254740993.000000000000000001',
  capturedAmount: '9007199254740993.000000000000000001',
  refundedAmount: '0.000000000000000001',
  assetId: 'USDT',
  method: 'TEST',
  railAdapter: 'TEST',
  railRef: null,
  status: 'captured',
  createdAt: '2026-10-16T00:00:00Z',
};
const event = (name: string, refundId: string, amount: string): PaymentEvent => ({
  id: 'TEST',
  event: name,
  payload: { refundId, amount },
  railEventId: null,
  ts: '2026-10-16T00:01:00Z',
});
const render = (history: PaymentEvent[], refundId?: string) =>
  renderToString(
    <RefundHistoryView
      resource={{ status: 'ready', data: { payment, history } }}
      retry={() => {}}
      loadedAt="2026-10-16T00:02:00Z"
      refundId={refundId}
    />,
  );
it('keeps decimal precision, folds the two events into one refund, and never mixes reversed amounts into the completed sum', () => {
  const out = render([
    event('refund.posted', 'TEST-r1', '0.000000000000000001'),
    event('refunded', 'TEST-r1', '0.000000000000000001'),
    event('refund.reversed', 'TEST-r2', '9007199254740993.000000000000000001'),
  ]);
  expect(out).toContain('0.000000000000000001');
  expect(out).toContain('2 refunds shown for this payment.');
  expect(out).toContain('This is not an account-wide list');
});
it('skips a team history row that has no payload when building one refund timeline', () => {
  const team: PaymentEvent = {
    id: 'TEAM',
    event: 'refunded',
    ts: '2026-10-16T00:01:30Z',
    amount: '1',
    assetId: 'USDT',
    failure: null,
  };
  const out = render([event('refunded', 'TEST-r1', '1'), team], 'TEST-r1');
  expect(out.match(/Refund confirmed/g)).toHaveLength(1);
});
it('shows only one exact refund timeline and discloses missing actor and ledger evidence', () => {
  const out = render([event('refunded', 'TEST-r1', '1'), event('refund.reversed', 'TEST-r2', '2')], 'TEST-r1');
  expect(out).toContain('Refund confirmed');
  expect(out).not.toContain('Refund reversed');
  expect(out).toContain('requesting actor');
  expect(out).not.toContain('TEST-r2');
});
it('uses the same unavailable result for unknown refunds', () => {
  expect(render([], 'missing')).toContain('Refund not found');
  expect(render([event('refunded', 'other', '1')], 'missing')).toContain('Refund not found');
});
it('renders loading, retryable failure and empty history', () => {
  expect(renderToString(<RefundHistoryView resource={{ status: 'loading' }} retry={() => {}} loadedAt={null} />)).toContain(
    'aria-busy="true"',
  );
  const out = renderToString(
    <RefundHistoryView
      resource={{ status: 'failed', failure: { ok: false, reason: 'unreachable', message: 'pay.private', status: 503 } }}
      retry={() => {}}
      loadedAt={null}
    />,
  );
  expect(out).toContain('Try again');
  expect(out).not.toContain('pay.private');
  expect(render([])).toContain('No refunds in this history');
});
it('routes refund creation separately from detail and encodes the original payment reference', () => {
  expect(parsePortalRoute('/pay/refunds/new')).toEqual({ room: 'refund-new' });
  expect(parsePortalRoute('/pay/refunds/TEST-r1')).toEqual({ room: 'refund', param: 'TEST-r1' });
  expect(refundHref('payment', 'id/with space')).toBe('/pay/refunds/id%2Fwith%20space?payment=payment');
});
