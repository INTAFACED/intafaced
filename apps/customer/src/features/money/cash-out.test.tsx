import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { BlockerWords, QuoteView, RequestRows } from './CashOut';
import { bankReads, type CashOutQuote, type CashOutRequest } from './contracts';

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
  receiveCurrency: null,
  blocker: 'bank.linked_account_unverified',
  standIn: null,
  ...patch,
});

// A request as the bank lists it: refused unless patched.
const request = (patch: Partial<CashOutRequest> = {}): CashOutRequest => ({
  requestId: '6a1f0c2e-3b4d-4e5f-8a9b-1c2d3e4f5a6b',
  assetId: 'USDT',
  amount: '20',
  linkedAccountId: '0f4a2b8e-1c3d-4e5f-8a9b-0c1d2e3f4a5b',
  rail: 'rail.bank',
  status: 'refused',
  refusalCode: 'bank.linked_account_unverified',
  fee: null,
  receiveAmount: null,
  receiveCurrency: null,
  payoutRef: null,
  ledgerTxId: null,
  failureCode: null,
  returnedAmount: null,
  remainsPaidOut: null,
  createdAt: '2026-10-23T04:00:00.000Z',
  completedAt: null,
  failedAt: null,
  returnedAt: null,
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
    const html = renderToStaticMarkup(<RequestRows rows={[request()]} />);
    expect(html).toContain('Not sent');
    expect(html).toContain('rail.bank · Reference: bank.linked_account_unverified');
    expect(renderToStaticMarkup(<RequestRows rows={[]} />)).toContain('You have not asked to cash out.');
  });

  it('a usable account shows the partner’s fee and what arrives in its currency, with the TEST label and no reason', () => {
    const html = renderToStaticMarkup(
      <QuoteView
        quote={quote({ fee: '1.5', receiveAmount: '16.5', receiveCurrency: 'EUR', blocker: null, standIn: 'TEST payout stand-in' })}
      />,
    );
    expect(html).not.toContain('not set');
    expect(html).toMatch(/1\.5.*EUR/);
    expect(html).toMatch(/16\.5.*EUR/);
    expect(html).toContain('TEST price from a stand-in: TEST payout stand-in. No partner pays this out.');
    expect(html).not.toContain('cash-out-blocker');
  });

  it('tracks a cash-out from processing to completed, with a receipt only once it was paid out', () => {
    const processing = renderToStaticMarkup(
      <RequestRows
        rows={[
          request({ status: 'processing', refusalCode: null, payoutRef: 'TEST-PAYOUT-1', receiveAmount: '16.5', receiveCurrency: 'EUR' }),
        ]}
      />,
    );
    expect(processing).toContain('Processing');
    expect(processing).toContain('aria-label="Processing (1/2)"');
    expect(processing).toContain('Bank reference: TEST-PAYOUT-1');
    expect(processing).toContain('cannot be cancelled');
    expect(processing).toContain('The receipt is ready once the bank has paid it out.');
    expect(processing).not.toContain('Download receipt');
    const paid = renderToStaticMarkup(
      <RequestRows rows={[request({ status: 'completed', refusalCode: null, ledgerTxId: 'tx-1', remainsPaidOut: '20' })]} />,
    );
    expect(paid).toContain('aria-label="Completed (2/2)"');
    expect(paid).toContain('Download receipt');
    expect(renderToStaticMarkup(<RequestRows rows={[request()]} />)).toContain('No receipt: this cash-out was not sent.');
  });

  it('says why a payout failed and that the money came back once, and what came back of a returned one', () => {
    const failed = renderToStaticMarkup(
      <RequestRows rows={[request({ status: 'failed', refusalCode: null, failureCode: 'bank.payout_account_closed', amount: '10' })]} />,
    );
    expect(failed).toContain('The receiving bank says this account is closed.');
    expect(failed).toMatch(/10.*USDT is back in your available balance, once\./);
    expect(failed).toContain('No receipt: this cash-out was not paid out.');
    expect(failed).not.toContain('Download receipt');
    const part = renderToStaticMarkup(
      <RequestRows
        rows={[
          request({
            status: 'returned',
            refusalCode: null,
            failureCode: 'bank.payout_returned_by_bank',
            returnedAmount: '5',
            remainsPaidOut: '15',
            ledgerTxId: 'tx-1',
          }),
        ]}
      />,
    );
    expect(part).toContain('Came back');
    expect(part).toMatch(/5.*USDT of 20.*USDT came back to your available balance, once\. The other 15.*USDT stays paid out\./);
    expect(part).toContain('Download receipt');
    const all = renderToStaticMarkup(
      <RequestRows
        rows={[
          request({
            status: 'returned',
            refusalCode: null,
            failureCode: 'bank.payout_returned_account_closed',
            returnedAmount: '20',
            remainsPaidOut: '0',
          }),
        ]}
      />,
    );
    expect(all).toContain('The receiving bank sent it back: the account is closed.');
    expect(all).toMatch(/All 20.*USDT came back/);
  });

  it('parses the bank’s answers, and refuses a fee that is not a decimal string', () => {
    expect(bankReads['cashOut.quote'].parse(quote())).toMatchObject({ fee: null, receiveAmount: null });
    expect(bankReads['cashOut.quote'].safeParse({ ...quote(), fee: 1.5 }).success).toBe(false);
    expect(bankReads['cashOut.requests'].safeParse([{ ...request(), status: 'held' }]).success).toBe(false);
    // An older answer without the payout fields still reads, with them blank.
    const { fee: _fee, payoutRef: _ref, ...older } = request();
    expect(bankReads['cashOut.requests'].parse([older])[0]).toMatchObject({ fee: null, payoutRef: null });
  });
});
