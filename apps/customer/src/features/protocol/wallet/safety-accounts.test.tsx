// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountsPanel, isFactoryUnset } from './AccountsPanel';
import { COMPROMISE_STEPS, SAFETY_LESSONS, SafetyPanel } from './SafetyPanel';
import { WEB3_ROUTES } from '../routes';

const ME = '0x1111111111111111111111111111111111111111';
const SMART = '0x2222222222222222222222222222222222222222';
const wallet = { status: 'connected', address: ME as string | null, guard: { ok: true } as { ok: boolean } | null };
const predictAccount = vi.fn();
vi.mock('./WalletProvider', async (actual) => ({ ...(await actual<typeof import('./WalletProvider')>()), useWallet: () => wallet }));
vi.mock('../api', () => ({ createProtocolApi: () => ({ predictAccount }) }));
const session = { userId: 'u1' as string | null, api: {} };
const venueStatus = vi.fn();
const venueSubs = vi.fn();
vi.mock('../../session/session', () => ({ useApi: () => ({}), useSession: () => session }));
vi.mock('../../trade/venue-api', async (actual) => ({
  ...(await actual<typeof import('../../trade/venue-api')>()),
  venueApi: () => ({ status: venueStatus, subAccounts: venueSubs }),
}));
const VENUE_UP = {
  enabled: true,
  available: true,
  venue: { id: 'test-venue', displayName: 'TEST venue', proofLevel: 'simulator' },
  test: true,
  label: 'TEST',
  chainId: 84532,
  builder: null,
};
const SUB = '0x3333333333333333333333333333333333333333';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const text = () => host.textContent ?? '';
const mount = async (node: React.ReactNode) => {
  await act(async () => {
    root.render(node);
  });
};
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  wallet.status = 'connected';
  wallet.address = ME;
  wallet.guard = { ok: true };
  predictAccount.mockReset();
  session.userId = 'u1';
  venueStatus.mockReset().mockResolvedValue({ ok: true, data: { enabled: false } });
  venueSubs.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('wallet Accounts (D-portfolio-wallet-02)', () => {
  it('lists the wallet and its smart account as read from the service', async () => {
    predictAccount.mockResolvedValue({
      ok: true,
      data: { address: SMART, chainId: 84532, factory: ME, implementation: ME, deployed: false },
    });
    await mount(<AccountsPanel />);
    const table = host.querySelector('[role="region"][aria-label="Sub-accounts"] table')!;
    const rows = [...table.querySelectorAll('tbody tr')].map((row) => row.textContent);
    expect(rows[0]).toContain(ME);
    expect(rows[1]).toContain(SMART);
    expect(rows[1]).toContain('Not deployed: it is created');
    expect(predictAccount).toHaveBeenCalledWith(ME, expect.anything());
  });

  it('names an unset factory as not deployed, never as an empty list', async () => {
    predictAccount.mockResolvedValue({ ok: false, reason: 'refused', message: 'Smart account factory/implementation is not configured' });
    await mount(<AccountsPanel />);
    expect(text()).toContain('Not available: the smart account factory is not deployed on this network');
    expect(isFactoryUnset('timeout')).toBe(false);
  });

  it('a wallet on another network is told so, and nothing is read for it', async () => {
    wallet.guard = { ok: false };
    await mount(<AccountsPanel />);
    expect(text()).toContain('Your wallet is on another network.');
    expect(predictAccount).not.toHaveBeenCalled();
  });

  it("lists the wallet's own sub-accounts on the venue, as the venue reports them, with the venue named", async () => {
    predictAccount.mockResolvedValue({
      ok: true,
      data: { address: SMART, chainId: 84532, factory: ME, implementation: ME, deployed: true },
    });
    venueStatus.mockResolvedValue({ ok: true, data: VENUE_UP });
    venueSubs.mockResolvedValue({
      ok: true,
      data: { venueId: 'test-venue', asOf: '2026-11-12T08:00:00.000Z', value: [{ subAccount: SUB, name: 'Savings' }] },
    });
    await mount(<AccountsPanel />);
    await act(async () => {});
    const table = host.querySelector('[role="region"][aria-label="Venue sub-accounts"] table')!;
    const rows = [...table.querySelectorAll('tbody tr')].map((row) => row.textContent);
    expect(rows).toEqual([`Savings${SUB}`]);
    expect(venueSubs).toHaveBeenCalledWith(ME, expect.anything());
    expect(text()).toContain('Your own sub-accounts on TEST venue');
    expect(host.querySelector('[data-testid="venue-as-of"]')).not.toBeNull();
  });

  it('says why no venue sub-account is listed: signed out, the venue not connected, or the venue down', async () => {
    predictAccount.mockResolvedValue({
      ok: true,
      data: { address: SMART, chainId: 84532, factory: ME, implementation: ME, deployed: true },
    });
    session.userId = null;
    await mount(<AccountsPanel />);
    expect(text()).toContain("Sign in to see this wallet's sub-accounts on the trading venue.");
    session.userId = 'u1';
    await mount(<AccountsPanel key="off" />);
    await act(async () => {});
    expect(text()).toContain('The trading venue is not connected');
    venueStatus.mockResolvedValue({
      ok: true,
      data: { enabled: true, available: false, refusal: { code: 'venue_down', detail: 'TEST venue is down' } },
    });
    await mount(<AccountsPanel key="down" />);
    await act(async () => {});
    expect(text()).toContain('The trading venue did not answer, so its sub-accounts cannot be read: TEST venue is down');
    expect(venueSubs).not.toHaveBeenCalled();
  });

  it('shows the multi-signature control disabled with its blocker', async () => {
    wallet.status = 'disconnected';
    wallet.address = null;
    await mount(<AccountsPanel />);
    const button = [...host.querySelectorAll('button')].find((node) => node.textContent === 'Create a multi-signature account')!;
    expect(button.disabled).toBe(true);
    expect(text()).toContain('The multi-signature contract is not deployed on this network');
    expect(text()).toContain('Connect a wallet to see this section.');
  });
});

describe('wallet Safety (D-portfolio-wallet-02, D-developer-compliance-02)', () => {
  const routed = (href: string) => WEB3_ROUTES.some((route) => route.path === href);

  it('links every habit and every compromise step to a real route', async () => {
    for (const { href } of [...SAFETY_LESSONS, ...COMPROMISE_STEPS]) expect(routed(href), href).toBe(true);
    await mount(<SafetyPanel />);
    const steps = [...host.querySelectorAll('ol[aria-label="If your wallet is compromised"] li')].map((li) => li.textContent);
    expect(steps.map((step) => step?.split(' ').slice(0, 2).join(' '))).toEqual(['Revoke session', 'Revoke approvals', 'Move your']);
    expect(host.querySelectorAll('ul[aria-label="Stay safe"] li a')).toHaveLength(SAFETY_LESSONS.length);
  });

  it('says what is not published rather than inventing a policy or a bounty, and promises no recovery', async () => {
    await mount(<SafetyPanel />);
    expect(host.querySelector('[data-code="compliance.disclosure_unset"]')?.textContent).toBe('The disclosure policy is not published.');
    expect(text()).toContain('No bounty programme is running.');
    expect(text()).toContain('We cannot reverse a transaction or recover funds');
  });
});
