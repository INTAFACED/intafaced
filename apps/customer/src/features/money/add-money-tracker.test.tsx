import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { TrackerSteps, walletDeliveryMessage } from './AddMoney';
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
  describe('bought to the wallet (J-dex-protocol-05 #4)', () => {
    it('the message to sign is the one svc-bank checks, byte for byte', () => {
      // The same literal as svc-bank's add-money.db.test.ts: a change on one side alone breaks a test.
      expect(walletDeliveryMessage('AAAAAAAA-0000-4000-8000-000000000000', '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')).toBe(
        [
          'INTAFACED buy to wallet',
          'Request: aaaaaaaa-0000-4000-8000-000000000000',
          'Wallet: 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
          'Signing this proves you control this wallet, so a purchase can be delivered to it. It moves no funds and approves nothing else.',
        ].join('\n'),
      );
    });

    const WALLET = '0x00000000000000000000000000000000000ab0b5';
    const TX = `0x${'ab'.repeat(32)}`;

    it('waiting: the last step is the delivery to the wallet, which names the address, and nothing is credited', () => {
      const html = renderToStaticMarkup(<TrackerSteps request={request({ walletAddress: WALLET })} />);
      expect(states(html)).toEqual(['created:done', 'opened:done', 'pending:done', 'credited:todo']);
      expect(html).toContain('Delivered to your wallet');
      expect(html).toContain(`Your wallet: ${WALLET}`);
      expect(html).toContain('data-state="waiting"');
      expect(html).not.toContain('tracker-credited');
    });

    it('delivered: every step done, the address and the partner’s transfer on chain, and nothing credited here', () => {
      const html = renderToStaticMarkup(
        <TrackerSteps
          request={request({ status: 'delivered', walletAddress: WALLET, deliveredAt: '2026-11-04T10:01:00.000Z', deliveryTx: TX })}
        />,
      );
      expect(states(html)).toEqual(['created:done', 'opened:done', 'pending:done', 'credited:done']);
      expect(html).toContain(`Delivered to ${WALLET}`);
      expect(html).toContain(`href="/chain/tx/${TX}"`);
      expect(html).not.toContain('tracker-credited');
      expect(html).not.toContain('Credited');
    });
  });

  it('pending: created, sent to the page and pending are done, credited not yet, and nothing credited is shown', () => {
    const html = renderToStaticMarkup(<TrackerSteps request={request()} />);
    expect(states(html)).toEqual(['created:done', 'opened:done', 'pending:done', 'credited:todo']);
    expect(html).toContain('Pending: you approved it, the money is on its way');
    expect(html).toContain('Waiting');
    expect(html).toContain('You receive: <span dir="ltr">12.345678 USDT</span>');
    expect(html).not.toContain('tracker-credited');
  });

  it('credited: every step done, and the credited amount is the exact string the bank gave', () => {
    const html = renderToStaticMarkup(
      <TrackerSteps request={request({ status: 'credited', creditedAt: '2026-11-04T10:01:00.000Z', creditedAmount: '12.345678' })} />,
    );
    expect(states(html)).toEqual(['created:done', 'opened:done', 'pending:done', 'credited:done']);
    expect(html).not.toContain('Waiting');
    expect(html).toContain('Credited: 12.345678 USDT');
  });

  it('a step that never happened stays not yet, never given a made-up time', () => {
    const html = renderToStaticMarkup(<TrackerSteps request={request({ status: 'opened', pendingAt: null })} />);
    expect(states(html)).toEqual(['created:done', 'opened:done', 'pending:todo', 'credited:todo']);
    expect(html).toContain('Waiting for your payment');
  });

  it('credited without the partner ever saying the payer approved: pending reads as not reported, with no time', () => {
    const html = renderToStaticMarkup(
      <TrackerSteps
        request={request({ status: 'credited', pendingAt: null, creditedAt: '2026-11-04T10:01:00.000Z', creditedAmount: '12.345678' })}
      />,
    );
    expect(states(html)).toEqual(['created:done', 'opened:done', 'pending:skipped', 'credited:done']);
    expect(html).toContain('Not reported by the partner');
    expect(html).not.toContain('Waiting');
  });

  it('returned: the credit stays shown, and the return says it was taken out once, as the partner reported, with when', () => {
    const html = renderToStaticMarkup(
      <TrackerSteps
        request={request({
          status: 'returned',
          creditedAt: '2026-11-04T10:01:00.000Z',
          creditedAmount: '12.345678',
          returnedAt: '2026-11-04T11:00:00.000Z',
        })}
      />,
    );
    expect(states(html)).toEqual(['created:done', 'opened:done', 'pending:done', 'credited:done']);
    expect(html).toContain('Returned by the partner');
    expect(html).toContain('Credited: 12.345678 USDT');
    expect(html).toMatch(/Returned: 12\.345678 USDT was sent back and taken out of your balance once, as the partner reported, .+\./);
    expect(renderToStaticMarkup(<TrackerSteps request={request()} />)).not.toContain('tracker-returned');
  });

  it('reads the new states, and refuses a credited amount that is a number', () => {
    expect(
      bankReads['addMoney.request'].parse(request({ status: 'credited', creditedAmount: '20', creditedAt: '2026-11-04T10:01:00.000Z' }))
        .status,
    ).toBe('credited');
    expect(addMoneyRequestSchema.safeParse({ ...request(), creditedAmount: 20 }).success).toBe(false);
  });
});
