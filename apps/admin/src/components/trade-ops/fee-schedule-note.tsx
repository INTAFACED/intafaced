import type { EffectiveFees } from '@/lib/trade-ops/fees-model';
import type { Outcome } from '@/lib/trade-ops/outcome';
import { ReadProblem } from './blocker-panel';

/**
 * Says where the fee numbers on a desk page come from. Customers are charged the owner fee schedule; the maker/taker bps on a
 * market's listing row are metadata and are not charged. A refused or unread schedule shows its own notice, never a number.
 */
export function FeeScheduleNote({ fees }: { fees: Outcome<EffectiveFees> }) {
  if (fees.kind !== 'ok')
    return <ReadProblem outcome={fees} title="Fees charged could not be read: fee cells show the refusal or a dash" />;
  return (
    <p className="text-xs text-fg-2" role="note">
      Fee charged is the owner fee schedule ({fees.data.source}, version {fees.data.version}) before any customer rank discount. Listing-row
      bps are metadata and are not charged.
    </p>
  );
}
