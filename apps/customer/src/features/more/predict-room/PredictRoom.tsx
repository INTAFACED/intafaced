// volt-room: /predict
import { useId } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import { CatalogueTemplate, SectionTabs } from '@intafaced/ui/lit/templates';
import type { Resource } from '../../../shared/resource';
import { ServiceOffNotice } from '../../../shared/service-off';
import { Details } from '../catalogue-parts';
import { t as copyText, Text } from '../copy';
import { usePredictionRoom } from '../Prediction';
import type { PublishedOutcome } from '../prediction-catalogue';
import { predictionCatalogueCopy } from '../prediction-catalogue-copy';
import { ticketCopy } from '../prediction-ticket-copy';
import { EmptyNote, KitRead, ScrollTable, Section } from '../volt-parts';

/**
 * /predict on the kit (J-more-catalogue-15 #1): the published questions with the publishing blocker, the picked
 * question's book, public trades and my fills, and the order ticket, laid out in full and switched off. The same reads
 * and words as the old room (`../Prediction.tsx`), which /predict/positions and /predict/settings still draw.
 */
export function PredictRoom() {
  const { markets, market, instrument, outcome, setOutcome, select, book, tape, fills } = usePredictionRoom();
  const { Copy, t } = predictionCatalogueCopy.useCopy();
  const ticket = ticketCopy.useCopy();
  return (
    <CatalogueTemplate
      title={copyText('moreroutes.prediction')}
      description={t('scope')}
      state={{ kind: 'ready' }}
      items={
        <div className="lt-grid lt-grid-main-side">
          <div className="lt-col-main">
            <Questions resource={markets.resource} refresh={markets.reload} select={select} />
            {market && (
              <>
                <Section title={market.question}>
                  <Details
                    items={[
                      [copyText('prediction.close.time'), market.closeAt],
                      [copyText('prediction.settlement.asset'), market.settlementAssetId],
                      [copyText('prediction.result.source'), market.settlementSource],
                      [copyText('prediction.collateralization'), copyText('prediction.full.one.settlement.unit.per.contract')],
                    ]}
                  />
                  <SectionTabs
                    items={[
                      { value: 'Yes', label: copyText('prediction.yes') },
                      { value: 'No', label: copyText('prediction.no') },
                    ]}
                    value={outcome}
                    onChange={setOutcome}
                    label={copyText('prediction.outcome.selection')}
                  />
                  <strong>{instrument?.symbol}</strong>
                  <KitRead resource={book.resource} retry={book.reload}>
                    {(b) =>
                      b ? (
                        <>
                          <ScrollTable
                            headers={[
                              copyText('prediction.bid.price'),
                              copyText('prediction.bid.quantity'),
                              copyText('prediction.ask.price'),
                              copyText('prediction.ask.quantity'),
                            ]}
                            label={copyText('prediction.outcome.order.book', { value1: outcome })}
                          >
                            {Array.from({ length: Math.max(b.bids.length, b.asks.length) }, (_, i) => (
                              <tr key={i}>
                                <td>{b.bids[i]?.[0] ?? '—'}</td>
                                <td>{b.bids[i]?.[1] ?? '—'}</td>
                                <td>{b.asks[i]?.[0] ?? '—'}</td>
                                <td>{b.asks[i]?.[1] ?? '—'}</td>
                              </tr>
                            ))}
                          </ScrollTable>
                          <small className="lt-hint">
                            <Text k="prediction.snapshot" />
                            {b.datetime}
                            <Text k="prediction.sequence" />
                            {b.nonce ?? copyText('prediction.unpublished')}
                            <Text k="prediction.limit.20" />
                          </small>
                        </>
                      ) : null
                    }
                  </KitRead>
                </Section>
                <Section title={copyText('prediction.recent.outcome.trades')}>
                  <KitRead resource={tape.resource} retry={tape.reload} empty={copyText('prediction.no.public.trades.for.this.outcome')}>
                    {(rows) => (
                      <ScrollTable
                        headers={[
                          copyText('prediction.time'),
                          copyText('prediction.side'),
                          copyText('prediction.price'),
                          copyText('prediction.quantity'),
                        ]}
                        label={copyText('prediction.outcome.public.trades')}
                      >
                        {rows.map((r) => (
                          <tr key={r.id}>
                            <td>{r.datetime}</td>
                            <td>{r.side}</td>
                            <td>{r.price}</td>
                            <td>{r.amount}</td>
                          </tr>
                        ))}
                      </ScrollTable>
                    )}
                  </KitRead>
                </Section>
                <Section title={copyText('prediction.your.outcome.fills')}>
                  <KitRead resource={fills.resource} retry={fills.reload} empty={copyText('prediction.no.fills.for.this.outcome')}>
                    {(rows) => (
                      <ScrollTable
                        headers={[
                          copyText('prediction.fill'),
                          copyText('prediction.price'),
                          copyText('prediction.quantity'),
                          copyText('prediction.fee'),
                        ]}
                        label={copyText('prediction.your.outcome.fills')}
                      >
                        {rows.map((r) => (
                          <tr key={r.id}>
                            <td>{r.id}</td>
                            <td>{r.price}</td>
                            <td>{r.amount}</td>
                            <td>{r.fee ? `${r.fee.cost} ${r.fee.currency}` : copyText('prediction.fee.unavailable')}</td>
                          </tr>
                        ))}
                      </ScrollTable>
                    )}
                  </KitRead>
                </Section>
              </>
            )}
          </div>
          <section className="lt-col-side" data-testid="prediction-room-review" lang={ticket.languageFor('title')}>
            {market && instrument ? (
              <Ticket key={`${market.id}:${instrument.symbol}`} market={market} outcome={outcome === 'No' ? 'no' : 'yes'} />
            ) : (
              <div>
                <h2>
                  <ticketCopy.Copy k="title" />
                </h2>
                <p className="lt-hint">
                  <ticketCopy.Copy k="idleBody" />
                </p>
                <p className="lt-refusal" data-testid="prediction-ticket-blocker" role="status">
                  <ticketCopy.Copy k="chainReason" />
                </p>
              </div>
            )}
            <a className="lt-link" href="/support">
              <Copy k="support" />
            </a>
            <a className="lt-link" href="/more">
              <Copy k="more" />
            </a>
          </section>
        </div>
      }
    />
  );
}

/** The published questions, and why none can be published yet: the owner's determination decision (ENGINE E-1). */
function Questions({
  resource,
  refresh,
  select,
}: {
  resource: Resource<PublishedOutcome[]>;
  refresh: () => void;
  select: (id: string) => void;
}) {
  const { Copy, t, languageFor, directionFor } = predictionCatalogueCopy.useCopy();
  return (
    <section data-testid="prediction-catalogue" lang={languageFor('questions')} dir={directionFor('questions')}>
      <h2>
        <Copy k="questions" />
      </h2>
      <div data-testid="prediction-blocker">
        <ServiceOffNotice code="owner.decision" action={t('publishAction')} role="note" />
        <p className="lt-hint">
          <Copy k="publishWhy" />
        </p>
      </div>
      <KitRead resource={resource} retry={refresh}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyNote title={t('empty')}>
              <Copy k="emptyBody" />
            </EmptyNote>
          ) : (
            <div className="lt-grid">
              {rows.map((m) => (
                <article key={m.id}>
                  <h3 lang="und" dir="auto">
                    {m.question}
                  </h3>
                  <p className="lt-hint">
                    <Copy k="closes" />{' '}
                    <time lang="und" dir="ltr" dateTime={m.closeAt}>
                      {m.closeAt}
                    </time>
                  </p>
                  <p className="lt-hint">
                    <Copy k="source" />{' '}
                    <span lang="und" dir="auto">
                      {m.settlementSource}
                    </span>
                  </p>
                  <Button tone="secondary" aria-label={t('openEvent') + ': ' + m.question} onClick={() => select(m.id)}>
                    <Copy k="openEvent" />
                  </Button>
                </article>
              ))}
            </div>
          )
        }
      </KitRead>
      {resource.status === 'failed' ? (
        <p className="lt-hint">
          <Copy k="failedBody" />
        </p>
      ) : (
        <Button
          tone={resource.status === 'ready' && resource.data.length === 0 ? 'primary' : 'secondary'}
          onClick={refresh}
          disabled={resource.status === 'loading'}
        >
          <Copy k="refresh" />
        </Button>
      )}
    </section>
  );
}

/**
 * The order ticket for one open question, laid out in full and switched off. Prediction markets run on INTACORE, which is
 * not activated, so nothing here sends an order and no trade-service order call is made. The reason sits beside the controls.
 */
function Ticket({ market, outcome }: { market: PublishedOutcome; outcome: 'yes' | 'no' }) {
  const copy = ticketCopy.useCopy();
  const why = useId();
  const asset = market.settlementAssetId;
  return (
    <section aria-label={copy.t('title')}>
      <h2>{copy.t('title')}</h2>
      <p className="lt-refusal" data-testid="prediction-ticket-blocker" role="status" id={why}>
        {copy.t('chainReason')}
      </p>
      <p className="lt-hint">{copy.t('intro', { asset })}</p>
      <p>
        <strong>{copy.t('outcomeFor')}</strong> <span lang="und">{market.question}</span> · {outcome === 'yes' ? 'Yes' : 'No'}
      </p>
      <fieldset className="lt-actions" disabled aria-describedby={why}>
        <legend>{copy.t('side')}</legend>
        <Button tone="secondary" disabled>
          {copy.t('sideBuy')}
        </Button>
        <Button tone="secondary" disabled>
          {copy.t('sideSell')}
        </Button>
      </fieldset>
      <fieldset className="lt-actions" disabled aria-describedby={why}>
        <legend>{copy.t('type')}</legend>
        <Button tone="secondary" disabled>
          {copy.t('typeLimit')}
        </Button>
        <Button tone="secondary" disabled>
          {copy.t('typeMarket')}
        </Button>
      </fieldset>
      <Field label={copy.t('quantity')} disabled aria-describedby={why} inputMode="decimal" />
      <Field label={copy.t('price', { asset })} disabled aria-describedby={why} inputMode="decimal" />
      <p className="lt-hint">
        <strong>{copy.t('collateralLabel')}.</strong> {copy.t('collateralBody', { asset })}
      </p>
      <Button tone="primary" disabled aria-describedby={why}>
        {copy.t('review')}
      </Button>
    </section>
  );
}
