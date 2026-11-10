// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { toFunctionSelector } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Navigator's on-chain access (J-agents-19): every state of the panel, with the person's wallet, svc-protocol and
// svc-agents answered here. Nothing here holds a key: the wallet stand-in records what it was asked to send.

const ME = '0x1111111111111111111111111111111111111111';
const SMART = '0x2222222222222222222222222222222222222222';
const SIGNER = '0x00000000000000000000000000000000005e0019';
const ROUTER = '0x8d28045bbe8a1aed986751257c5711524a7ec73f';
const POOL = '0x00000000000000000000000000000000000c0019';
const HASH = `0x${'c'.repeat(64)}`;
const SPEC_HASH = `0x${'a'.repeat(64)}`;
const GRANT_DATA = '0xabcdef0012';
const REVOKE_DATA = '0xdeadbeef01';

const wallet = {
  status: 'connected' as string,
  address: ME as string | null,
  chainId: 84532 as number | null,
  guard: { ok: true } as { ok: boolean } | null,
  sendSequence: vi.fn(),
  read: vi.fn(),
};
const protocol = {
  predictAccount: vi.fn(),
  sessionsList: vi.fn(),
  deploymentsList: vi.fn(),
  buildSessionGrant: vi.fn(),
  buildSessionRevoke: vi.fn(),
  representationStatus: vi.fn(),
  representationAccept: vi.fn(),
};
let answers: Record<string, unknown>;
const sent: Array<{ procedure: string; input: unknown }> = [];
const agents = {
  query: async (_service: string, procedure: string, input: unknown) => {
    sent.push({ procedure, input });
    return typeof answers[procedure] === 'function' ? (answers[procedure] as (i: unknown) => unknown)(input) : answers[procedure];
  },
  mutate: async (_service: string, procedure: string, input: unknown) => {
    sent.push({ procedure, input });
    return typeof answers[procedure] === 'function' ? (answers[procedure] as (i: unknown) => unknown)(input) : answers[procedure];
  },
};

vi.mock('../protocol/wallet/WalletProvider', async (actual) => ({
  ...(await actual<typeof import('../protocol/wallet/WalletProvider')>()),
  useWallet: () => wallet,
  WalletProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../protocol/api', () => ({ createProtocolApi: () => protocol }));
vi.mock('../session/session', () => ({ useApi: () => agents, useSession: () => ({ userId: 'u-test' }) }));
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.open = false;
};

const { NavigatorOnChain, NAVIGATOR_DEFAULT_SELECTOR, keyStatus } = await import('./NavigatorOnChain');
const { NavigatorOrderView, NavigatorTradeRefusalView, NavigatorCapLine } = await import('./NavigatorOrders');

const binding = (over: object = {}) => ({
  id: '99999999-9999-4999-8999-999999999999',
  chainId: 84532,
  account: SMART,
  sessionKey: SIGNER,
  spendLimitWei: '1000000000000000000',
  validUntil: 1_900_000_000,
  targets: [ROUTER],
  selectors: [NAVIGATOR_DEFAULT_SELECTOR],
  specHash: SPEC_HASH,
  bindKey: `agents:onchain:navigator:84532:${SMART}:${SIGNER}`,
  createdAt: '2026-11-10T00:00:00.000Z',
  updatedAt: '2026-11-10T00:00:00.000Z',
  revokeRequestedAt: null as string | null,
  ...over,
});
const chainKey = (over: object = {}) => ({
  key: SIGNER,
  targets: [ROUTER],
  selectors: [NAVIGATOR_DEFAULT_SELECTOR],
  spendLimitWei: '1000000000000000000',
  spentWei: '0',
  validAfter: 0,
  validUntil: 1_900_000_000,
  status: 'active',
  grantedBlock: '10',
  lastUsedAt: null,
  ...over,
});
const list = (keys: object[], blockNumber = '40') => ({
  ok: true,
  data: { account: SMART, chainId: 84532, deployed: true, blockNumber, blockTime: '2026-11-10T08:00:00.000Z', logsFromBlock: '0', keys },
});

let host: HTMLDivElement, root: Root;
const region = () => host.querySelector('section[aria-label="On-chain access"]') as HTMLElement;
const form = () => host.querySelector('form[aria-label="Session key grant"]') as HTMLFormElement;
const text = () => region()?.textContent ?? '';
const status = () => host.querySelector('[data-testid="binding-status"]')?.textContent ?? null;
const unsigned = () => host.querySelector('[data-testid="unsigned-call"]')?.textContent ?? null;
const button = (name: string) =>
  [...host.ownerDocument.querySelectorAll('button')].find((node) => node.textContent?.trim() === name) as HTMLButtonElement;
const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const mount = async () => {
  await act(async () => {
    root.render(<NavigatorOnChain />);
  });
  await flush();
};
/** Types into a field the way React hears it. */
function type(label: RegExp, value: string) {
  const field = [...form().querySelectorAll('label')].find((node) => label.test(node.textContent ?? ''))!;
  const control = field.querySelector('input, select') as HTMLInputElement | HTMLSelectElement;
  const proto = control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(control, value);
  control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}
const prepare = async () => {
  await act(async () => button('Prepare grant').click());
  await flush();
};
const procedures = () => sent.map((entry) => entry.procedure);

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  sent.length = 0;
  wallet.status = 'connected';
  wallet.address = ME;
  wallet.chainId = 84532;
  wallet.guard = { ok: true };
  answers = {
    'navigator.onchain.signer': { ok: true, data: { signer: SIGNER, chainId: 84532, network: 'testnet', pools: [POOL] } },
    'navigator.onchain.binding': { ok: true, data: { binding: null } },
    // As the service does: what is bound is what a later read returns.
    'navigator.onchain.bind': (input: {
      specHash: string;
      spendLimitWei: string;
      validUntil: number;
      targets: string[];
      selectors: string[];
    }) => {
      const row = binding({
        specHash: input.specHash,
        spendLimitWei: input.spendLimitWei,
        validUntil: input.validUntil,
        selectors: input.selectors,
      });
      answers['navigator.onchain.binding'] = { ok: true, data: { binding: row } };
      return { ok: true, data: row };
    },
    'navigator.onchain.revoke': { ok: true, data: binding({ revokeRequestedAt: '2026-11-10T01:00:00.000Z' }) },
  };
  protocol.predictAccount
    .mockReset()
    .mockResolvedValue({ ok: true, data: { address: SMART, chainId: 84532, factory: ME, implementation: ME, deployed: true } });
  protocol.sessionsList.mockReset().mockResolvedValue(list([]));
  protocol.deploymentsList.mockReset().mockResolvedValue({
    ok: true,
    data: {
      chainId: 84532,
      chainName: 'Base Sepolia',
      deployedAt: null,
      contracts: [],
      routers: [{ name: 'SovereignRouter', address: ROUTER, version: 'v1', deployedAt: null, verified: false, sunsetAt: null }],
    },
  });
  protocol.buildSessionGrant.mockReset().mockImplementation(async (input: { spec: { validUntil: number } }) => ({
    ok: true,
    data: { to: SMART, data: GRANT_DATA, value: '0', summary: 'grant', specHash: SPEC_HASH, validUntil: input.spec.validUntil },
  }));
  protocol.buildSessionRevoke
    .mockReset()
    .mockResolvedValue({ ok: true, data: { to: SMART, data: REVOKE_DATA, value: '0', summary: 'revoke' } });
  protocol.representationStatus.mockReset().mockResolvedValue({ ok: true, data: { accepted: true } });
  wallet.sendSequence.mockReset().mockResolvedValue({ status: 'sent', hashes: [HASH] });
  wallet.read.mockReset().mockResolvedValue({ status: '0x1', blockNumber: '0x29' });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('the Navigator’s default call', () => {
  it('is the router’s swapExactIn selector', () => {
    expect(NAVIGATOR_DEFAULT_SELECTOR).toBe(toFunctionSelector('swapExactIn(address,address,uint256,uint256,address)'));
  });
});

describe('On-chain access: honest states before a grant', () => {
  it('with no wallet connected, points to Wallet and offers no form', async () => {
    wallet.status = 'disconnected';
    wallet.address = null;
    await mount();
    expect(text()).toContain('Connect your wallet on the test network');
    expect(region().querySelector('a')?.getAttribute('href')).toBe('/wallet');
    expect(form()).toBeNull();
  });

  it('on another network, says so and offers no form', async () => {
    wallet.chainId = 1;
    wallet.guard = { ok: false };
    await mount();
    expect(text()).toContain('Your wallet is on another network');
    expect(form()).toBeNull();
  });

  it('with no signer configured, shows the rail.crypto notice', async () => {
    answers['navigator.onchain.signer'] = { ok: false, reason: 'error', message: 'rail.crypto', code: 'PRECONDITION_FAILED' };
    await mount();
    expect(region().querySelector('[data-not-connected="rail.crypto"]')).not.toBeNull();
    expect(form()).toBeNull();
  });

  it('on mainnet, shows the external-audit notice', async () => {
    // An app built for mainnet: the wallet is on the network the app signs on.
    wallet.chainId = 8453;
    answers['navigator.onchain.signer'] = { ok: false, reason: 'error', message: 'audit.external', code: 'PRECONDITION_FAILED' };
    await mount();
    expect(region().querySelector('[data-not-connected="audit.external"]')).not.toBeNull();
    expect(text()).not.toContain('TESTNET');
  });

  it('with no smart account yet, says so and links to Wallet, Accounts', async () => {
    protocol.predictAccount.mockResolvedValue({
      ok: true,
      data: { address: SMART, chainId: 84532, factory: ME, implementation: ME, deployed: false },
    });
    await mount();
    expect(text()).toContain('no smart account on this network yet');
    expect([...region().querySelectorAll('a')].map((a) => a.getAttribute('href'))).toContain('/wallet/accounts');
    expect(form()).toBeNull();
  });

  it('labels the test network TESTNET and shows the default call, with no binding status before a grant', async () => {
    await mount();
    expect(text()).toContain('TESTNET');
    expect(text()).toContain(`swapExactIn (${NAVIGATOR_DEFAULT_SELECTOR}) on the router ${ROUTER}`);
    expect((form().querySelector('input') as HTMLInputElement).value).toBe('');
    expect(status()).toBeNull();
  });
});

describe('Prepare grant', () => {
  it('with the spend cap blank, refuses naming the cap and builds nothing', async () => {
    await mount();
    type(/^Expires/, '1d');
    await prepare();
    expect(form().querySelector('[role="alert"]')?.textContent).toContain('Spend cap');
    expect(protocol.buildSessionGrant).not.toHaveBeenCalled();
    expect(procedures()).not.toContain('navigator.onchain.bind');
    expect(unsigned()).toBeNull();
  });

  it('with no expiry chosen, refuses naming the expiry', async () => {
    await mount();
    type(/^Spend cap/, '1');
    await prepare();
    expect(form().querySelector('[role="alert"]')?.textContent).toContain('agents.session_key_expiry_unset');
    expect(protocol.buildSessionGrant).not.toHaveBeenCalled();
  });

  it('with an approve selector, shows the service’s refusal in the form and builds nothing', async () => {
    protocol.buildSessionGrant.mockResolvedValue({
      ok: false,
      reason: 'error',
      message:
        'A session key may never be granted "approve(address,uint256)" (0x095ea7b3). Withdrawal power belongs to the owner key and nowhere else.',
    });
    await mount();
    type(/^Spend cap/, '1');
    type(/^Allowed calls/, '0x095ea7b3');
    type(/^Expires/, '1d');
    await prepare();
    expect(form().querySelector('[role="alert"]')?.textContent).toContain('A session key may not approve or permit tokens.');
    expect(protocol.buildSessionGrant.mock.calls[0]![0].spec.selectors).toEqual([NAVIGATOR_DEFAULT_SELECTOR, '0x095ea7b3']);
    expect(procedures()).not.toContain('navigator.onchain.bind');
    expect(unsigned()).toBeNull();
    expect(status()).toBeNull();
  });

  it('a valid test-network grant builds the call for the Navigator’s key, records it, and shows the unsigned call', async () => {
    await mount();
    type(/^Spend cap/, '1');
    type(/^Expires/, '1d');
    const before = Math.floor(Date.now() / 1000);
    await prepare();
    const spec = protocol.buildSessionGrant.mock.calls[0]![0].spec;
    expect(spec).toMatchObject({
      key: SIGNER,
      // The router and the Navigator's pool, so the key can reach the pool it trades in.
      targets: [ROUTER, POOL],
      selectors: [NAVIGATOR_DEFAULT_SELECTOR],
      spendLimitWei: '1000000000000000000',
    });
    expect(spec.validUntil - before).toBe(86_400);
    const bind = sent.find((entry) => entry.procedure === 'navigator.onchain.bind')!.input as Record<string, unknown>;
    expect(bind).toEqual({
      chainId: 84532,
      account: SMART,
      specHash: SPEC_HASH,
      spendLimitWei: '1000000000000000000',
      validUntil: spec.validUntil,
      targets: [ROUTER, POOL],
      selectors: [NAVIGATOR_DEFAULT_SELECTOR],
    });
    expect(bind).not.toHaveProperty('sessionKey');
    expect(unsigned()).toBe(GRANT_DATA);
    expect(text()).toContain(SMART);
    // Not on the chain yet: the chain read says so, and the scope shown is only what was prepared.
    expect(status()).toBe('Not granted');
    expect(text()).toContain('prepared here; the chain does not show it');
  });

  it('Sign in wallet sends the call, follows it until mined, and reads Active from the chain', async () => {
    await mount();
    type(/^Spend cap/, '1');
    type(/^Expires/, '1d');
    await prepare();
    protocol.sessionsList.mockResolvedValue(list([chainKey()], '41'));
    await act(async () => button('Sign in wallet').click());
    await flush();
    expect(wallet.sendSequence.mock.calls[0]![0].steps[0].request).toEqual({ kind: 'transaction', to: SMART, data: GRANT_DATA });
    await flush(1_000);
    expect(status()).toBe('Active');
    expect(unsigned()).toBeNull();
  });
});

describe('the binding, read from the chain', () => {
  it('shows scope, expiry, spent and Active from the chain, and a Revoke that reads Revoking with the unsigned revoke', async () => {
    answers['navigator.onchain.binding'] = { ok: true, data: { binding: binding() } };
    protocol.sessionsList.mockResolvedValue(list([chainKey({ spentWei: '0' })]));
    await mount();
    const terms = [...region().querySelectorAll('dt')].map((node) => node.textContent);
    expect(terms).toEqual(expect.arrayContaining(['Scope', 'Expiry', 'Status']));
    expect(text()).toContain(`${NAVIGATOR_DEFAULT_SELECTOR} on ${ROUTER}`);
    expect(text()).toContain('2030-03-17 17:46 UTC');
    expect(text()).toContain('0 of 1 TEST ETH');
    expect(status()).toBe('Active');
    await act(async () => button('Revoke').click());
    await flush();
    expect(procedures()).toContain('navigator.onchain.revoke');
    expect(protocol.buildSessionRevoke).toHaveBeenCalledWith({ account: SMART, sessionKey: SIGNER });
    expect(unsigned()).toBe(REVOKE_DATA);
    expect(status()).toBe('Revoking');
  });

  it('after a reload with a revoke asked but not signed, still reads Revoking and offers the revoke call again', async () => {
    answers['navigator.onchain.binding'] = { ok: true, data: { binding: binding({ revokeRequestedAt: '2026-11-10T01:00:00.000Z' }) } };
    protocol.sessionsList.mockResolvedValue(list([chainKey()]));
    await mount();
    expect(status()).toBe('Revoking');
    expect(unsigned()).toBe(REVOKE_DATA);
    protocol.sessionsList.mockResolvedValue(list([chainKey({ status: 'revoked' })], '41'));
    await act(async () => button('Sign in wallet').click());
    await flush();
    await flush(1_000);
    expect(status()).toBe('Revoked');
    expect(unsigned()).toBeNull();
  });

  it('reads Revoked and Expired from the chain, and Not granted while the chain has no key', async () => {
    const b = binding({ revokeRequestedAt: '2026-11-10T01:00:00.000Z' });
    expect(keyStatus(b, null)).toBe('none');
    expect(keyStatus(b, chainKey({ status: 'revoked' }) as never)).toBe('revoked');
    expect(keyStatus(b, chainKey({ status: 'expired' }) as never)).toBe('expired');
    expect(keyStatus(b, chainKey() as never)).toBe('revoking');
    expect(keyStatus(binding(), chainKey() as never)).toBe('active');
  });

  it('says when the key on the chain has another scope than the grant prepared here', async () => {
    answers['navigator.onchain.binding'] = { ok: true, data: { binding: binding() } };
    protocol.sessionsList.mockResolvedValue(list([chainKey({ spendLimitWei: '5' })]));
    await mount();
    expect(text()).toContain('another scope than the grant prepared here');
  });
});

describe('The Navigator trading inside the cap you signed', () => {
  const order = {
    id: '88888888-8888-4888-8888-888888888888',
    sessionId: '77777777-7777-4777-8777-777777777777',
    orderKey: 'agents:navigator:order:77777777-7777-4777-8777-777777777777:r-1',
    placedBy: 'assistant' as const,
    text: 'TEST: swap 0.1 TEST Wrapped ETH for TEST Token B',
    chainId: 84532,
    account: SMART,
    pool: '0x' + 'cc'.repeat(20),
    tokenIn: '0x' + 'e7'.repeat(20),
    tokenInSymbol: 'TESTWETH',
    tokenOut: '0x' + 'b0'.repeat(20),
    tokenOutSymbol: 'TESTB',
    amountInWei: '100000000000000000',
    minOutWei: '98000000000000000000',
    status: 'filled' as const,
    txHash: '0x' + '12'.repeat(32),
    createdAt: '2026-11-10T00:00:00.000Z',
  };
  const trading = {
    key: {
      chainId: 84532,
      account: SMART,
      capWei: '1000000000000000000',
      spentWei: '100000000000000000',
      leftWei: '900000000000000000',
      validUntil: 2_000_000_000,
    },
  };
  it('shows the order tagged by your assistant, its trade, its status and its hash, and asks nothing', async () => {
    await act(async () => root.render(<NavigatorOrderView order={order} />));
    const view = host.querySelector('section[aria-label="Order sent"]')!;
    expect(view.querySelector('[data-placed-by="assistant"]')!.textContent).toBe('by your assistant');
    expect(view.textContent).toContain('0.1 TESTWETH for at least 98 TESTB');
    expect(view.textContent).toContain('Filled on the chain');
    expect(view.textContent).toContain(order.txHash);
    expect(view.textContent).not.toMatch(/approv/i);
  });
  it('names the cap you signed above the cap, as a refusal, and says nothing was signed', async () => {
    const failure = { ok: false as const, code: 'FORBIDDEN', message: 'agents.navigator_trade_over_cap' };
    await act(async () => root.render(<NavigatorTradeRefusalView failure={failure as never} trading={trading} />));
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.getAttribute('data-refusal-code')).toBe('agents.navigator_trade_over_cap');
    expect(alert.textContent).toContain('above the cap you signed, 1 TEST ETH, of which 0.9 TEST ETH is left');
    expect(host.textContent).toContain('Nothing was signed or sent');
  });
  it('refuses moving money out by name', async () => {
    const failure = { ok: false as const, code: 'FORBIDDEN', message: 'agents.navigator_money_out_forbidden' };
    await act(async () => root.render(<NavigatorTradeRefusalView failure={failure as never} trading={trading} />));
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('never moves money out of your account');
  });
  it('shows the cap line from the chain, or that there is no live key', async () => {
    await act(async () => root.render(<NavigatorCapLine trading={trading} />));
    expect(host.textContent).toContain('The cap you signed: 1 TEST ETH. The Navigator’s trades hold 0.1; 0.9 TEST ETH is left.');
    await act(async () => root.render(<NavigatorCapLine trading={{ key: null }} />));
    expect(host.textContent).toContain('holds no live session key');
  });
});
