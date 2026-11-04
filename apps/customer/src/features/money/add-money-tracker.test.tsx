import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { TrackerSteps } from './AddMoney';
import { addMoneyRequestSchema, bankReads, type AddMoneyRequest } from './contracts';

/** J-bank-02 #3, #5: one add-money request from created to credited, each step with when, and the amount credited. */

const ID = '33333333-3333-4333-8333-333333333333';
const request = (patch: Partial<AddMoneyRequest> = {}): AddMoneyRequest =>
  addMoneyRequestSchema.parse({
    requestId: ID,
    assetId: 'USDT',
    amount: '12.345678',
    method: 'pay_by_bank',
    country: 'NL',
    rail: 'rail.bank',
    status: 'pending',
    refusalCode: null,
    onramp: {
      onrampId: ID,
      assetId: 'USDT',
      amount: '12.345678',
      payAmount: '25.691356',
      fee: '1',
      payCurrency: 'EUR',
      status: 'pending_payment',
      hostedUrl: `http://127.0.0.1:14509/test/payin-sim/pay/${ID}`,
      bankInstructions: null,
    },
    createdAt: '2026-11-04T10:00:00.000Z',
    openedAt: '2026-11-04T10:00:01.000Z',
    pendingAt: '2026-11-04T10:00:05.000Z',
    creditedAt: null,
    creditedAmount: null,
    ...patch,
  });

const states = (html: string) => [...html.matchAll(/data-step="(\w+)" data-state="(\w+)"/g)].map((m) => `${m[1]}:${m[2]}`);

describe('the add-money tracker', () => {
  it('pending: created, sent to the page and pending are done, credited not yet, and nothing credited is shown', () => {
    const html = renderToStaticMarkup(<TrackerSteps request={request()} />);
    expect(states(html)).toEqual(['created:done', 'opened:done', 'pending:done', 'credited:todo']);
    expect(html).toContain('Pending: you approved it, the money is on its way');
    expect(html).toContain('Not yet');
    expect(html).toContain('You receive: <span dir="ltr">12.345678 USDT</span>');
    expect(html).not.toContain('tracker-credited');
  });

  it('credited: every step done, and the credited amount is the exact string the bank gave', () => {
    const html = renderToStaticMarkup(
      <TrackerSteps request={request({ status: 'credited', creditedAt: '2026-11-04T10:01:00.000Z', creditedAmount: '12.345678' })} />,
    );
    expect(states(html)).toEqual(['created:done', 'opened:done', 'pending:done', 'credited:done']);
    expect(html).not.toContain('Not yet');
    expect(html).toContain('Credited: 12.345678 USDT');
  });

  it('a step that never happened stays not yet, never given a made-up time', () => {
    const html = renderToStaticMarkup(<TrackerSteps request={request({ status: 'opened', pendingAt: null })} />);
    expect(states(html)).toEqual(['created:done', 'opened:done', 'pending:todo', 'credited:todo']);
    expect(html).toContain('Waiting for your payment');
  });

  it('reads the new states, and refuses a credited amount that is a number', () => {
    expect(
      bankReads['addMoney.request'].parse(request({ status: 'credited', creditedAmount: '20', creditedAt: '2026-11-04T10:01:00.000Z' }))
        .status,
    ).toBe('credited');
    expect(addMoneyRequestSchema.safeParse({ ...request(), creditedAmount: 20 }).success).toBe(false);
  });
});
