import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { IncomingRows, IncomingRules } from './IncomingPayments';
import { bankReads, type IncomingLine } from './contracts';

/** BK-acct-02 incoming half (J-bank-02 #7): money that came in, with timing, availability, returns and refusals in plain words. */

const line = (patch: Partial<IncomingLine> = {}): IncomingLine => ({
  id: 'line-1',
  kind: 'welcome_funds',
  direction: 'in',
  asset: 'USDT',
  amount: '50',
  postedAt: '2026-10-23T04:00:00.000Z',
  txId: 'tx-1',
  counterparty: null,
  ...patch,
});

describe('incoming payments', () => {
  it('names each line, its amount, when it arrived and that it is available', () => {
    const html = renderToStaticMarkup(
      <IncomingRows
        lines={[
          line(),
          line({ id: 'line-2', kind: 'deposit', amount: '12.5' }),
          line({ id: 'line-3', kind: 'transfer_in', counterparty: { handle: '@ada' } }),
        ]}
      />,
    );
    expect(html).toContain('TEST funds');
    expect(html).toContain('Deposit');
    expect(html).toContain('From @ada');
    expect(html).toContain('12.5');
    expect(html.match(/Available to use since then\./g)).toHaveLength(3);
    expect(html).toMatch(/Arrived .+\./);
  });

  it('says plainly when nothing came in, and the four rules', () => {
    expect(renderToStaticMarkup(<IncomingRows lines={[]} />)).toContain('No money has come into your account yet.');
    const rules = renderToStaticMarkup(<IncomingRules />);
    for (const start of ['When:', 'Available:', 'Returned:', 'Refused:']) expect(rules).toContain(start);
    expect(rules).toContain('It is never taken twice.');
  });

  it('with older lines beyond this page, an empty page is not "nothing ever came in", and points to Activity', () => {
    const html = renderToStaticMarkup(<IncomingRows lines={[]} more />);
    expect(html).toContain('No money came in among your latest activity.');
    expect(html).not.toContain('No money has come into your account yet.');
    expect(html).toContain('href="/uc/record"');
    expect(renderToStaticMarkup(<IncomingRows lines={[line()]} />)).not.toContain('/uc/record');
  });

  it('parses the bank’s page and refuses a number amount or money going out', () => {
    expect(bankReads['activity.list'].parse({ items: [{ ...line(), extra: 1 }], nextCursor: null }).items[0]).not.toHaveProperty('extra');
    expect(bankReads['activity.list'].safeParse({ items: [{ ...line(), amount: 50 }], nextCursor: null }).success).toBe(false);
    expect(bankReads['activity.list'].safeParse({ items: [{ ...line(), direction: 'out' }], nextCursor: null }).success).toBe(false);
    expect(bankReads['activity.list'].safeParse({ items: [{ ...line(), kind: 'order_release' }], nextCursor: null }).success).toBe(false);
  });
});
