import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// A trader who has made their INTAFACED wallet sees their venue tier on My fee tier without being asked to
// connect it again. Reading a tier signs nothing, so the page reads it for the made wallet's address.
const MADE = '0x00000000000000000000000000000000000000aa';
const made = vi.hoisted(() => ({ address: null as string | null }));

vi.mock('../protocol', async (importOriginal) => {
  const real = await importOriginal<typeof import('../protocol')>();
  const disconnected = {
    status: 'disconnected',
    wallets: [{ info: { uuid: 'u', name: 'INTAFACED wallet', icon: '', rdns: 'test.intafaced' }, provider: {} }],
    connected: null,
    address: null,
    chainId: null,
    guard: null,
    problem: null,
    connect: async () => undefined,
    disconnect: () => undefined,
    switchNetwork: async () => undefined,
  };
  return {
    ...real,
    WalletProvider: ({ children }: { children: unknown }) => children,
    useWallet: () => disconnected,
    useEmbeddedWalletAddress: () => made.address,
  };
});
vi.mock('../trade', async (importOriginal) => {
  const real = await importOriginal<typeof import('../trade')>();
  return {
    ...real,
    useVenueMode: () => ({ mode: 'on', status: { enabled: true, available: true, chainId: 998 }, reload: () => undefined }),
  };
});

const { VenueTier } = await import('./VenueFees');

describe('My fee tier: a made INTAFACED wallet', () => {
  it('reads the tier for the made wallet, with no ask to connect it again', () => {
    made.address = MADE;
    const html = renderToString(<VenueTier />);
    expect(html).not.toContain('Connect INTAFACED wallet');
    expect(html).toContain(`data-tier-owner="made"`);
    expect(html).toContain(MADE);
  });

  it('with no wallet made, it still offers the wallets this browser has', () => {
    made.address = null;
    const html = renderToString(<VenueTier />);
    expect(html).toContain('Connect INTAFACED wallet');
    expect(html).not.toContain('data-tier-owner');
  });
});
