import { HIDDEN_MASK } from '@intafaced/ui/lit';
import { fmtUsd } from './deps';

/** A dollar amount in tabular digits, or the kit's mask while balances are hidden. */
export function MaskedMoney({ usd, hidden }: { usd: string | null; hidden: boolean }) {
  return (
    <span data-money="" dir="ltr">
      {hidden ? HIDDEN_MASK : fmtUsd(usd)}
    </span>
  );
}
