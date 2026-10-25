import type { RailEvent } from './rail-adapter.js';
import { MemoryChain, type CryptoChainPort } from './chain-port.js';

/**
 * The in-memory reference chain has no blocks to watch: nothing reaches it, so the crypto rail, which reads a
 * transfer back from the chain before it authorizes or captures (never from the webhook alone), found nothing and
 * a payment opened on the hosted checkout of a dev or test stack could never complete. On that chain only, a
 * VERIFIED delivery is what the chain says: a `captured` transfer is recorded on the in-memory chain before the
 * delivery is applied, and the rail then reads it back as it would from a real chain; a `chain.reorged` one takes
 * its confirmations away again.
 *
 * - A redelivery of the same transfer never makes it shallower than the chain already has it.
 * - The payer's address is not in a delivery, so none is recorded: a refund refuses for a missing destination
 *   rather than going to an invented one.
 * - A transfer with a new hash is added beside the ones before it, so a payer can pay in parts (J-merchant-04 step 5);
 *   the same hash again is the same transfer seen deeper.
 *
 * Never a live chain: `defaultChainFor` gives staging and prod a live or an unconfigured chain, never this one, and
 * an unsigned or forged delivery never reaches here (the caller passes only what `verifyWebhook` accepted).
 */
export async function feedSandboxChain(chain: CryptoChainPort, event: RailEvent | null): Promise<boolean> {
  if (!(chain instanceof MemoryChain) || !event?.chain) return false;
  const txHash = event.chain.txHash;
  const known = (await chain.inboundTransfers(event.railRef)).find((t) => t.txHash === txHash);
  if (event.type === 'chain.reorged') {
    if (!known) return false;
    chain.setConfirmations(event.railRef, 0, txHash);
    return true;
  }
  if (event.type !== 'captured' || event.amount === undefined || event.amount <= 0n || !event.assetId) return false;
  if (known && known.confirmations >= event.chain.confirmations) return false;
  chain.creditAnother({
    address: event.railRef,
    assetId: event.assetId,
    amount: event.amount,
    from: '',
    confirmations: event.chain.confirmations,
    txHash,
  });
  return true;
}
