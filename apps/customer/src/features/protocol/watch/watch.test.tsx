import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
const session = { userId: null as string | null };
vi.mock('../../session/session', () => ({ useSession: () => session, useApi: () => ({ query: () => new Promise(() => undefined) }) }));
const answers: Record<string, unknown> = {};
vi.mock('../../../shared/resource', () => ({
  useResource: (_load: unknown, key: string) => ({ resource: answers[key] ?? { status: 'loading' }, reload: () => undefined }),
}));
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
  it('lists the indexer’s transactions for the address, each transfer with its direction, amount and token', () => {
    const lower = ADDRESS.toLowerCase();
    answers[`explorer:address:${ADDRESS}:chain`] = { status: 'ready', data: { configuredChainId: 84532 } };
    const token = `0x${'a'.repeat(40)}`;
    answers[`explorer:address-txs:84532:${lower}`] = {
      status: 'ready',
      data: {
        rows: [
          {
            chainId: 84532,
            hash: `0x${'c'.repeat(64)}`,
            blockHeight: 12,
            index: 0,
            timestamp: 1_790_000_000,
            from: token,
            to: token,
            status: 'success',
            revertReason: null,
            transfers: [
              { token: { address: token, symbol: 'TESTA', decimals: 18 }, amount: '1500000000000000000', direction: 'in' },
              { token: { address: token, symbol: null, decimals: null }, amount: '7', direction: 'out' },
            ],
          },
        ],
        nextCursor: null,
        asOf: '',
        asOfHeight: 14,
      },
    };
    const html = renderToStaticMarkup(<AddressPage address={ADDRESS} />);
    expect(html).toContain('In 1.5 TESTA');
    expect(html).toContain('Out 7 base units of 0xaaaaaaaa…aaaaaa');
    expect(html).toContain('href="/chain/blocks/12"');
    expect(html).toContain('Indexed to block 14.');
    answers[`explorer:address-txs:84532:${lower}`] = { status: 'ready', data: { rows: [], nextCursor: null, asOf: '', asOfHeight: 14 } };
    expect(renderToStaticMarkup(<AddressPage address={ADDRESS} />)).toContain(
      'The indexer lists no transaction for this address on Base Sepolia test network.',
    );
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
