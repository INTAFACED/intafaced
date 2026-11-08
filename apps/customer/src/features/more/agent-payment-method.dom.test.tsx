// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { OwnAgent } from '@intafaced/contracts/agents-own';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The service's answers by procedure, and what the page sent. */
let answers: Record<string, unknown>;
const sent: Array<{ procedure: string; input: unknown }> = [];

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../session/session', () => {
  const answer = async (_service: string, procedure: string, input: unknown) => {
    sent.push({ procedure, input });
    return answers[procedure];
  };
  const api = { query: answer, mutate: answer };
  return { useApi: () => api, useSession: () => ({ userId: 'u-test' }) };
});

const { PaymentMethod, Refusal } = await import('./AgentBuilder');

const WALLET = '0x00000000000000000000000000000000000a11ce';
const AGENT = { id: '11111111-1111-4111-8111-111111111111' } as OwnAgent;

async function mount(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return host;
}

describe('the Refusal of a run paid from a wallet (J-agents-02 #4)', () => {
  const figure = {
    worstCase: '0.010245',
    asset: 'USDT',
    method: 'wallet',
    address: WALLET,
    available: '0',
    source: 'chain',
    chainId: 84532,
    block: '1234',
    asOf: '2026-11-09T00:00:00.000Z',
  };

  it('names the wallet, its figure with its asset, the TEST chain and block, and the as-of time', async () => {
    const host = await mount(<Refusal code="agents.funds_insufficient" params={figure} />);
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('Wallet 0x0000…11ce holds 0 USDT, as TEST chain 84532, block 1234 reported it at');
    expect(alert.textContent).toContain(new Date(figure.asOf).toLocaleString());
    expect(alert.textContent).toContain('worst case of 0.010245 USDT');
    expect(alert.getAttribute('title')).toBe(WALLET);
    expect(alert.getAttribute('data-block')).toBe('1234');
    expect(alert.getAttribute('data-as-of')).toBe(figure.asOf);
    expect(alert.querySelector('code')?.textContent).toBe('agents.funds_insufficient');
  });

  it('says the wallet’s amount could not be read, and why', async () => {
    const host = await mount(
      <Refusal
        code="agents.funds_unread"
        params={{ worstCase: '1', asset: 'USDT', method: 'wallet', address: WALLET, reason: 'chain_unreachable' }}
      />,
    );
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain(
      'The amount in wallet 0x0000…11ce could not be read, so this run did not start: the chain could not be reached just now. Nothing was charged.',
    );
    expect(alert.getAttribute('data-reason')).toBe('chain_unreachable');
  });

  it('without a wallet keeps today’s words', async () => {
    const host = await mount(<Refusal code="agents.funds_insufficient" params={{ worstCase: '1', asset: 'USDT' }} />);
    expect(host.textContent).toContain('Your available balance is below this run’s worst case, so it did not start.');
    expect(host.querySelector('[role="alert"]')?.hasAttribute('title')).toBe(false);
  });
});

describe('the payment method on the Limits page', () => {
  it('with no wallet linked, says so and links to where wallets are linked', async () => {
    answers = { 'own.paymentMethod.get': { ok: true, data: { method: null, linked: { state: 'usable', wallets: [] } } } };
    const host = await mount(<PaymentMethod agent={AGENT} />);
    await vi.waitFor(() => expect(host.querySelector('[data-testid="payment-no-wallet"]')).not.toBeNull());
    expect(host.textContent).toContain('No wallet linked.');
    expect(host.querySelector('a[href="/uc/safe"]')?.textContent).toBe('Link a wallet in Settings');
    expect(host.querySelector('select')).toBeNull();
  });

  it('shows the linked wallets to choose from and saves the chosen one', async () => {
    sent.length = 0;
    const chosen = {
      method: { kind: 'wallet', address: WALLET, chosenAt: '2026-11-09T00:00:00.000Z' },
      linked: { state: 'usable', wallets: [{ address: WALLET, linkedAt: '2026-11-09T00:00:00.000Z' }] },
    };
    answers = {
      'own.paymentMethod.get': { ok: true, data: { method: null, linked: chosen.linked } },
      'own.paymentMethod.set': { ok: true, data: chosen },
    };
    const host = await mount(<PaymentMethod agent={AGENT} />);
    await vi.waitFor(() => expect(host.querySelector('select')).not.toBeNull());
    expect(host.querySelector('[data-testid="payment-method"]')?.textContent).toContain('No payment method chosen');
    const select = host.querySelector('select')!;
    await act(async () => {
      select.value = WALLET;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await vi.waitFor(() => expect(host.textContent).toContain('Payment method saved.'));
    expect(sent.find((s) => s.procedure === 'own.paymentMethod.set')?.input).toEqual({ id: AGENT.id, address: WALLET });
    expect(host.querySelector('[data-testid="payment-method"] [title]')?.getAttribute('title')).toBe(WALLET);
  });

  it('identity unread is said as unread, never as "no wallet"', async () => {
    answers = { 'own.paymentMethod.get': { ok: true, data: { method: null, linked: { state: 'unread' } } } };
    const host = await mount(<PaymentMethod agent={AGENT} />);
    await vi.waitFor(() => expect(host.textContent).toContain('Your linked wallets could not be read just now'));
    expect(host.textContent).not.toContain('No wallet linked.');
  });
});
