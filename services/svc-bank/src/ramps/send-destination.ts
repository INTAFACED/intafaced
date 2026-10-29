import type { BankSendDestination, BankSendDestinationInput } from '@intafaced/contracts';
import { isEvmAddressRef, type WithdrawDestination } from '../withdraw-destination.js';
import { destinationReadiness, type CustomerRampDeps } from './customer-ramps.js';

/**
 * May money be sent to this address now (J-wallet-05 #6, issue #6517)? svc-pay asks before it claims a withdrawal to a wallet
 * outside the platform, over `ramps.destinations.sendable` (packages/contracts `bank-send-destination.ts`), so the address
 * book's own rules decide on the server and not in a form.
 *
 * - Only a saved customer entry counts: the legacy offramp slot is not tied to an asset or network and is never a match.
 * - The entry must be of the same asset, on the same network, for the same address. An EVM address matches whatever its
 *   letter case (the case is a checksum, not part of the address); any other address must match exactly. A send carries no
 *   tag or memo, so an entry saved with one is not a match: sending without it could lose the money.
 * - The same address saved for the asset on another network only is `other_network`; not saved for the asset at all is
 *   `not_saved`.
 * - A match answers the book's own readiness (`destinationReadiness`): the security lock first, then blocked, waiting for
 *   approval, no published cooling-off, a cooling-off still running, or ready. A lock that cannot be read throws, and the
 *   caller reads that as unavailable.
 *
 * It reads and never writes. If it crashes here, whose funds are stranded? None: svc-pay asks before any claim or hold.
 */
export async function sendableDestination(
  deps: CustomerRampDeps,
  input: BankSendDestinationInput,
  now?: Date,
): Promise<BankSendDestination> {
  const assetId = input.assetId.trim().toUpperCase();
  const network = input.network.trim().toLowerCase();
  const sameAddress = addressMatcher(input.ref);
  const saved = (await deps.destinations.list(input.userId)).filter(
    (row: WithdrawDestination) => row.origin === 'customer' && row.state !== 'archived' && row.assetId === assetId && sameAddress(row.ref),
  );
  const match = saved.find((row) => row.network === network && row.tag === null);
  if (!match) {
    const elsewhere = saved.some((row) => row.network !== network);
    return { state: elsewhere ? 'other_network' : 'not_saved', destinationId: null, coolingOffEndsAt: null };
  }
  const ready = await destinationReadiness(deps, { userId: input.userId, destinationId: match.destinationId }, now);
  return { state: ready.state, destinationId: ready.destinationId, coolingOffEndsAt: ready.coolingOffEndsAt };
}

function addressMatcher(ref: string): (saved: string) => boolean {
  const sent = ref.trim();
  if (isEvmAddressRef(sent)) {
    const lower = sent.toLowerCase();
    return (saved) => saved.trim().toLowerCase() === lower;
  }
  return (saved) => saved.trim() === sent;
}
