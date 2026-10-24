// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProtocolApi, RepresentationStatus } from '../api';
import { RepresentationPanel, type RepresentationEnd } from './RepresentationPanel';

const ADDR = '0x1111111111111111111111111111111111111111';
const wallet = { address: ADDR as string | null, sign: vi.fn() };
vi.mock('./WalletProvider', () => ({ useWallet: () => wallet }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const STATUS: RepresentationStatus = { version: 'TEST-1', text: 'TEST text', message: 'sign me', accepted: false, acceptedAt: null };
let host: HTMLDivElement, root: Root;

const mount = async (accept: ProtocolApi['representationAccept']) => {
  const ends: RepresentationEnd[] = [];
  const api = { representationAccept: accept } as unknown as ProtocolApi;
  await act(async () => {
    root.render(<RepresentationPanel address={ADDR} status={STATUS} api={api} onEnd={(end) => ends.push(end)} />);
  });
  return ends;
};
const acceptAndSign = async () => {
  await act(async () => {
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
  });
  await act(async () => {
    host.querySelector<HTMLButtonElement>('button')!.click();
  });
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  wallet.address = ADDR;
  wallet.sign.mockReset().mockResolvedValue({ status: 'signed', signature: '0xsig' });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('representation panel', () => {
  it('signs the exact message, records it for the address it was read for, and ends accepted', async () => {
    const accept = vi
      .fn()
      .mockResolvedValue({ ok: true, data: { address: ADDR, version: 'TEST-1', acceptedAt: '2026-10-24T07:00:00.000Z' } });
    const ends = await mount(accept);
    await acceptAndSign();
    expect(wallet.sign).toHaveBeenCalledWith({ kind: 'message', message: 'sign me' });
    expect(accept).toHaveBeenCalledWith({ address: ADDR, version: 'TEST-1', signature: '0xsig' });
    expect(ends).toEqual([{ kind: 'accepted' }]);
  });

  it.each([
    ['compliance.representation_version_stale', /changed while you read it/],
    ['compliance.representation_signature_not_owner', /does not check out against your wallet address/],
    ['internal', /was not recorded/],
  ])('names the refusal %s instead of a bare retry', async (code, message) => {
    const ends = await mount(vi.fn().mockResolvedValue({ ok: false, code, message: 'refused' }));
    await acceptAndSign();
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ kind: 'failed', message: expect.stringMatching(message) });
  });

  it('a region refusal at accept ends as the region refusal', async () => {
    const ends = await mount(vi.fn().mockResolvedValue({ ok: false, code: 'edge.geo_blocked', message: 'blocked' }));
    await acceptAndSign();
    expect(ends).toEqual([{ kind: 'region' }]);
  });

  it('a wallet switched to another account is not asked to sign a message naming the old one', async () => {
    const accept = vi.fn();
    const ends = await mount(accept);
    wallet.address = '0x2222222222222222222222222222222222222222';
    await acceptAndSign();
    expect(wallet.sign).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
    expect(ends[0]).toMatchObject({ kind: 'failed', message: expect.stringMatching(/switched to another account/) });
  });

  it('closed while the wallet is asking: the accept ends quietly', async () => {
    let resolveSign: (value: unknown) => void = () => undefined;
    wallet.sign.mockReturnValue(new Promise((resolve) => (resolveSign = resolve)));
    const accept = vi.fn().mockResolvedValue({ ok: true, data: {} });
    const ends = await mount(accept);
    await acceptAndSign();
    act(() => root.unmount());
    root = createRoot(host);
    await act(async () => resolveSign({ status: 'signed', signature: '0xsig' }));
    expect(ends).toEqual([]);
  });
});
