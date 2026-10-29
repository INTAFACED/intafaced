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
