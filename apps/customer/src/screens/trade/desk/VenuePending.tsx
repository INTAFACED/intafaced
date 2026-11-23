import { useState } from 'react';
import { Button as KitButton } from '../../../shared/ui';
import { displayAmount } from '../../../shared/money';
import { usePolled } from '../../../features/protocol/wallet/use-polled';
import { type VenueOrder } from '../../../features/trade/venue-api';
import { VENUE_POLL_MS, useVenueApi } from '../../../features/trade/venue/VenueKit';
import { deskCopy } from './copy';
import { spotVenueCopy } from './venue-copy';
import { type PendingOrder } from './venue-desk';

/**
 * One order with no definite answer, looked up on the venue by its client id until the venue names it (J-cex-spot-02 #3,
 * #4). Not found is only that: nothing is sent again unless the person asks for the same order, under the same key.
 */
export function PendingCheck({
  owner,
  entry,
  onFound,
  onSendAgain,
}: {
  owner: string;
  entry: PendingOrder;
  onFound: (entry: PendingOrder, order: VenueOrder) => void;
  onSendAgain: (entry: PendingOrder) => Promise<void>;
}) {
  const { t } = spotVenueCopy.useCopy();
  const d = deskCopy.useCopy().t;
  const venue = useVenueApi();
  const [sending, setSending] = useState(false);
  const read = usePolled(
    async (signal) => {
      const answer = await venue.orderByClientId(owner, entry.clientOrderId, signal);
      // The venue named the order: the row hands it up as the look-up answers, and goes.
      if (answer.ok && answer.data.value) onFound(entry, answer.data.value);
      return answer;
    },
    `pending:${owner}:${entry.clientOrderId}`,
    VENUE_POLL_MS,
  );
  const order = read.data?.value ?? null;
  const asset = entry.intent.symbol.split('-')[0] ?? entry.intent.symbol;
  return (
    <div data-pending={entry.clientOrderId}>
      <p role="status">
        {t('Pending checking', {
          side: entry.intent.side === 'buy' ? d('Buy') : d('Sell'),
          amount: displayAmount(entry.intent.amount),
          asset,
          id: entry.clientOrderId,
        })}
      </p>
      {read.data && !order ? (
        <>
          <p>{t('Pending missing', { id: entry.clientOrderId })}</p>
          <KitButton
            variant="secondary"
            disabled={sending}
            onClick={() => {
              setSending(true);
              void onSendAgain(entry).finally(() => setSending(false));
            }}
          >
            {t('Send same again')}
          </KitButton>
        </>
      ) : null}
    </div>
  );
}
