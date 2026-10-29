// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const answers = new Map<string, unknown>();
const query = vi.fn((_module: string, procedure: string, input: { hash?: string }) => {
  if (procedure !== 'explorer.tx.get') return new Promise(() => undefined);
  const answer = answers.get(input.hash!);
  return answer === undefined ? new Promise(() => undefined) : Promise.resolve(answer);
});
vi.mock('../../session/session', () => ({ useApi: () => ({ query }) }));
import { ChainHome } from './ChainHome';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const A = `0x${'a'.repeat(64)}`;
const B = `0x${'b'.repeat(64)}`;
const tx = (hash: string, extra: object = {}) => ({
  ok: true,
  data: { chainId: 84532, hash, status: 'success', replacingHash: null, orphaned: null, ...extra },
});
let host: HTMLDivElement;
let root: Root;

const box = () => host.querySelector<HTMLInputElement>('input[type="search"]')!;
async function search(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box(), value);
    box().dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    box().form!.requestSubmit();
  });
}
const networks = () => host.querySelector('[aria-label="Networks searched"]')?.textContent ?? '';

beforeEach(async () => {
  answers.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<ChainHome chain={{ status: 'ready', chainId: 84532 }} />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('Chain home search', () => {
  it('never shows the first hash’s answer for a second hash still being checked', async () => {
    answers.set(A, tx(A));
    await search(A);
    expect(networks()).toContain('Base Sepolia test network: Found (Success)');
    await search(B);
    expect(networks()).toContain('Checking Base Sepolia test network');
    expect(networks()).not.toContain('Found');
  });
  it('says Not found on this network for a hash the indexer does not know', async () => {
    answers.set(A, { ok: false, reason: 'not_mounted', message: 'protocol.not_found', code: 'NOT_FOUND' });
    await search(A);
    expect(networks()).toContain('Base Sepolia test network: Not found on this network');
    expect(networks()).toContain('Local test chain: not checked: this explorer reads only Base Sepolia test network');
  });
  it('never reads a reorged or replaced transaction as plain Success', async () => {
    answers.set(A, tx(A, { orphaned: { reason: 'replaced by a heavier branch' } }));
    await search(A);
    expect(networks()).toContain('Found (Success, in a reorged block: replaced by a heavier branch)');
    // As the indexer sends it: replaced only ever comes with the reorged block that lost it.
    answers.set(B, tx(B, { status: 'replaced', replacingHash: `0x${'c'.repeat(64)}`, orphaned: { reason: 'reorg' } }));
    await search(B);
    expect(networks()).toContain('Found (Replaced by 0xcccccccc…cccccc)');
  });
});
