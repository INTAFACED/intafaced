// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { betaHides, betaRoomList } from '../../../app/beta-volt';
import { rooms } from '../../../app/navigation';
import { voltCount } from '../../../app/volt-count';
import { WALLET_SECTIONS } from '../routes';

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
    const list = betaRoomList(voltCount().rooms, rooms);
    expect(betaHides('/wallet', list)).toBe(false);
    expect(betaHides(WALLET_SECTIONS.embedded, list)).toBe(false);
  });
});
