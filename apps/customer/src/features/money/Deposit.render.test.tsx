// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// TEST figures and names, not published settings. Each test chooses what custody publishes.
const world = vi.hoisted(() => ({ catalogue: { status: 'loading' } as unknown }));
const address = vi.fn();
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../session/session', () => ({ useSession: () => ({ userId: 'u1', api: {} }) }));
vi.mock('./holdings', () => ({ useHoldings: () => ({ resource: { status: 'ready', data: { assets: [] } } }) }));
vi.mock('../../data/hooks', () => ({ useMarkets: () => ({ status: 'ready', data: [] }) }));
vi.mock('../../data/activity', () => ({ useActivity: () => ({ status: 'ready', data: { items: [], hasMore: false } }) }));
vi.mock('./AccountDetails', () => ({ AccountDetailsPanel: () => null }));
vi.mock('./DepositRecords', () => ({ DepositPendingPanel: () => null, DepositRecordsPanel: () => null }));
vi.mock('./deposit-reads', async (original) => ({
  ...(await original<typeof import('./deposit-reads')>()),
  useDepositCatalogue: () => ({ resource: world.catalogue, reload: () => undefined }),
  createDepositReads: () => ({ address }),
}));
import { Deposit } from './Deposit';
import { DepositAddressPanel } from './DepositFunding';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
const net = (id: string, label: string, extra: object = {}) => ({
  id,
  label,
  minimumDeposit: '10',
  confirmationsRequired: 12,
  estimatedArrivalMinutes: 5,
  ...extra,
});
const published = (assets: Array<{ assetId: string; networks: object[] }>) => ({ status: 'ready', data: { assets } });
const unset = { status: 'failed', failure: { ok: false, reason: 'error', message: 'x', code: 'bank.deposit_custody_unset' } };
const USDT = { assetId: 'USDT', networks: [net('ethereum', 'Ethereum'), net('tron', 'Tron')] };
const BTC = { assetId: 'BTC', networks: [net('bitcoin', 'Bitcoin')] };
const ETH = { assetId: 'ETH', networks: [net('ethereum', 'Ethereum')] };

async function open(search = '') {
  history.replaceState(null, '', `/uc/recharge${search}`);
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<Deposit />));
}
const field = (label: string) =>
  [...host.querySelectorAll('label.field')].find((node) => node.querySelector('span')?.textContent === label)!;
const select = (label: string) => field(label).querySelector('select')!;
const type = (label: string, value: string) =>
  act(async () => {
    const input = field(label).querySelector('input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  address.mockReset();
  world.catalogue = { status: 'loading' };
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = '';
  history.replaceState(null, '', '/');
});

describe('deposit room: how money gets in', () => {
  it('lists the ways to add money: crypto is this page, the others open the room that owns them and name their blocker', async () => {
    world.catalogue = published([USDT]);
    await open();
    const nav = host.querySelector('nav[aria-label="Ways to add money"]')!;
    const item = (id: string) => nav.querySelector(`[data-method="${id}"]`)!;
    expect(item('crypto').querySelector('[aria-current="page"]')?.textContent).toContain('You are here');
    expect(item('crypto').querySelector('a')).toBeNull();
    expect(item('card').querySelector('a')?.getAttribute('href')).toBe('/bank/ramps');
    expect(item('bank').querySelector('a')?.getAttribute('href')).toBe('/bank/ramps');
    expect(item('card').textContent).toContain('Needs a payment partner, which is not connected.');
    expect(item('p2p').querySelector('a')?.getAttribute('href')).toBe('/p2p');
    expect(item('user').querySelector('a')?.getAttribute('href')).toBe('/pay/receive');
    expect(host.textContent).not.toContain('Other ways to add money');
  });

  it('still lists every way when custody is not set, so nothing is hidden', async () => {
    world.catalogue = unset;
    await open();
    expect(host.querySelectorAll('[data-method]')).toHaveLength(5);
    expect(host.textContent).toContain('Deposit addresses are not available');
  });
});

describe('deposit room: asset search', () => {
  it('narrows the list as the person types, counts it, and keeps the chosen asset in the list', async () => {
    world.catalogue = published([USDT, BTC, ETH]);
    await open();
    expect([...select('Asset').options].map((o) => o.value)).toEqual(['USDT', 'BTC', 'ETH']);
    expect(host.textContent).toContain('3 of 3 assets');
    await type('Search assets', 'bt');
    expect([...select('Asset').options].map((o) => o.value)).toEqual(['USDT', 'BTC']);
    expect(host.textContent).toContain('1 of 3 assets');
    await act(async () => {
      select('Asset').value = 'BTC';
      select('Asset').dispatchEvent(new Event('change', { bubbles: true }));
    });
    await type('Search assets', 'eth');
    expect([...select('Asset').options].map((o) => o.value)).toEqual(['BTC', 'ETH']);
    expect(select('Asset').value).toBe('BTC');
  });

  it('says so when nothing matches, and the chosen asset stays', async () => {
    world.catalogue = published([USDT, BTC]);
    await open();
    await type('Search assets', 'zzz');
    expect(host.textContent).toContain('No asset matches “zzz”.');
    expect(select('Asset').value).toBe('USDT');
  });

  it('choosing another asset clears the network, so a network is never carried to a coin that does not have it', async () => {
    world.catalogue = published([USDT, BTC]);
    await open();
    await act(async () => {
      select('Network').value = 'tron';
      select('Network').dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(select('Network').value).toBe('tron');
    await act(async () => {
      select('Asset').value = 'BTC';
      select('Asset').dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(select('Network').value).toBe('');
  });
});

describe('deposit room: ?asset=&network= address', () => {
  it('chooses the published asset and network, ignoring case, and still asks for the confirmation before any address', async () => {
    world.catalogue = published([BTC, USDT]);
    await open('?asset=usdt&network=TRON');
    expect(select('Asset').value).toBe('USDT');
    expect(select('Network').value).toBe('tron');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(address).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="deposit-address"]')).toBeNull();
    expect((host.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
  });

  it('an asset custody does not publish chooses nothing and says so with the typed code', async () => {
    world.catalogue = published([BTC, USDT]);
    await open('?asset=DOGE&network=dogecoin');
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.getAttribute('data-code')).toBe('bank.deposit_asset_unpublished');
    expect(alert.textContent).toContain('DOGE is not an asset custody publishes for deposits');
    expect(select('Asset').value).toBe('BTC');
    expect(select('Network').value).toBe('');
  });

  it('a network that is not published for a published asset picks the asset only', async () => {
    world.catalogue = published([BTC, USDT]);
    await open('?asset=USDT&network=solana');
    expect(select('Asset').value).toBe('USDT');
    expect(select('Network').value).toBe('');
    expect(host.querySelector('[role="alert"]')?.getAttribute('data-code')).toBe('bank.deposit_network_unpublished');
  });

  it('is not judged while custody publishes nothing: the blocker stands and no alert is added', async () => {
    world.catalogue = unset;
    await open('?asset=DOGE');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain('Deposit addresses are not available');
  });

  it('applies once the list arrives, and not again after the person chooses', async () => {
    world.catalogue = { status: 'loading' };
    await open('?asset=USDT&network=tron');
    world.catalogue = published([BTC, USDT]);
    await act(async () => root!.render(<Deposit />));
    expect(select('Network').value).toBe('tron');
    await act(async () => {
      select('Network').value = 'ethereum';
      select('Network').dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => root!.render(<Deposit />));
    expect(select('Network').value).toBe('ethereum');
  });
});

describe('deposit room: what the network says', () => {
  const panel = (network: object) =>
    act(async () =>
      root!.render(
        <DepositAddressPanel asset="USDT" catalogue={published([{ assetId: 'USDT', networks: [network] }]) as never} networkId="n1" />,
      ),
    );
  beforeEach(() => {
    root = createRoot(host);
  });

  it('with nothing published shows only the standard wrong-network line and the plain confirmation', async () => {
    await panel(net('n1', 'Net One'));
    const notes = host.querySelector('[data-testid="deposit-notes"]')!;
    expect(notes.textContent).toContain('This address takes USDT on Net One only.');
    expect(notes.querySelector('section')).toBeNull();
    expect(host.textContent).toContain('I will send only USDT on Net One. I understand anything else');
  });

  it('shows what the service published as written, and the address waits for the confirmation that names the notes', async () => {
    await panel(
      net('n1', 'Net One', {
        requirements: ['TEST requirement text'],
        unsupported: ['TEST unsupported case'],
        warnings: ['TEST warning text'],
      }),
    );
    const notes = host.querySelector('[data-testid="deposit-notes"]')!;
    expect(notes.querySelector('[data-notes="requirements"]')?.textContent).toContain('TEST requirement text');
    expect(notes.querySelector('[data-notes="unsupported"]')?.textContent).toContain('TEST unsupported case');
    expect(notes.querySelector('[data-notes="warnings"]')?.textContent).toContain('TEST warning text');
    expect(host.textContent).toContain('I have read the notes above');
    const show = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Show my deposit address')!;
    expect(show.disabled).toBe(true);
    expect(address).not.toHaveBeenCalled();
  });
});

describe('deposit room: a network the owner switched off, and a person not yet verified', () => {
  const choose = (label: string, value: string) =>
    act(async () => {
      const node = select(label);
      node.value = value;
      node.dispatchEvent(new Event('change', { bubbles: true }));
    });

  it('lists the switched-off network, and choosing it shows the owner note and no address control', async () => {
    world.catalogue = {
      status: 'ready',
      data: {
        assets: [USDT],
        halted: [{ assetId: 'USDT', networkId: 'base', label: 'TEST Base', haltNote: 'TEST maintenance until Monday' }],
      },
    };
    await open();
    const options = [...select('Network').options].map((o) => o.textContent);
    expect(options).toEqual(['Choose a network', 'Ethereum', 'Tron', 'TEST Base (switched off)']);
    await choose('Network', 'base');
    const banner = host.querySelector('[data-testid="deposit-halted"]')!;
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent).toContain('Deposits of USDT on TEST Base are switched off');
    expect(banner.textContent).toContain('TEST maintenance until Monday');
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Show my deposit address')).toBe(false);
    expect(host.querySelector('input[type="checkbox"]')).toBeNull();
    expect(address).not.toHaveBeenCalled();
  });

  it('keeps a coin whose every network is off in the list, and says so; with no note it shows only the standard line', async () => {
    world.catalogue = {
      status: 'ready',
      data: { assets: [BTC], halted: [{ assetId: 'USDC', networkId: 'base', label: 'TEST Base', haltNote: null }] },
    };
    await open();
    expect([...select('Asset').options].map((o) => o.value)).toEqual(['BTC', 'USDC']);
    await choose('Asset', 'USDC');
    expect(field('Network').textContent).toContain('Deposits of USDC are switched off on every network.');
    await choose('Network', 'base');
    const banner = host.querySelector('[data-testid="deposit-halted"]')!;
    // No owner's note: only the two standard lines, the second saying a deposit to a kept address waits and is credited later.
    expect(banner.querySelectorAll('p[lang="und"]')).toHaveLength(0);
    expect([...banner.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      'No address is shown for it. Choose another network, or come back when it is switched on.',
      'Anything sent to an address you already had for it is not lost: it waits, and is credited after deposits are switched back on.',
    ]);
  });

  it.each(['denied.kyc_required', 'tier.insufficient', 'bank.tier_required'])(
    'a person the bank refuses until verified (%s) is sent to Verification, with no retry that cannot help',
    async (code) => {
      world.catalogue = {
        status: 'failed',
        failure: { ok: false, reason: 'error', message: 'Verification tier "full" required for bank in XX', code },
      };
      await open();
      expect(field('Network').textContent).toContain('Crypto deposits open once your identity is verified.');
      expect([...field('Network').querySelectorAll('button')]).toHaveLength(0);
      const verify = host.querySelector('[data-testid="deposit-verify"]')!;
      expect(verify.textContent).toContain('Verify your identity first');
      expect(verify.querySelector('a')?.getAttribute('href')).toBe('/verification');
      expect(address).not.toHaveBeenCalled();
    },
  );

  it('a link to a switched-off pair chooses it, so its banner says why there is no address', async () => {
    world.catalogue = {
      status: 'ready',
      data: { assets: [BTC], halted: [{ assetId: 'USDC', networkId: 'base', label: 'TEST Base', haltNote: null }] },
    };
    await open('?asset=usdc&network=BASE');
    expect(select('Asset').value).toBe('USDC');
    expect(select('Network').value).toBe('base');
    expect(host.querySelector('[data-testid="deposit-halted"]')?.textContent).toContain('Deposits of USDC on TEST Base are switched off');
    expect(host.querySelector('[role="alert"][data-code]')).toBeNull();
  });
});
