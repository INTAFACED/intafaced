import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../../../session/session', () => ({ useSession: () => ({ api: {}, userId: 'TEST-user' }) }));
import type { ApiResult } from '../../../../shared/api';
import type { Resource } from '../../../../shared/resource';
import type { PortalApi } from '../api';
import { useListFilters } from '../ui/FilterRow';
import type { ListState } from '../hooks';
import type { Dispute, MerchantRecord } from '../schemas';
import { DisputesView } from './Disputes';
import { CheckoutSettingsView, HomePanelsView } from './HomePanels';
import { assetChoices } from './asset-choices';
import { definite, neverRan } from './not-available';
import { InvoiceCreate } from './Invoices';
import { successRate } from './model';

// Everything below is TEST DATA written for these tests.
const ready = <T,>(data: T): Resource<T> => ({ status: 'ready', data });
const noop = () => undefined;
const merchant: MerchantRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  mode: 'gateway',
  status: 'active',
  kybStatus: 'approved',
  kybRef: null,
  feeBps: 150,
};
const rails = ready([
  { id: 'crypto-native', mode: 'sandbox' as const, usable: true, healthy: true },
  { id: 'card-sandbox', mode: 'sandbox' as const, usable: true, healthy: true },
]);
const panels = (patch: Partial<Parameters<typeof HomePanelsView>[0]> = {}) =>
  renderToString(
    <HomePanelsView
      merchant={merchant}
      role="owner"
      rails={rails}
      settings={ready({ status: 'not_configured' as const })}
      retryRails={noop}
      retrySettings={noop}
      {...patch}
    />,
  );

describe('Home panels, in plain words', () => {
  it('says status, verification, mode, fee and role as a person would, with no raw service value', () => {
    const out = panels();
    for (const word of [
      'Your account',
      'Active',
      'Approved',
      'Gateway',
      'Fee 1.50% — taken when a payment settles',
      'Owner',
      'Ways customers can pay',
    ])
      expect(out).toContain(word);
    for (const raw of [
      'basis points',
      'crypto-native',
      'card-sandbox',
      'sandbox · usable',
      '>owner<',
      '>active<',
      '>approved<',
      'gateway<',
    ])
      expect(out).not.toContain(raw);
    expect(out).toContain('Crypto transfer');
    expect(out).toContain('Test mode');
    expect(out).toContain('Ready');
  });
  it('shows no lime chip for a completed state: the status chips are the soft ones', () => {
    const out = panels();
    expect(out).toContain('pp-chip pp-chip--done');
    expect(out).not.toMatch(/bg-lime|text-lime|text-accent-text/);
  });
  it('tells one fee story, with the TEST label from the server and no basis points', () => {
    const test = panels({ merchant: { ...merchant, feeBps: 250, starterFee: { bps: 250, source: 'local_test' as const } } });
    expect(test).toContain('Starter fee 2.50% (TEST value) — taken when a payment settles');
    expect(test).not.toMatch(/bps|basis points/i);
    // An account with no rate says so, and nothing else stands in for it: no price list, no claim about a default.
    const none = panels({ merchant: { ...merchant, feeBps: null } });
    expect(none).toContain('No rate is set on your account.');
    expect(none).not.toMatch(/platform default|per payment|1\.5%/);
  });
  it('reads the checkout settings: not set up, or the website addresses it is set up for', () => {
    expect(panels()).toContain('isn’t set up, so customers');
    const configured = panels({
      settings: ready({
        status: 'configured' as const,
        profileId: '33333333-3333-4333-8333-333333333333',
        checkoutConfig: {},
        feeRouting: null,
        domains: ['shop.test.invalid'],
        createdAt: '2026-10-01T00:00:00.000Z',
      }),
    });
    expect(configured).toContain('shop.test.invalid');
    for (const old of ['No current-profile read is published', 'Checkout domains', 'Domains', 'Create checkout profile'])
      expect(configured).not.toContain(old);
  });
  it('names the refusal when a read fails, never a code', () => {
    const out = panels({
      rails: { status: 'failed', failure: { ok: false, reason: 'unreachable', message: 'x', code: 'pay.merchant_ops_unavailable' } },
    });
    expect(out).not.toMatch(/pay\.[a-z_]+/);
  });
});

describe('checkout settings page', () => {
  const view = (settings: Resource<never> | Resource<import('./schemas').CheckoutSettings>) =>
    renderToString(<CheckoutSettingsView settings={settings as never} retry={noop} merchantId={merchant.id} authority={null} />);
  it('shows the current profile from the read, and no "can’t be read yet" card', () => {
    const out = view(
      ready({
        status: 'configured' as const,
        profileId: '33333333-3333-4333-8333-333333333333',
        checkoutConfig: { secret: 'must-not-show' },
        feeRouting: { hidden: 'must-not-show' },
        domains: ['shop.test.invalid', 'pay.test.invalid'],
        createdAt: '2026-10-01T00:00:00.000Z',
      }),
    );
    expect(out).toContain('shop.test.invalid');
    expect(out).toContain('pay.test.invalid');
    expect(out).toContain('33333333-3333-4333-8333-333333333333');
    expect(out).not.toContain('must-not-show');
    expect(out).not.toContain('can’t be read yet');
    expect(out).toContain('Add a checkout');
  });
  it('says plainly when nothing is set up', () => {
    expect(view(ready({ status: 'not_configured' as const }))).toContain('No website addresses set up');
  });
});

describe('a call that never ran', () => {
  const fail = (patch: Partial<Extract<ApiResult<never>, { ok: false }>>): ApiResult<never> => ({
    ok: false,
    reason: 'error',
    message: 'x',
    ...patch,
  });
  it('recognises a gateway that has no such procedure, by status, by reason, by code or by words', () => {
    expect(neverRan(fail({ reason: 'not_mounted', status: 404 }))).toBe(true);
    expect(neverRan(fail({ status: 404 }))).toBe(true);
    expect(neverRan(fail({ code: 'NOT_FOUND', message: 'No "mutation"-procedure on path "x"' }))).toBe(true);
    expect(neverRan(fail({ message: 'No procedure found on path' }))).toBe(true);
  });
  it('does not mistake the service’s own "not found" for it: that answer means the call ran', () => {
    expect(neverRan(fail({ reason: 'not_mounted', status: 404, code: 'pay.subscription_not_found' }))).toBe(false);
    expect(neverRan(fail({ reason: 'uncertain', message: 'The connection ended' }))).toBe(false);
    expect(neverRan({ ok: true, data: 1 })).toBe(false);
  });
  it('turns it into one clear refusal that is never uncertain, and leaves every other result alone', () => {
    const result = definite(fail({ reason: 'not_mounted', status: 404, message: 'No procedure found on path "merchant.createLink"' }));
    expect(result).toMatchObject({ ok: false, reason: 'not_supported' });
    expect(result.ok ? '' : result.message).toBe('This isn’t available right now, so nothing was changed. You can try again later.');
    const uncertain = fail({ reason: 'uncertain', message: 'The connection ended' });
    expect(definite(uncertain)).toBe(uncertain);
    const okResult = { ok: true as const, data: 1 };
    expect(definite(okResult)).toBe(okResult);
  });
});

describe('success rate', () => {
  it('is succeeded over succeeded plus failed, and ignores payments still in progress', () => {
    const rate = successRate([
      { status: 'created', count: 100 },
      { status: 'captured', count: 3 },
      { status: 'settled', count: 3 },
      { status: 'failed', count: 2 },
    ]);
    expect(rate).toEqual({ total: 8, succeeded: 6, failed: 2, pct: 75 });
  });
});

describe('disputes rows', () => {
  const dispute: Dispute = {
    disputeId: 'dsp-0001-aaaa-bbbb',
    paymentId: 'aaaaaaaa-0000-4000-8000-000000000001',
    amount: '49.99',
    assetId: 'USDT',
    reasonCode: 'fraudulent',
    status: 'open',
    openedAt: '2026-10-10T00:00:00.000Z',
    contestedAt: null,
    closedAt: null,
    responseDueAt: null,
    ledgerWire: 'refused',
    ledgerRefuseCode: null,
  };
  function Harness({ items }: { items: Dispute[] }) {
    const filters = useListFilters();
    const list: ListState<Dispute> = { status: 'ready', items, hasMore: false, more: 'idle' };
    return (
      <DisputesView
        summary={{ status: 'loading' } as never}
        list={list}
        filters={filters}
        due=""
        setDue={noop}
        loadMore={noop}
        retry={noop}
      />
    );
  }
  it('names the payment by its reference instead of saying "Open payment", and still links to it', () => {
    const out = renderToString(<Harness items={[dispute]} />);
    expect(out).toContain('Payment aaaaaaaa…');
    expect(out).not.toContain('Open payment');
    expect(out).toContain(`href="/pay/payments/${dispute.paymentId}"`);
  });
});

describe('asset choices', () => {
  it('offers the default and what the account deals in, plus the current pick, sorted and without repeats', () => {
    expect(assetChoices([])).toEqual(['USDT']);
    expect(assetChoices(['USD', 'USDT'], 'EUR')).toEqual(['EUR', 'USD', 'USDT']);
  });
  it('is a select in the invoice form, not free text', () => {
    const out = renderToString(<InvoiceCreate portal={{} as PortalApi} />);
    expect(out).toMatch(/<select>(<option[^>]*>[^<]*<\/option>)+<\/select>/);
    expect(out).toContain('The asset your customer pays in.');
    expect(out).not.toContain('For example USDT');
  });
});

it('says a billing cadence in words, never the raw value', async () => {
  const { cadenceWord } = await import('../../MerchantBilling');
  expect(cadenceWord('daily')).toBe('Daily');
  expect(cadenceWord('weekly')).toBe('Weekly');
  expect(cadenceWord('monthly')).toBe('Monthly');
});
