import type { CryptoChainPort } from './chain-port.js';

export interface OpenCryptoPayment {
  readonly paymentId: string;
  readonly assetId: string;
  /** A business's own receiving address (launch money model): watched as given, never derived. */
  readonly address?: string;
}

/**
 * The watch set lives in the chain object's memory, so a restart empties it. Re-register every payment still waiting for a
 * deposit; the address is derived from the payment, so this hands back the one the payer was already given. A payment whose
 * asset this chain no longer carries is logged and skipped, not allowed to block the rest.
 */
export async function restoreOpenDepositWatches(
  chain: Pick<CryptoChainPort, 'acceptanceAddress' | 'watchAddress'>,
  listOpen: () => Promise<readonly OpenCryptoPayment[]>,
  log: (message: string, extra?: Record<string, unknown>) => void,
): Promise<number> {
  let restored = 0;
  for (const open of await listOpen()) {
    try {
      if (open.address) await chain.watchAddress(open.paymentId, open.assetId, open.address);
      else await chain.acceptanceAddress(open.paymentId, open.assetId);
      restored += 1;
    } catch (err) {
      log('could not restore a deposit watch', { paymentId: open.paymentId, assetId: open.assetId, error: String(err) });
    }
  }
  return restored;
}
