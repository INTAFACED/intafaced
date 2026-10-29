// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalsPanel, spenderText } from './ApprovalsPanel';

const ME = '0x1111111111111111111111111111111111111111';
const POOL = '0x1000000000000000000000000000000000000001';
const A = { address: '0x00000000000000000000000000000000000a11ce', name: 'TEST Token A', symbol: 'TESTA', decimals: 6 };
const B = { address: '0x00000000000000000000000000000000000b0b00', name: 'TEST Token B', symbol: 'TESTB', decimals: 18 };
const HASH = `0x${'c'.repeat(64)}`;
const ROW = { token: A.address, spender: POOL, allowance: '10000000', unlimited: false, pool: { token0: A.address, token1: B.address } };
const answer = (rows: unknown[]) => ({
  ok: true,
  data: { owner: ME, blockNumber: '40', logsFromBlock: '0', tokens: [A, B], rows, unread: 0, truncated: false },
});

const wallet = {
  status: 'connected',
  address: ME as string | null,
  guard: { ok: true },
  sendSequence: vi.fn(),
  read: vi.fn(),
};
const allowances = vi.fn();
const buildRevoke = vi.fn();
const representationStatus = vi.fn();
vi.mock('./WalletProvider', () => ({ useWallet: () => wallet }));
vi.mock('../api', () => ({
  createProtocolApi: () => ({ allowances, buildRevoke, representationStatus, representationAccept: vi.fn() }),
}));
vi.mock('../../session/session', () => ({ useApi: () => ({}) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const text = () => host.ownerDocument.body.textContent ?? '';
const rows = () => [...host.querySelectorAll('tbody tr')];
const revokeButton = () => [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Revoke') as HTMLButtonElement;
const mount = async () => {
  await act(async () => {
    root.render(<ApprovalsPanel />);
  });
};
const tick = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  wallet.status = 'connected';
  wallet.address = ME;
  allowances.mockReset().mockResolvedValue(answer([ROW]));
  buildRevoke
    .mockReset()
    .mockResolvedValue({ ok: true, data: { to: A.address, data: `0x095ea7b3${'0'.repeat(128)}`, value: '0', summary: 'revoke' } });
  representationStatus.mockReset().mockResolvedValue({ ok: true, data: { accepted: true } });
  wallet.sendSequence.mockReset().mockResolvedValue({ status: 'sent', hashes: [HASH] });
  wallet.read.mockReset().mockResolvedValue({ status: '0x1', blockNumber: '0x29' });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('Approvals', () => {
  it('lists the live allowance read from the chain for the connected address', async () => {
    await mount();
    expect(allowances).toHaveBeenCalledWith(ME, expect.anything());
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.textContent).toContain('TEST Token A');
    expect(rows()[0]!.textContent).toContain('10 TESTA');
    expect(rows()[0]!.textContent).toContain('Pool TESTA/TESTB');
    expect(text()).toContain('read from the chain at block 40');
  });

  it('revokes through the sheet with approve(spender, 0) and drops the row once mined and read again', async () => {
    await mount();
    await act(async () => revokeButton().click());
    expect(buildRevoke).toHaveBeenCalledWith({ token: A.address, spender: POOL });
    const sequence = wallet.sendSequence.mock.calls[0]![0];
    expect(sequence.title).toBe('Revoke steps');
    expect(sequence.steps).toHaveLength(1);
    expect(sequence.steps[0].request).toEqual({ kind: 'transaction', to: A.address, data: `0x095ea7b3${'0'.repeat(128)}` });
    expect(text()).toContain('Revoking');
    allowances.mockResolvedValue(answer([]));
    await tick(1_100);
    expect(wallet.read).toHaveBeenCalledWith('eth_getTransactionReceipt', [HASH]);
    expect(allowances).toHaveBeenCalledTimes(2);
    expect(text()).not.toContain('10 TESTA');
    expect(text()).toContain('No live approvals');
  });

  it('keeps the row and says so when the revoke reverts', async () => {
    wallet.read.mockResolvedValue({ status: '0x0', blockNumber: '0x29' });
    await mount();
    await act(async () => revokeButton().click());
    await tick(1_100);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('failed on the network');
    expect(allowances).toHaveBeenCalledTimes(1);
    expect(rows()[0]!.textContent).toContain('10 TESTA');
  });

  it('says when the revoke is not mined in time and stops following it', async () => {
    wallet.read.mockResolvedValue(null);
    await mount();
    await act(async () => revokeButton().click());
    await tick(121_500);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('not mined in time');
    expect(revokeButton().disabled).toBe(false);
  });

  it('sends nothing when the person cancels on the sheet', async () => {
    wallet.sendSequence.mockResolvedValue({ status: 'rejected', sent: [] });
    await mount();
    await act(async () => revokeButton().click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('You cancelled. Nothing was sent.');
    expect(wallet.read).not.toHaveBeenCalled();
  });

  it('refuses in words when the revoke cannot be built', async () => {
    buildRevoke.mockResolvedValue({ ok: false, code: 'protocol.approval_target_zero', reason: 'error', message: 'x' });
    await mount();
    await act(async () => revokeButton().click());
    expect(wallet.sendSequence).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('could not be built');
  });

  it('never fails open when the representation is unpublished', async () => {
    representationStatus.mockResolvedValue({ ok: false, code: 'compliance.representation_unset', reason: 'error', message: 'x' });
    await mount();
    await act(async () => revokeButton().click());
    expect(buildRevoke).not.toHaveBeenCalled();
    expect(wallet.sendSequence).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('not published');
  });

  it('shows a refused read as a refusal, with no rows invented', async () => {
    allowances.mockResolvedValue({
      ok: false,
      code: 'protocol.amm_factory_unset',
      reason: 'error',
      message: 'AMM factory is not configured',
    });
    await mount();
    expect(host.querySelector('[data-testid="failure"]')).not.toBeNull();
    expect(revokeButton()).toBeUndefined();
  });

  it('reads nothing without a connected wallet and says what it needs', async () => {
    wallet.status = 'disconnected';
    wallet.address = null;
    await mount();
    expect(allowances).not.toHaveBeenCalled();
    expect(text()).toContain('Connect a wallet to see this section.');
  });

  it('says how many allowances could not be read rather than showing them as zero', async () => {
    allowances.mockResolvedValue({ ok: true, data: { ...answer([]).data, unread: 2, truncated: true } });
    await mount();
    expect(text()).toContain('could not be read because their token did not answer (2)');
    expect(text()).toContain('not all of them are shown');
  });
});

describe('spenderText', () => {
  it('names a pool by its pair and any other spender by its address', () => {
    expect(spenderText(ROW, [A, B], (pair) => `Pool ${pair}`)).toBe('Pool TESTA/TESTB · 0x1000…0001');
    expect(spenderText({ ...ROW, pool: null }, [A, B], (pair) => pair)).toBe(POOL);
  });
});
