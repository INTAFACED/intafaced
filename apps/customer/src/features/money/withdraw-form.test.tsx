import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Resource } from '../../shared/resource';

type Held = { assets: { assetId: string; available: string }[]; spaces: never[]; holdings: never[] };
let resource: Resource<Held> = { status: 'loading' };
vi.mock('./holdings', () => ({ useHoldings: () => ({ resource, reload: () => undefined }) }));
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { WithdrawForm } from './WithdrawForm';
import { AddressTable, WithdrawalAddresses } from './WithdrawalAddresses';

const ready = (...assets: Held['assets']): Resource<Held> => ({ status: 'ready', data: { assets, spaces: [], holdings: [] } });
const off = (html: string, label: string) => expect(html).toMatch(new RegExp(`<button[^>]*disabled[^>]*>${label}</button>`));

beforeEach(() => {
  resource = ready({ assetId: 'USDT', available: '569.015372' }, { assetId: 'BTC', available: '0.0010999' });
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

describe('Withdrawal addresses is an address book and an add form, both off for the same real reason', () => {
  it('draws the columns and an honest empty state when there is no address book to read', () => {
    const html = renderToStaticMarkup(<WithdrawalAddresses />);
    for (const column of ['Label', 'Asset', 'Network', 'Address', 'Details']) expect(html).toContain(`>${column}</th>`);
    expect(html).toContain('No saved addresses yet');
    expect(html).toContain('Add an address');
    off(html, 'Save address');
    expect(html).toContain('isn’t connected');
    expect(html.toLowerCase()).not.toContain('coming soon');
  });
  it('shortens a saved address in its row and keeps the full one under Details', () => {
    const full = '0x52908400098527886E0F7030069857D2E4169EE7';
    const html = renderToStaticMarkup(
      <AddressTable rows={[{ id: 'a', label: 'Test wallet', asset: 'USDT', network: 'Test network', address: full }]} />,
    );
    expect(html).toContain('Test wallet');
    expect(html).toContain('0x5290…9EE7');
    expect(html).toContain('<summary>Details</summary>');
    expect(html).toContain(full);
    expect(html).not.toContain('No saved addresses yet');
  });
});
