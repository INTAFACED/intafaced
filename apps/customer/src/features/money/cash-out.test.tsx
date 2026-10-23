import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { BlockerWords, QuoteView, RequestRows } from './CashOut';
import { bankReads, type CashOutQuote } from './contracts';

/** BK-ord-01 screen half (J-bank-03 #1-#3): the cash-out quote with what stands in the way, and the kept requests. */

// TEST fixture: a well-known example IBAN, masked as the bank masks it; not a customer's account.
const quote = (patch: Partial<CashOutQuote> = {}): CashOutQuote => ({
  assetId: 'USDT',
  amount: '20',
  available: '50',
  account: {
    accountId: '0f4a2b8e-1c3d-4e5f-8a9b-0c1d2e3f4a5b',
    label: 'TEST salary account',
    holderName: 'TEST Holder',
    ibanMasked: 'GB82 •••• 5432',
    country: 'GB',
    state: 'unverified',
    usable: false,
    blocker: 'bank.linked_account_unverified',
    verificationRail: 'rail.bank',
    linkedAt: '2026-10-23T03:00:00.000Z',
    coolingOffEndsAt: '2026-10-24T03:00:00.000Z',
  },
  rail: 'rail.bank',
  fee: null,
  receiveAmount: null,
  blocker: 'bank.linked_account_unverified',
  ...patch,
});

describe('cash out to a linked bank account', () => {
  it('shows the amount and the available balance, a fee and arrival "not set", and the account as the reason', () => {
    const html = renderToStaticMarkup(<QuoteView quote={quote()} />);
    expect(html).toContain('Available now');
    expect(html).toContain('TEST salary account (GB82 •••• 5432)');
    expect(html.match(/not set/g)).toHaveLength(2);
    expect(html).toContain(
      'This account is unverified. Only a banking partner can verify it, and rail.bank is switched off in this build.',
    );
    expect(html).toContain('Reference: bank.linked_account_unverified');
    expect(html).not.toContain('WEST');
  });

  it('names each reason in the customer’s words, and an unknown one plainly with its code', () => {
    const words = (code: string, end: string | null = null) =>
      renderToStaticMarkup(<BlockerWords code={code} rail="rail.bank" coolingOffEndsAt={end} />);
    expect(words('bank.offramp_cooling_unset')).toContain('no cooling-off period');
    expect(words('bank.offramp_cooling_active', '2026-10-24T03:00:00.000Z')).toMatch(/from .+, when its cooling-off ends/);
    expect(words('bank.fiat_ramp_socket')).toContain('No banking partner pays out to bank accounts: rail.bank is switched off');
    expect(words('bank.something_new')).toContain(
      'This cash-out cannot go ahead. <small class="muted">Reference: bank.something_new</small>',
    );
  });

  it('lists each kept request as not sent, with its amount, rail and reason', () => {
    const html = renderToStaticMarkup(
      <RequestRows
        rows={[
          {
            requestId: '6a1f0c2e-3b4d-4e5f-8a9b-1c2d3e4f5a6b',
            assetId: 'USDT',
            amount: '20',
            linkedAccountId: '0f4a2b8e-1c3d-4e5f-8a9b-0c1d2e3f4a5b',
            rail: 'rail.bank',
            status: 'refused',
            refusalCode: 'bank.linked_account_unverified',
            createdAt: '2026-10-23T04:00:00.000Z',
          },
        ]}
      />,
    );
    expect(html).toContain('Not sent');
    expect(html).toContain('rail.bank · Reference: bank.linked_account_unverified');
    expect(renderToStaticMarkup(<RequestRows rows={[]} />)).toContain('You have not asked to cash out.');
  });

  it('parses the bank’s answers, and refuses a fee that is not a decimal string', () => {
    expect(bankReads['cashOut.quote'].parse(quote())).toMatchObject({ fee: null, receiveAmount: null });
    expect(bankReads['cashOut.quote'].safeParse({ ...quote(), fee: 1.5 }).success).toBe(false);
    expect(bankReads['cashOut.requests'].safeParse([{ status: 'held' }]).success).toBe(false);
  });
});
