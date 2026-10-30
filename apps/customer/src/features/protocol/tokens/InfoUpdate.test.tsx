// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InfoUpdate } from './InfoUpdate';
import { tokensCopy } from './copy';

const OWNER = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x00000000000000000000000000000000000a11ce';
const challenge = {
  nonce: 'a'.repeat(32),
  token: TOKEN,
  chainId: 84532,
  message: 'INTAFACED — prove you control this token',
  issuedAt: '2026-10-30T12:00:00.000Z',
  expiresAt: '2026-10-30T12:05:00.000Z',
};

const wallet = { address: OWNER as string | null, sign: vi.fn() };
vi.mock('../wallet/WalletProvider', () => ({ useWallet: () => wallet }));
vi.mock('../wallet/RepresentationPanel', () => ({ RepresentationPanel: () => <div data-panel="representation" /> }));
const mutate = vi.fn();
const query = vi.fn();
vi.mock('../../session/session', () => ({ useApi: () => ({ mutate, query }) }));
vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

const { t } = tokensCopy.forLocale('en');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const button = (name: string) =>
  [...host.ownerDocument.querySelectorAll('button')].find((node) => node.textContent?.trim() === name) as HTMLButtonElement | undefined;
const click = async (name: string) => {
  await act(async () => {
    button(name)!.click();
  });
};
const text = () => host.ownerDocument.body.textContent ?? '';
const settle = () => act(async () => undefined);

/** A promise the test resolves when it chooses, to hold a call in flight. */
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  mutate.mockReset();
  query.mockReset();
  wallet.sign.mockReset();
  wallet.address = OWNER;
  // The representation was accepted before: the gate lets the signature through.
  query.mockResolvedValue({
    ok: true,
    data: { version: 'TEST-1', text: 't', message: 'm', accepted: true, acceptedAt: '2026-10-30T11:00:00.000Z' },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('Request an info update (D-launch-listing-01)', () => {
  it('signs a challenge once, however often Sign is pressed, and shows the stored proof', async () => {
    mutate.mockImplementation(async (_m: string, procedure: string) =>
      procedure === 'listing.ownershipChallenge'
        ? { ok: true, data: challenge }
        : { ok: true, data: { token: TOKEN, signer: OWNER, blockNumber: '42', verifiedAt: '2026-10-30T12:01:00.000Z' } },
    );
    const signing = held<{ status: 'signed'; signature: string }>();
    wallet.sign.mockReturnValue(signing.promise);
    await act(async () => root.render(<InfoUpdate token={TOKEN} t={t} />));
    await click(t('updateRequest'));
    await settle();
    expect(host.ownerDocument.querySelector('[data-testid="token-update-challenge"]')?.textContent).toBe(challenge.message);
    await click(t('updateSign'));
    await settle();
    // While the wallet asks, Sign is held: a second press asks nothing more.
    expect(button(t('updateSign'))!.disabled).toBe(true);
    button(t('updateSign'))!.click();
    signing.resolve({ status: 'signed', signature: `0x${'1'.repeat(130)}` });
    await settle();
    expect(wallet.sign).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls.filter(([, procedure]) => procedure === 'listing.verifyOwnership')).toHaveLength(1);
    expect(text()).toContain(`Ownership proven: ${OWNER} owns this token (read at block 42). The proof is stored.`);
  });

  it('a dialog closed while the wallet asks stays closed when the answer comes', async () => {
    mutate.mockResolvedValue({ ok: true, data: challenge });
    const signing = held<{ status: 'signed'; signature: string }>();
    wallet.sign.mockReturnValue(signing.promise);
    await act(async () => root.render(<InfoUpdate token={TOKEN} t={t} />));
    await click(t('updateRequest'));
    await settle();
    await click(t('updateSign'));
    await settle();
    const dialog = host.ownerDocument.querySelector('dialog');
    expect(dialog).not.toBeNull();
    await act(async () => {
      (host.ownerDocument.querySelector('dialog header button[aria-label]') as HTMLButtonElement).click();
    });
    expect(host.ownerDocument.querySelector('dialog')).toBeNull();
    signing.resolve({ status: 'signed', signature: `0x${'1'.repeat(130)}` });
    await settle();
    expect(host.ownerDocument.querySelector('dialog')).toBeNull();
    expect(mutate.mock.calls.filter(([, procedure]) => procedure === 'listing.verifyOwnership')).toHaveLength(0);
  });

  it('a token that names no owner is refused when the dialog opens, before any signature', async () => {
    mutate.mockResolvedValue({
      ok: false,
      reason: 'forbidden',
      code: 'PRECONDITION_FAILED',
      message: 'This token contract names no owner that can be read, so ownership cannot be proven. Nothing is guessed.',
    });
    await act(async () => root.render(<InfoUpdate token={TOKEN} t={t} />));
    await click(t('updateRequest'));
    await settle();
    expect(text()).toContain('names no owner that can be read');
    expect(host.ownerDocument.querySelector('[data-testid="token-update-challenge"]')).toBeNull();
    expect(wallet.sign).not.toHaveBeenCalled();
  });
});
