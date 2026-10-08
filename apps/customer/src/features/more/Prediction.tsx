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
        ctx.addIssue({ code: 'custom', message: 'Outcome catalogue must publish two distinct yes/no instruments' });
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
      return { ok: false as const, reason: 'invalid_response' as const, message: 'The book belongs to another outcome.' };
    if (r.data.timestamp === null || Date.now() - r.data.timestamp > 15000 || r.data.timestamp > Date.now() + 5000)
      return {
        ok: false as const,
        reason: 'invalid_response' as const,
        message: 'This outcome book is stale or has no verified timestamp.',
      };
    if (
      sequence.current.symbol === instrument.symbol &&
      sequence.current.nonce !== null &&
      r.data.nonce !== null &&
      r.data.nonce < sequence.current.nonce
    )
      return { ok: false as const, reason: 'invalid_response' as const, message: 'This outcome book sequence moved backwards.' };
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
        <Panel title="Prediction markets">
          <Read resource={markets.resource} retry={markets.reload} empty="No prediction events are listed">
            {(rows) => (
              <div className="more-grid">
                {rows.map((m) => (
                  <article key={m.id}>
                    <h3>{m.question}</h3>
                    <small>
                      Closes {m.closeAt} · {m.settlementSource}
                    </small>
                    <Button
                      variant="secondary"
                      aria-label={`Open ${m.question}`}
                      onClick={() => {
                        setSelected(m.id);
                        setOutcome('Yes');
                      }}
                    >
                      Open event
                    </Button>
                  </article>
                ))}
              </div>
            )}
          </Read>
          <p className="muted">
            The current service boot publishes an empty catalogue and no ledger-backed outcome placement adapter. Event results are
            controlled by the signed settlement service.
          </p>
        </Panel>
        {market && (
          <>
            <Panel title={market.question}>
              <Details
                items={[
                  ['Close time', market.closeAt],
                  ['Settlement asset', market.settlementAssetId],
                  ['Result source', market.settlementSource],
                  ['Collateralization', 'Full · one settlement unit per contract'],
                ]}
              />
              <Tabs items={['Yes', 'No']} value={outcome} onChange={setOutcome} label="Outcome selection" />
              <strong>{instrument?.symbol}</strong>
              <Read resource={book.resource} retry={book.reload}>
                {(b) =>
                  b ? (
                    <>
                      <DataTable
                        headers={['Bid price', 'Bid quantity', 'Ask price', 'Ask quantity']}
                        label={`${outcome} outcome order book`}
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
                        Snapshot {b.datetime} · sequence {b.nonce ?? 'unpublished'} · limit 20
                      </small>
                    </>
                  ) : null
                }
              </Read>
            </Panel>
            <Panel title="Recent outcome trades">
              <Read resource={tape.resource} retry={tape.reload} empty="No public trades for this outcome">
                {(rows) => (
                  <DataTable headers={['Time', 'Side', 'Price', 'Quantity']} label="Outcome public trades">
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
            <Panel title="Your outcome fills">
              <Read resource={fills.resource} retry={fills.reload} empty="No fills for this outcome">
                {(rows) => (
                  <DataTable headers={['Fill', 'Price', 'Quantity', 'Fee']} label="Your outcome fills">
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td>{r.id}</td>
                        <td>{r.price}</td>
                        <td>{r.amount}</td>
                        <td>{r.fee ? `${r.fee.cost} ${r.fee.currency}` : 'Fee unavailable'}</td>
                      </tr>
                    ))}
                  </DataTable>
                )}
              </Read>
            </Panel>
          </>
        )}
      </div>
      <Panel title="Outcome order review">
        <p role="status">Outcome order preview is not published. No order can be sent from this room.</p>
        <p className="muted">
          The POST contract names a fully collateralized hold, but provides no outcome-specific admission, fee quote, precision or preview.
          A spot preview would size its hold differently and cannot establish this consent.
        </p>
        {market && (
          <>
            <Field label="Outcome contract quantity" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
            <Field
              label={`Limit price in ${market.settlementAssetId} per contract`}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              inputMode="decimal"
            />
            {decimalSchema.safeParse(amount).success && (
              <Details
                items={[
                  ['Instrument', instrument?.symbol ?? 'Unavailable'],
                  ['Full collateral by published rule', `${displayAmount(amount)} ${market.settlementAssetId}`],
                  ['Authoritative fee', 'Unavailable'],
                  ['Order admission', 'Unavailable'],
                ]}
              />
            )}
            <p className="muted">Closing or settling an event is not a customer control.</p>
          </>
        )}
      </Panel>
    </div>
  );
}
