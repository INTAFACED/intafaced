import { t as copyText, Text } from './copy';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { orderBookSchema, tradeSchema } from '@intafaced/exchange-contract/schemas';
import { useApi, useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { decimalSchema, displayAmount } from '../../shared/money';
import { Button, DataTable, Field, Panel, Tabs } from '../../shared/ui';
import { Details, Read } from './common';
const catalogue = z.array(
  z
    .object({
      id: z.string().min(1),
      kind: z.literal('outcome'),
      question: z.string().min(1),
      closeAt: z.string().datetime({ offset: true }),
      settlementAssetId: z.string().min(1),
      settlementSource: z.string().min(1),
      collateralization: z.literal('full'),
      instruments: z.array(z.object({ outcome: z.enum(['yes', 'no']), symbol: z.string().min(1) })).length(2),
    })
    .superRefine((row, ctx) => {
      if (row.instruments[0]?.symbol === row.instruments[1]?.symbol || new Set(row.instruments.map((i) => i.outcome)).size !== 2)
        ctx.addIssue({ code: 'custom', message: copyText('prediction.outcome.catalogue.must.publish.two.distinct.yes') });
    }),
);
export function Prediction() {
  const api = useApi(),
    { userId } = useSession();
  const [selected, setSelected] = useState(''),
    [outcome, setOutcome] = useState('Yes'),
    [price, setPrice] = useState(''),
    [amount, setAmount] = useState('');
  const markets = useResource((signal) => api.rest('/outcomes/markets', catalogue, { signal }), 'outcome-markets');
  const market = markets.resource.status === 'ready' ? markets.resource.data.find((m) => m.id === selected) : undefined,
    instrument = market?.instruments.find((i) => i.outcome === outcome.toLowerCase());
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
    setPrice('');
    setAmount('');
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        book.reload();
        tape.reload();
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [instrument?.symbol]);
  return (
    <div className="more-columns">
      <div>
        <Panel title={copyText('prediction.prediction.markets')}>
          <Read resource={markets.resource} retry={markets.reload} empty={copyText('prediction.no.prediction.events.are.listed')}>
            {(rows) => (
              <div className="more-grid">
                {rows.map((m) => (
                  <article key={m.id}>
                    <h3>{m.question}</h3>
                    <small>
                      <Text k="prediction.closes" />
                      {m.closeAt} · {m.settlementSource}
                    </small>
                    <Button
                      variant="secondary"
                      aria-label={copyText('prediction.open', { value1: m.question })}
                      onClick={() => {
                        setSelected(m.id);
                        setOutcome('Yes');
                      }}
                    >
                      <Text k="prediction.open.event" />
                    </Button>
                  </article>
                ))}
              </div>
            )}
          </Read>
          <p className="muted">
            <Text k="prediction.the.current.service.boot.publishes.an.empty" />
          </p>
        </Panel>
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
      <Panel title={copyText('prediction.outcome.order.review')}>
        <p role="status">
          <Text k="prediction.outcome.order.preview.is.not.published.no" />
        </p>
        <p className="muted">
          <Text k="prediction.the.post.contract.names.a.fully.collateralized" />
        </p>
        {market && (
          <>
            <Field
              label={copyText('prediction.outcome.contract.quantity')}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
            />
            <Field
              label={copyText('prediction.limit.price.in.per.contract', { value1: market.settlementAssetId })}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              inputMode="decimal"
            />
            {decimalSchema.safeParse(amount).success && (
              <Details
                items={[
                  [copyText('prediction.instrument'), instrument?.symbol ?? copyText('common.unavailable')],
                  [copyText('prediction.full.collateral.by.published.rule'), `${displayAmount(amount)} ${market.settlementAssetId}`],
                  [copyText('prediction.authoritative.fee'), copyText('common.unavailable')],
                  [copyText('prediction.order.admission'), copyText('common.unavailable')],
                ]}
              />
            )}
            <p className="muted">
              <Text k="prediction.closing.or.settling.an.event.is.not" />
            </p>
          </>
        )}
      </Panel>
    </div>
  );
}
