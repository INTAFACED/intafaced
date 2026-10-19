import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Resource } from '../../shared/resource';
import type { Destination } from './contracts';

type Held = { assets: { assetId: string; available: string }[]; spaces: never[]; holdings: never[] };
let resource: Resource<Held> = { status: 'loading' };
vi.mock('./holdings', () => ({ useHoldings: () => ({ resource, reload: () => undefined }) }));
let book: Resource<Destination[]> = { status: 'loading' };
vi.mock('./components', async (original) => {
  const real = await original<typeof import('./components')>();
  return { ...real, useBankRead: () => ({ resource: book, reload: () => undefined }) };
});
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { WithdrawForm } from './WithdrawForm';
import { AddressBook, AddressTable, WithdrawalAddresses } from './WithdrawalAddresses';

const ready = (...assets: Held['assets']): Resource<Held> => ({ status: 'ready', data: { assets, spaces: [], holdings: [] } });
const off = (html: string, label: string) => expect(html).toMatch(new RegExp(`<button[^>]*disabled[^>]*>${label}</button>`));

beforeEach(() => {
  resource = ready({ assetId: 'USDT', available: '569.015372' }, { assetId: 'BTC', available: '0.0010999' });
  book = { status: 'ready', data: [] };
});

describe('Withdraw leads with the whole form, and every way to send is off with its reason', () => {
  it('shows asset, network, saved address, new address, amount, fee and review', () => {
    const html = renderToStaticMarkup(<WithdrawForm />);
    for (const label of ['Asset', 'Network', 'Saved address', 'Or enter a new address', 'Amount', 'Fee', 'Review'])
      expect(html, label).toContain(label);
    expect(html).toMatch(/<option value="USDT"[^>]*>USDT<\/option>/);
    expect(html).toMatch(/<option value="BTC"[^>]*>BTC<\/option>/);
  });
  it('states the available balance exactly as the real read gave it', () => {
    const html = renderToStaticMarkup(<WithdrawForm />);
    expect(html).toContain('Available: 569.015372 USDT');
  });
  it('never invents a fee, a network or a saved address', () => {
    const html = renderToStaticMarkup(<WithdrawForm />);
    expect(html).toContain('Fee shown before you confirm');
    expect(html).toContain('No networks available');
    expect(html).toContain('No saved addresses yet');
    expect(html).toMatch(/<select[^>]*disabled[^>]*aria-describedby="withdraw-network-why"/);
    expect(html).toMatch(/<select[^>]*disabled[^>]*aria-describedby="withdraw-saved-why"/);
  });
  it('turns the review button off and says why beside it', () => {
    const html = renderToStaticMarkup(<WithdrawForm />);
    off(html, 'Review withdrawal');
    expect(html).toContain('isn’t connected');
    expect(html).toContain('Sending money out of INTAFACED');
    expect(html.toLowerCase()).not.toContain('coming soon');
  });
  it('still shows every field while balances load, and says when there is nothing to send', () => {
    resource = { status: 'loading' };
    const loading = renderToStaticMarkup(<WithdrawForm />);
    expect(loading).toContain('Amount');
    off(loading, 'Review withdrawal');
    resource = ready();
    const empty = renderToStaticMarkup(<WithdrawForm />);
    expect(empty).toContain('You have no funds to send yet.');
    off(empty, 'Review withdrawal');
  });
});

const FULL = '0x52908400098527886E0F7030069857D2E4169EE7';
const NOW = Date.parse('2026-10-18T00:00:00Z');
const row = (over: Partial<Destination> = {}): Destination => ({
  destinationId: '11111111-1111-4111-8111-111111111111',
  label: 'Test wallet',
  kind: 'crypto',
  ref: FULL,
  addedAt: '2026-10-17T10:00:00Z',
  coolingOffEndsAt: '2026-10-19T10:00:00Z',
  coolingBlocker: null,
  ...over,
});

describe('Withdrawal addresses reads the bank address book; saving stays off for its real reason', () => {
  it('draws the columns and an honest empty state when the book has no addresses', () => {
    const html = renderToStaticMarkup(<WithdrawalAddresses />);
    for (const column of ['Label', 'Type', 'Address', 'First saved', 'Cooling-off', 'Details']) expect(html).toContain(`>${column}</th>`);
    expect(html).toContain('No saved addresses');
    expect(html).toContain('You have no saved withdrawal addresses.');
    expect(html).not.toContain('No saved addresses yet');
    expect(html).toContain('Add an address');
    off(html, 'Save address');
    expect(html).toContain('isn’t connected');
    expect(html.toLowerCase()).not.toContain('coming soon');
  });
  it('shows loading while the read is in flight, with no rows and no empty claim', () => {
    book = { status: 'loading' };
    const html = renderToStaticMarkup(<WithdrawalAddresses />);
    expect(html).not.toContain('You have no saved withdrawal addresses.');
    expect(html).not.toContain('<tr><td');
  });
  it('lists the rows the read returned on the page', () => {
    book = { status: 'ready', data: [row()] };
    const html = renderToStaticMarkup(<WithdrawalAddresses />);
    expect(html).toContain('Test wallet');
    expect(html).toContain('0x5290…9EE7');
    expect(html).not.toContain('You have no saved withdrawal addresses.');
    off(html, 'Save address');
  });
  it('shortens an address in its row (first six, last four) and keeps the full one under Details', () => {
    const html = renderToStaticMarkup(<AddressTable rows={[row()]} now={NOW} />);
    expect(html).toContain('Test wallet');
    expect(html).toContain('Crypto wallet');
    expect(html).toContain('0x5290…9EE7');
    expect(html).toContain('<summary>Details</summary>');
    expect(html).toContain(FULL);
    expect(html).not.toContain('No saved addresses');
  });
  it('names a bank account, and says so when a row has no label', () => {
    const html = renderToStaticMarkup(
      <AddressTable rows={[row({ kind: 'bank', label: null, ref: 'DE89370400440532013000' })]} now={NOW} />,
    );
    expect(html).toContain('Bank account');
    expect(html).toContain('No label');
    expect(html).toContain('DE8937…3000');
  });
  it('states the cooling-off only from what the bank returned', () => {
    const ends = renderToStaticMarkup(<AddressTable rows={[row()]} now={NOW} />);
    expect(ends).toMatch(/Ends [^<]*19 Oct/);
    const ended = renderToStaticMarkup(<AddressTable rows={[row({ coolingOffEndsAt: '2026-10-17T12:00:00Z' })]} now={NOW} />);
    expect(ended).toMatch(/Ended [^<]*17 Oct/);
    const unset = renderToStaticMarkup(
      <AddressTable rows={[row({ coolingOffEndsAt: null, coolingBlocker: 'bank.offramp_cooling_unset' })]} now={NOW} />,
    );
    expect(unset).toContain('No cooling-off period is published');
    expect(unset).not.toMatch(/Ends |Ended |24/);
  });
  it('shows a refusal through the shared refusal words, never a raw code, and keeps the add form', () => {
    book = {
      status: 'failed',
      failure: { ok: false, reason: 'error', status: 403, code: 'auth.forbidden', message: 'auth.forbidden' } as never,
    };
    const html = renderToStaticMarkup(<WithdrawalAddresses />);
    expect(html).toContain('class="failure"');
    expect(html).not.toContain('auth.forbidden</');
    expect(html).not.toContain('You have no saved withdrawal addresses.');
    expect(html).toContain('Add an address');
  });
  it('shows the service-unavailable answer in plain words when the read is not mounted', () => {
    const html = renderToStaticMarkup(
      <AddressBook
        resource={{
          status: 'failed',
          failure: { ok: false, reason: 'not_mounted', status: 404, code: 'not_mounted', message: 'x' } as never,
        }}
        reload={() => undefined}
      />,
    );
    expect(html).toContain('class="failure"');
    expect(html).not.toContain('You have no saved withdrawal addresses.');
  });
});
