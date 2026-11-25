// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { betaHides, betaRoomList } from '../../../app/beta-volt';
import { rooms } from '../../../app/navigation';
import betaScreens from '../../../app/beta-screens.json';
import { WALLET_SECTIONS, walletSections } from '../routes';

const transport = {
  canWrite: () => false,
  query: () => new Promise(() => undefined),
  call: () => new Promise(() => undefined),
};

vi.mock('../../session', async (original) => {
  const real = await original<typeof import('../../session')>();
  return { ...real, useApi: () => transport as never };
});

import { WalletHomeRoom } from './WalletHomeRoom';
import { WalletProvider } from './WalletProvider';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('WalletHomeRoom (/wallet)', () => {
  it('links to My wallet (/wallet/embedded) with a visible anchor so traders and the beta crawl reach it', async () => {
    await act(async () => {
      root.render(
        <WalletProvider discovery={false}>
          <WalletHomeRoom />
        </WalletProvider>,
      );
    });
    const link = host.querySelector(`a[href="${WALLET_SECTIONS.embedded}"]`);
    expect(link, 'Wallet overview renders an <a href="/wallet/embedded"> link').not.toBeNull();
    expect(link?.textContent?.trim()).toBe('Open My wallet');
    const list = betaRoomList(betaScreens.rooms, rooms);
    expect(betaHides('/wallet', list)).toBe(false);
    expect(betaHides(WALLET_SECTIONS.embedded, list)).toBe(false);
  });

  it('links to Venue account (/wallet/venue), an Order 1 screen, and keeps it in the wallet sections (J-wallet-09)', async () => {
    const list = betaRoomList(betaScreens.rooms, rooms);
    expect(betaScreens.rooms).toContain(WALLET_SECTIONS.venue);
    expect(betaHides(WALLET_SECTIONS.venue, list)).toBe(false);
    expect(walletSections(list)).toContain('venue');
    await act(async () => {
      root.render(
        <WalletProvider discovery={false}>
          <WalletHomeRoom />
        </WalletProvider>,
      );
    });
    const link = host.querySelector(`a[href="${WALLET_SECTIONS.venue}"]`);
    expect(link, 'Wallet overview renders an <a href="/wallet/venue"> link').not.toBeNull();
    expect(link?.textContent?.trim()).toBe('Venue account');
  });
});
