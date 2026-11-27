import { useCallback, useRef, useState } from 'react';
import { displayAmount } from '../../../shared/money';
import { outcomeText, useVenueApi } from '../../../features/trade/venue/VenueKit';
import { venueCopy } from '../../../features/trade/venue/venue-copy';
import { exitLinesCopy } from './exit-lines-copy';
import { refusalOf, useExitSigner, useSignPrepared } from './VenueProtect';
import { protectionClientId } from './venue-protect-logic';

export type BreakevenNote = { tone: 'good' | 'bad'; text: string; code: string | null };

/** At most this many calls per press: the cancels of the stops resting, then the new stop (svc-trade `breakeven`). */
const MOST_CALLS = 3;

/**
 * One press of Breakeven (J-derivatives-32 #5 #6), from the position row or the chart's entry line: our door works out
 * the fee-adjusted breakeven from the venue's figures and answers the actions that leave exactly one reduce-only stop
 * there; the person signs each in order and it is sent. A breakeven the mark has not passed is refused in the door's
 * words, naming both prices, and nothing is sent. One press keeps one client order id for its new stop on every call.
 */
export function useBreakeven(owner: string, onChanged: () => void) {
  const { t } = exitLinesCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const venue = useVenueApi();
  const sign = useSignPrepared(owner);
  const exitSigner = useExitSigner(owner);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<BreakevenNote | null>(null);
  const working = useRef(false);
  const counter = useRef(0);

  const run = useCallback(
    async (symbol: string) => {
      if (working.current) return;
      working.current = true;
      setBusy(true);
      setNote(null);
      try {
        const chosen = exitSigner();
        if ('refusal' in chosen) return setNote({ tone: 'bad', text: chosen.refusal.message, code: chosen.refusal.code });
        const clientOrderId = protectionClientId(Date.now(), counter.current++);
        for (let call = 0; call < MOST_CALLS; call += 1) {
          const answer = await venue.breakeven({ owner, symbol, clientOrderId, signer: chosen.signer });
          if (!answer.ok)
            return setNote({ tone: 'bad', text: t('Breakeven refused', { detail: answer.message }), code: answer.code ?? null });
          for (const step of answer.data.steps) {
            const refused = refusalOf(await sign(step), (r) => outcomeText(v, r));
            if (refused) return setNote({ tone: 'bad', text: refused.message, code: refused.code });
          }
          if (answer.data.next === 'done') {
            return setNote({
              tone: 'good',
              text: t('Breakeven done', {
                price: displayAmount(answer.data.triggerPrice),
                entry: displayAmount(answer.data.entryPrice),
                bps: displayAmount(answer.data.closeFeeBps),
              }),
              code: null,
            });
          }
        }
      } finally {
        working.current = false;
        setBusy(false);
        onChanged();
      }
    },
    [exitSigner, venue, owner, sign, t, v, onChanged],
  );
  return { run, busy, note };
}
