import { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import { discoverWallets, firstAddress, parseChainId, type Eip1193Provider } from '../protocol/wallet/eip1193';

// hand-declared-ok: svc-identity's wallet challenge answer has no browser-safe schema in packages/contracts yet
/** The message a wallet signs to link it or to sign in with it (svc-identity, EIP-4361). */
export const walletChallengeSchema = z.object({ flowId: z.string().guid(), message: z.string().min(1), expiresAt: z.string() });
export type WalletChallenge = z.infer<typeof walletChallengeSchema>;

/** A wallet's answer: the challenge it answered and its own signature over the message. */
export type WalletAnswer = { address: string; flowId: string; message: string; signature: string };

export type WalletSigned =
  | { status: 'signed'; answer: WalletAnswer }
  /** No wallet in this browser announced itself. */
  | { status: 'none' }
  /** The person pressed Reject in the wallet: nothing was signed. */
  | { status: 'rejected' }
  | { status: 'failed' }
  | { status: 'refused'; result: Extract<ApiResult<unknown>, { ok: false }> };

const REJECTED = new Set([4001, 'ACTION_REJECTED']);

/** The first wallet this browser announces (EIP-6963), or null when none answers in a moment. */
export async function findBrowserWallet(target: Window = window, waitMs = 200): Promise<Eip1193Provider | null> {
  return new Promise((resolve) => {
    let first: Eip1193Provider | null = null;
    let stop: (() => void) | null = null;
    const finish = () => {
      clearTimeout(timer);
      stop?.();
      resolve(first);
    };
    const timer = setTimeout(finish, waitMs);
    stop = discoverWallets(target, (wallets) => {
      if (first || !wallets[0]) return;
      first = wallets[0].provider;
      // A wallet may announce inside the request itself, before `stop` exists: that case finishes just below.
      if (stop) finish();
    });
    if (first) finish();
  });
}

function utf8Hex(text: string): string {
  return `0x${Array.from(new TextEncoder().encode(text), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Ask the wallet for its account and network, ask the service for the message to sign, and have the wallet sign it.
 * The key stays in the wallet; the service checks the signature. `found` is a wallet the caller already discovered.
 */
export async function signWithBrowserWallet(
  challenge: (address: string, chainId: number) => Promise<ApiResult<WalletChallenge>>,
  found?: Eip1193Provider | null,
): Promise<WalletSigned> {
  const provider = found ?? (await findBrowserWallet());
  if (!provider) return { status: 'none' };
  try {
    const address = firstAddress(await provider.request({ method: 'eth_requestAccounts' }));
    const chainId = parseChainId(await provider.request({ method: 'eth_chainId' }));
    if (!address || !chainId) return { status: 'failed' };
    const issued = await challenge(address, chainId);
    if (!issued.ok) return { status: 'refused', result: issued };
    const signature = await provider.request({ method: 'personal_sign', params: [utf8Hex(issued.data.message), address] });
    if (typeof signature !== 'string' || !signature.startsWith('0x')) return { status: 'failed' };
    return {
      status: 'signed',
      answer: { address: address.toLowerCase(), flowId: issued.data.flowId, message: issued.data.message, signature },
    };
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    return REJECTED.has(code as number) ? { status: 'rejected' } : { status: 'failed' };
  }
}

export type TextSigned =
  { status: 'signed'; address: string; signature: string } | { status: 'none' } | { status: 'rejected' } | { status: 'failed' };

/** Have the browser's wallet sign one exact text (EIP-191 personal_sign). The key stays in the wallet. */
export async function signTextWithBrowserWallet(message: string, found?: Eip1193Provider | null): Promise<TextSigned> {
  const provider = found ?? (await findBrowserWallet());
  if (!provider) return { status: 'none' };
  try {
    const address = firstAddress(await provider.request({ method: 'eth_requestAccounts' }));
    if (!address) return { status: 'failed' };
    const signature = await provider.request({ method: 'personal_sign', params: [utf8Hex(message), address] });
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return { status: 'failed' };
    return { status: 'signed', address: address.toLowerCase(), signature };
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    return REJECTED.has(code as number) ? { status: 'rejected' } : { status: 'failed' };
  }
}
