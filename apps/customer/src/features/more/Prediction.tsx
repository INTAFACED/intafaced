import { t as copyText, Text } from './copy';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { orderBookSchema, tradeSchema } from '@intafaced/exchange-contract/schemas';
import { useApi, useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { DataTable, Panel, Tabs } from '../../shared/ui';
import { Details, Read } from './common';
import { predictionCatalogueSchema } from './prediction-catalogue';
import { PredictionCatalogue } from './PredictionCatalogue';
import { predictionCatalogueCopy } from './prediction-catalogue-copy';
import { PredictionTicket } from './PredictionTicket';
import { ticketCopy } from './prediction-ticket-copy';
import './prediction-catalogue.css';
export function Prediction() {
  const api = useApi(),
    { userId } = useSession();
  const [selected, setSelected] = useState(''),
    [outcome, setOutcome] = useState('Yes');
  const markets = useResource((signal) => api.rest('/outcomes/markets', predictionCatalogueSchema, { signal }), 'outcome-markets');
  const market = markets.resource.status === 'ready' ? markets.resource.data.find((m) => m.id === selected) : undefined,
    instrument = market?.instruments.find((i) => i.outcome === outcome.toLowerCase());
  const terms = market ? JSON.stringify(market) : '';
  const { Copy } = predictionCatalogueCopy.useCopy();
  const ticket = ticketCopy.useCopy();
  const sequence = useRef<{ symbol: string; nonce: number | null }>({ symbol: '', nonce: null });
  const book = useResource<z.infer<typeof orderBookSchema> | null>(async (signal) => {
    if (!instrument) return { ok: true as const, data: null };
    const r = await api.rest(`/orderbook/${encodeURIComponent(instrument.symbol)}`, orderBookSchema, { query: { limit: 20 }, signal });
    if (!r.ok) return r;
    if (r.data.symbol !== instrument.symbol)
      return {
        ok: false as const,
        reason: 'invalid_response' as const,
        message: copyText('prediction.the.book.belongs.to.another.outcome'),
      };
    if (r.data.timestamp === null || Date.now() - r.data.timestamp > 15000 || r.data.timestamp > Date.now() + 5000)
      return {
        ok: false as const,
        reason: 'invalid_response' as const,
        message: copyText('prediction.this.outcome.book.is.stale.or.has'),
      };
    if (
      sequence.current.symbol === instrument.symbol &&
      sequence.current.nonce !== null &&
      r.data.nonce !== null &&
      r.data.nonce < sequence.current.nonce
    )
      return {
        ok: false as const,
        reason: 'invalid_response' as const,
        message: copyText('prediction.this.outcome.book.sequence.moved.backwards'),
      };
    sequence.current = { symbol: instrument.symbol, nonce: r.data.nonce };
    return r;
  }, `outcome-book:${instrument?.symbol}`);
  const tape = useResource(
      (signal) =>
        instrument
          ? api.rest(
              `/trades/${encodeURIComponent(instrument.symbol)}`,
              z.array(tradeSchema).refine((rows) => rows.every((r) => r.symbol === instrument.symbol)),
              { query: { limit: 40 }, signal },
            )
          : Promise.resolve({ ok: true as const, data: [] }),
      `outcome-tape:${instrument?.symbol}`,
    ),
    fills = useResource(
      (signal) =>
        instrument
          ? api.rest(
              '/account/trades',
              z.array(tradeSchema).refine((rows) => rows.every((r) => r.symbol === instrument.symbol)),
              { query: { symbol: instrument.symbol, limit: 100 }, signal },
            )
          : Promise.resolve({ ok: true as const, data: [] }),
      `outcome-fills:${userId}:${instrument?.symbol}`,
    );
  useEffect(() => {
    if (!instrument) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        book.reload();
        tape.reload();
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [instrument?.symbol, terms]);
  return (
    <div data-testid="prediction-room" className="prediction-room">
      <div className="prediction-room-reading">
        <PredictionCatalogue
          resource={markets.resource}
          refresh={markets.reload}
          select={(id) => {
            setSelected(id);
            setOutcome('Yes');
          }}
        />
        {market && (
          <>
            <Panel title={market.question}>
              <Details
                items={[
                  [copyText('prediction.close.time'), market.closeAt],
                  [copyText('prediction.settlement.asset'), market.settlementAssetId],
                  [copyText('prediction.result.source'), market.settlementSource],
                  [copyText('prediction.collateralization'), copyText('prediction.full.one.settlement.unit.per.contract')],
                ]}
              />
              <Tabs
                items={['Yes', 'No']}
                labels={{ Yes: copyText('prediction.yes'), No: copyText('prediction.no') }}
                value={outcome}
                onChange={setOutcome}
                label={copyText('prediction.outcome.selection')}
              />
              <strong>{instrument?.symbol}</strong>
              <Read resource={book.resource} retry={book.reload}>
                {(b) =>
                  b ? (
                    <>
                      <DataTable
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
                      </DataTable>
                      <small>
                        <Text k="prediction.snapshot" />
                        {b.datetime}
                        <Text k="prediction.sequence" />
                        {b.nonce ?? copyText('prediction.unpublished')}
                        <Text k="prediction.limit.20" />
                      </small>
                    </>
                  ) : null
                }
              </Read>
            </Panel>
            <Panel title={copyText('prediction.recent.outcome.trades')}>
              <Read resource={tape.resource} retry={tape.reload} empty={copyText('prediction.no.public.trades.for.this.outcome')}>
                {(rows) => (
                  <DataTable
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
                  </DataTable>
                )}
              </Read>
            </Panel>
            <Panel title={copyText('prediction.your.outcome.fills')}>
              <Read resource={fills.resource} retry={fills.reload} empty={copyText('prediction.no.fills.for.this.outcome')}>
                {(rows) => (
                  <DataTable
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
                  </DataTable>
                )}
              </Read>
            </Panel>
          </>
        )}
      </div>
      <section className="prediction-room-review" lang={ticket.languageFor('title')}>
        {market && instrument ? (
          <PredictionTicket key={`${market.id}:${instrument.symbol}`} market={market} outcome={outcome === 'No' ? 'no' : 'yes'} />
        ) : (
          <div className="prediction-room-review-copy">
            <h2>
              <ticketCopy.Copy k="title" />
            </h2>
            <p className="muted">
              <ticketCopy.Copy k="idleBody" />
            </p>
            <p className="prediction-ticket__blocker" role="status">
              <ticketCopy.Copy k="chainReason" />
            </p>
          </div>
        )}
        <a className="text-link prediction-room-link" href="/support">
          <Copy k="support" />
        </a>
        <a className="text-link prediction-room-link" href="/more">
          <Copy k="more" />
        </a>
      </section>
    </div>
  );
}
