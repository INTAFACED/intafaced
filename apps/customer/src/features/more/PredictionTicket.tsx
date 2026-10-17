import { useId } from 'react';
import { Button, Field } from '../../shared/ui';
import type { PublishedOutcome } from './prediction-catalogue';
import { ticketCopy } from './prediction-ticket-copy';

type OutcomeSide = 'yes' | 'no';

/**
 * The order ticket for one open prediction event, laid out in full and switched off. Prediction markets run on INTACORE, which is
 * not activated, so nothing here sends an order and no trade-service order call is made. The reason sits beside the controls.
 */
export function PredictionTicket({ market, outcome }: { market: PublishedOutcome; outcome: OutcomeSide }) {
  const copy = ticketCopy.useCopy();
  const why = useId();
  const asset = market.settlementAssetId;
  return (
    <section className="prediction-ticket" aria-label={copy.t('title')}>
      <h2>{copy.t('title')}</h2>
      <p className="prediction-ticket__blocker" role="status" id={why}>
        {copy.t('chainReason')}
      </p>
      <p className="muted">{copy.t('intro', { asset })}</p>
      <p>
        <strong>{copy.t('outcomeFor')}</strong> <span lang="und">{market.question}</span> · {outcome === 'yes' ? 'Yes' : 'No'}
      </p>
      <fieldset className="prediction-ticket__group" disabled aria-describedby={why}>
        <legend>{copy.t('side')}</legend>
        <Button variant="secondary" disabled>
          {copy.t('sideBuy')}
        </Button>
        <Button variant="secondary" disabled>
          {copy.t('sideSell')}
        </Button>
      </fieldset>
      <fieldset className="prediction-ticket__group" disabled aria-describedby={why}>
        <legend>{copy.t('type')}</legend>
        <Button variant="secondary" disabled>
          {copy.t('typeLimit')}
        </Button>
        <Button variant="secondary" disabled>
          {copy.t('typeMarket')}
        </Button>
      </fieldset>
      <Field label={copy.t('quantity')} disabled aria-describedby={why} inputMode="decimal" />
      <Field label={copy.t('price', { asset })} disabled aria-describedby={why} inputMode="decimal" />
      <p className="muted">
        <strong>{copy.t('collateralLabel')}.</strong> {copy.t('collateralBody', { asset })}
      </p>
      <Button disabled aria-describedby={why}>
        {copy.t('review')}
      </Button>
    </section>
  );
}
