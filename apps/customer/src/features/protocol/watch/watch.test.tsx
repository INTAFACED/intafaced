import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
const session = { userId: null as string | null };
vi.mock('../../session/session', () => ({ useSession: () => session }));
let list: unknown = { status: 'signed-out' };
vi.mock('./account-lists', () => ({ useAccountAddressWatches: () => ({ list, change: vi.fn() }) }));
import { AddressPage } from './AddressPage';
import { WatchlistPage } from './WatchlistPage';

const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';
const mine = { address: ADDRESS.toLowerCase(), tag: 'TEST cold wallet', note: 'TEST note' };

describe('Address page', () => {
  it('signed out: says the explorer holds no funds, names its blockers and offers sign-in to watch, with no figure', () => {
    session.userId = null;
    list = { status: 'signed-out' };
    const html = renderToStaticMarkup(<AddressPage address={ADDRESS} />);
    expect(html).toContain(`<h1>Address ${ADDRESS}</h1>`);
    expect(html).toContain('This explorer holds no funds');
    expect(html).toContain('aria-label="Summary"');
    expect(html).toContain('aria-label="Transactions"');
    expect(html).toContain('Sign in to keep a private watch');
    expect(html).not.toContain('Watch this address</button>');
    expect(html).not.toMatch(/\$\d/);
  });
  it('signed in: shows only this account’s own watch with its private note, and the watch button', () => {
    session.userId = 'U-1';
    list = { status: 'ready', items: [mine] };
    const html = renderToStaticMarkup(<AddressPage address={ADDRESS} />);
    expect(html).toContain('You watch this address as “TEST cold wallet”.');
    expect(html).toContain('Your note: TEST note');
    expect(html).toMatch(/<button[^>]*>Watch this address<\/button>/);
    list = { status: 'ready', items: [] };
    expect(renderToStaticMarkup(<AddressPage address={ADDRESS} />)).not.toContain('TEST note');
  });
  it('answers a malformed address with not found', () => {
    expect(renderToStaticMarkup(<AddressPage address="0x12" />)).toContain('data-code="protocol.not_found"');
  });
});

describe('Watched addresses', () => {
  it('lists the account’s watches, and an empty list is an empty table with a sentence beside it', () => {
    session.userId = 'U-1';
    list = { status: 'ready', items: [mine] };
    const html = renderToStaticMarkup(<WatchlistPage />);
    expect(html).toContain('aria-label="Your watched addresses"');
    expect(html).toContain('TEST cold wallet');
    list = { status: 'ready', items: [] };
    const empty = renderToStaticMarkup(<WatchlistPage />);
    expect(empty).not.toContain('<td');
    expect(empty).toContain('You are not watching any address.');
  });
  it('signed out asks to sign in and reads nothing', () => {
    session.userId = null;
    list = { status: 'signed-out' };
    expect(renderToStaticMarkup(<WatchlistPage />)).toContain('Sign in to see the addresses you watch.');
  });
});
