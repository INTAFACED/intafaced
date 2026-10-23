import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Resource } from '../../shared/resource';
import type { Destination, WithdrawAsset } from './contracts';

type Held = { assets: { assetId: string; available: string }[]; spaces: never[]; holdings: never[] };
let resource: Resource<Held> = { status: 'loading' };
vi.mock('./holdings', () => ({ useHoldings: () => ({ resource, reload: () => undefined }) }));
let book: Resource<Destination[]> = { status: 'loading' };
let networks: Resource<WithdrawAsset[]> = { status: 'loading' };
vi.mock('./components', async (original) => {
  const real = await original<typeof import('./components')>();
  return {
    ...real,
    useBankRead: (procedure: string) => ({
      resource: procedure === 'ramps.destinations.networks' ? networks : book,
      reload: () => undefined,
    }),
  };
});
vi.mock('../session/session', () => ({ useSession: () => ({ userId: 'u1', api: {} }) }));
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { WithdrawForm } from './WithdrawForm';
import { AddressBook, AddressTable, WithdrawalAddresses, readinessWords } from './WithdrawalAddresses';
import { withdrawalCopy } from './withdrawal-copy';

const ready = (...assets: Held['assets']): Resource<Held> => ({ status: 'ready', data: { assets, spaces: [], holdings: [] } });
const off = (html: string, label: string) => expect(html).toMatch(new RegExp(`<button[^>]*disabled[^>]*>${label}</button>`));

beforeEach(() => {
  resource = ready({ assetId: 'USDT', available: '569.015372' }, { assetId: 'BTC', available: '0.0010999' });
  book = { status: 'ready', data: [] };
  networks = {
    status: 'ready',
    data: [{ assetId: 'USDT', precision: 6, networks: [{ networkId: 'ethereum', label: 'TEST Ethereum' }], defaultNetworkId: 'ethereum' }],
  };
});

const WALLET = '0x52908400098527886E0F7030069857D2E4169EE7';
const saved = (over: Partial<Destination> = {}): Destination => ({
  destinationId: '22222222-2222-4222-8222-222222222222',
  label: 'Cold wallet',
  kind: 'crypto',
  ref: WALLET,
  addedAt: '2026-10-01T10:00:00Z',
  coolingOffEndsAt: '2026-10-02T10:00:00Z',
  coolingBlocker: null,
  assetId: 'USDT',
  network: 'ethereum',
  state: 'active',
  ...over,
});

describe('Withdraw leads with the whole form, read from the real catalogue, address book and balances', () => {
  it('shows asset, the networks the asset list opens with its default chosen, saved address, amount, limit, fee and review', () => {
    networks = {
      status: 'ready',
      data: [
        {
          assetId: 'USDT',
          precision: 6,
          networks: [
            { networkId: 'ethereum', label: 'TEST Ethereum' },
            { networkId: 'base', label: 'TEST Base' },
          ],
          defaultNetworkId: 'base',
        },
      ],
    };
    const html = renderToStaticMarkup(<WithdrawForm />);
    for (const label of ['Asset', 'Network', 'Saved address', 'Or enter a new address', 'Amount', 'Your limit', 'Fee', 'Review'])
      expect(html, label).toContain(label);
    expect(html).toMatch(/<option value="USDT"[^>]*>USDT<\/option>/);
    expect(html).toMatch(/<option value="BTC"[^>]*>BTC<\/option>/);
    expect(html).toMatch(/<option value="base" selected="">TEST Base<\/option>/);
    expect(html).toMatch(/<option value="ethereum">TEST Ethereum<\/option>/);
  });
  it('states the available balance exactly as the real read gave it', () => {
    const html = renderToStaticMarkup(<WithdrawForm />);
    expect(html).toContain('Available: 569.015372 USDT');
  });
  it('never invents a fee, a network or a saved address', () => {
    networks = { status: 'ready', data: [] };
    const html = renderToStaticMarkup(<WithdrawForm />);
    expect(html).toContain('Get the fee to see it');
    expect(html).toContain('No network is open for this asset');
    expect(html).toContain('No saved address for this asset and network');
    expect(html).toMatch(/<select[^>]*disabled[^>]*aria-describedby="withdraw-network-why"/);
    expect(html).toMatch(/<select[^>]*disabled[^>]*aria-describedby="withdraw-saved-why"/);
  });
  it('offers only saved wallets for this asset and network, and only a ready one can be chosen', () => {
    book = {
      status: 'ready',
      data: [
        saved(),
        saved({ destinationId: '33333333-3333-4333-8333-333333333333', label: 'New wallet', coolingOffEndsAt: '2999-01-01T00:00:00Z' }),
        saved({ destinationId: '44444444-4444-4444-8444-444444444444', label: 'Base wallet', network: 'base' }),
        saved({ destinationId: '55555555-5555-4555-8555-555555555555', label: 'Gone', state: 'archived' }),
      ],
    };
    const html = renderToStaticMarkup(<WithdrawForm />);
    expect(html).toMatch(/<option value="22222222-[^"]*">Cold wallet · 0x5290…9EE7 · Ready to use<\/option>/);
    expect(html).toMatch(/<option value="33333333-[^"]*" disabled="">New wallet · 0x5290…9EE7 · Cooling off<\/option>/);
    expect(html).not.toContain('Base wallet');
    expect(html).not.toContain('Gone');
  });
  it('keeps confirm off with its reason until a ready address, an amount and a fee are in hand', () => {
    const html = renderToStaticMarkup(<WithdrawForm />);
    off(html, 'Review withdrawal');
    expect(html).toContain('get the fee first');
    off(html, 'Get the fee');
    expect(html.toLowerCase()).not.toContain('coming soon');
    expect(html).not.toContain('isn’t connected');
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

describe('Withdrawal addresses: the bank address book, and saving to it with a confirmation', () => {
  it('draws the columns and an honest empty state when the book has no addresses', () => {
    const html = renderToStaticMarkup(<WithdrawalAddresses />);
    for (const column of ['Label', 'Type', 'Address', 'First saved', 'Cooling-off', 'Details']) expect(html).toContain(`>${column}</th>`);
    expect(html).toContain('No saved addresses');
    expect(html).toContain('You have no saved withdrawal addresses.');
    expect(html).not.toContain('No saved addresses yet');
    expect(html.toLowerCase()).not.toContain('coming soon');
  });
  it('offers the add form with the assets the bank lists, and a save button that is on', () => {
    const html = renderToStaticMarkup(<WithdrawalAddresses />);
    expect(html).toContain('Add an address');
    expect(html).toMatch(/<option value="USDT"[^>]*>USDT<\/option>/);
    expect(html).toContain('Choose an asset first');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Save address<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Save address<\/button>/);
    expect(html).not.toContain('isn’t connected');
  });
  it('says plainly when no asset is open for withdrawals, and offers no form', () => {
    networks = { status: 'ready', data: [] };
    const html = renderToStaticMarkup(<WithdrawalAddresses />);
    expect(html).toContain('No asset is open for withdrawals');
    expect(html).not.toContain('>Save address<');
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
    expect(html).toContain('>Remove</button>');
    expect(html).not.toContain('You have no saved withdrawal addresses.');
  });
  it('shows an active entry as cooling off until its cooling-off ends', () => {
    const cooling = renderToStaticMarkup(<AddressTable rows={[row({ state: 'active' })]} now={NOW} />);
    expect(cooling).toContain('Cooling off');
    expect(cooling).not.toContain('Ready to use');
    const ready = renderToStaticMarkup(
      <AddressTable rows={[row({ state: 'active', coolingOffEndsAt: '2026-10-17T12:00:00Z' })]} now={NOW} />,
    );
    expect(ready).toContain('Ready to use');
    // No cooling-off published: the bank sends to nothing, so the entry is blocked, never ready.
    const unset = renderToStaticMarkup(
      <AddressTable rows={[row({ state: 'active', coolingOffEndsAt: null, coolingBlocker: 'bank.offramp_cooling_unset' })]} now={NOW} />,
    );
    expect(unset).toContain('No cooling-off period is published');
    expect(unset).toContain('Blocked');
    expect(unset).not.toContain('Ready to use');
  });
  it('shows a new address as waiting for approval, its cooling-off not started; once approved it reads like any entry', () => {
    const html = renderToStaticMarkup(
      <AddressTable rows={[row({ state: 'pending', origin: 'customer', coolingOffEndsAt: null })]} now={NOW} />,
    );
    expect(html).toContain('Waiting for approval');
    expect(html).toContain('Starts once approved');
    expect(html).not.toContain('No cooling-off period is published');
    // Approved, the entry is `cooling` for good: ready once the cooling-off ended, blocked while none is published.
    expect(renderToStaticMarkup(<AddressTable rows={[row({ state: 'cooling' })]} now={NOW} />)).toContain('Cooling off');
    expect(
      renderToStaticMarkup(<AddressTable rows={[row({ state: 'cooling', coolingOffEndsAt: '2026-10-17T12:00:00Z' })]} now={NOW} />),
    ).toContain('Ready to use');
    expect(
      renderToStaticMarkup(
        <AddressTable rows={[row({ state: 'cooling', coolingOffEndsAt: null, coolingBlocker: 'bank.offramp_cooling_unset' })]} now={NOW} />,
      ),
    ).toContain('Blocked');
  });
  it('says a new address waits for approval before anything can be sent, and where to approve it', () => {
    const { t } = withdrawalCopy.forLocale('en');
    const words = readinessWords(
      { destinationId: 'd', state: 'approval_pending', coolingOffEndsAt: null, lockUnlocksAt: null, approvalLinkExpiresAt: null },
      'Test wallet',
      t,
    );
    expect(words.locked).toBe(false);
    expect(words.text).toContain('Test wallet is waiting for your approval, so nothing can be sent to it.');
    expect(words.text).toContain('Approve it on another device where you are signed in, or ask for an approval link by email and open it');
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
  it('says on an entry that the customer checked it is not a look-alike, and says nothing on any other', () => {
    const checked = renderToStaticMarkup(<AddressTable rows={[row({ lookalikeConfirmedAt: '2026-10-17T12:00:00Z' })]} now={NOW} />);
    expect(checked).toContain('You confirmed the look-alike warning');
    expect(renderToStaticMarkup(<AddressTable rows={[row()]} now={NOW} />)).not.toContain('look-alike');
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
