// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DeskStatus } from '../rooms/api';
import { DeskStatusStrip } from './DeskStatusStrip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

// TEST desk status: the asset ids are fixtures, not an owner list.
const open: DeskStatus = {
  published: true,
  statusLine: 'TEST',
  makerRouting: { published: false },
  midFeed: { wiring: 'boot', published: false },
};

async function show(data: DeskStatus) {
  await act(async () => root.render(<DeskStatusStrip desk={{ status: 'ready', data, asOf: 0 }} />));
}
const region = () => host.querySelector('section[aria-label="Assets on the desk"]');
const listed = () => [...(region()?.querySelectorAll('li') ?? [])].map((li) => li.textContent);

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the assets on the desk (CB-otc-11)', () => {
  it('lists exactly the assets the desk publishes, in its order', async () => {
    await show({ ...open, assets: ['BTC', 'ETH'] });
    expect(listed()).toEqual(['BTC', 'ETH']);
    expect(region()?.textContent).not.toContain('Not set');
  });

  it('reads "Not set" when the list is blank, and lists nothing', async () => {
    for (const assets of [null, undefined, []]) {
      await show({ ...open, assets });
      expect(listed()).toEqual([]);
      expect(region()?.textContent).toContain('Not set');
      expect(region()?.textContent).toContain('The desk has no asset list, so every request refuses.');
    }
  });
});

describe('the verification level of the desk (CB-otc-08)', () => {
  const strip = () => host.querySelector('section[aria-label="Desk status"]')?.textContent ?? '';

  it('names the level the desk publishes', async () => {
    for (const [minTier, words] of [
      ['basic', 'Basic and above'],
      ['full', 'Full and above'],
      ['institutional', 'Institutional only'],
    ] as const) {
      await show({ ...open, assets: ['BTC'], minTier });
      expect(strip()).toContain(`Verification level${words}`);
      expect(strip()).toContain('The desk prices only for accounts verified at this level or above.');
    }
  });

  it('reads "Not set" with its blocker when the level is blank or one the room does not know', async () => {
    for (const minTier of [null, undefined, 'gold']) {
      await show({ ...open, assets: ['BTC'], minTier });
      expect(strip()).toContain('Verification levelNot set');
      expect(strip()).toContain('The desk has no verification level set, so every request refuses.');
    }
  });
});
