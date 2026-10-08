import { useEffect, useState } from 'react';
import { z } from 'zod';
import { tradeSchema } from '@intafaced/exchange-contract/schemas';
import { useApi, useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { decimalSchema, signedDecimalSchema } from '../../shared/money';
import { Button, DataTable, Panel } from '../../shared/ui';
import { Details, Read, Select } from './common';
const marketSchema = z.object({ id: z.string().min(1), symbol: z.string().min(1), paper: z.boolean(), quote: z.string().optional() });
const seal = {
  simulated: z.literal(true),
  venue: z.literal('paper'),
  realLedger: z.literal(false),
  withdrawable: z.literal(false),
  realMoney: z.literal(false),
  disclaimer: z.string().min(1),
};
const refusal = z.object({
  ok: z.literal(false),
  reason: z.enum(['not_paper', 'no_market', 'unknown_step', 'bad_fill']),
  message: z.string(),
});
const drill = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    ...seal,
    marketId: z.string(),
    symbol: z.string(),
    steps: z.array(z.object({ id: z.string(), instruction: z.string() })),
  }),
  refusal,
]);
const valuation = z.object({
  ...seal,
  fillCount: z.number().int(),
  boughtSize: decimalSchema,
  soldSize: decimalSchema,
  openSize: signedDecimalSchema,
  averageBuyPrice: decimalSchema.nullable(),
  averageSellPrice: decimalSchema.nullable(),
  realisedPnl: signedDecimalSchema,
  unrealisedPnl: signedDecimalSchema.nullable(),
  totalPnl: signedDecimalSchema.nullable(),
  markUnavailable: z.boolean(),
});
const result = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    ...seal,
    result: z.object({
      workbookSlug: z.string(),
      marketId: z.string(),
      symbol: z.string(),
      status: z.enum(['active', 'complete', 'refused']),
      stepCount: z.number().int(),
      completedCount: z.number().int(),
      remainingStepIds: z.array(z.string()),
      ratio: z.string(),
      complete: z.boolean(),
      valuation,
    }),
  }),
  refusal,
]);
export function Workbook({ slug }: { slug: string }) {
  const api = useApi(),
    { userId } = useSession();
  const [selected, setSelected] = useState(''),
    [steps, setSteps] = useState<string[]>([]),
    [fillIds, setFillIds] = useState<string[]>([]),
    [request, setRequest] = useState<unknown | null>(null);
  const catalogue = useResource(
    (signal) =>
      api.rest(
        '/markets',
        z.array(marketSchema).refine((rows) => new Set(rows.map((r) => r.id)).size === rows.length, 'Market IDs are duplicated'),
        { query: { limit: 500 }, signal },
      ),
    'workbook-markets',
  );
  const market = catalogue.resource.status === 'ready' ? catalogue.resource.data.find((m) => m.id === selected && m.paper) : undefined,
    flag = market ? { marketId: market.id, paper: market.paper, symbol: market.symbol } : null;
  const gate = useResource(
      (signal) =>
        flag
          ? api.query(
              'academy',
              'paperDrill',
              { slug, market: flag },
              drill.refine(
                (r) => !r.ok || (r.marketId === flag.marketId && r.symbol === flag.symbol),
                'Drill does not match this published market',
              ),
              { signal },
            )
          : Promise.resolve({ ok: true as const, data: null }),
      `workbook-drill:${userId}:${slug}:${selected}`,
    ),
    fills = useResource(
      (signal) =>
        market
          ? api.rest(
              '/account/trades',
              z
                .array(tradeSchema.extend({ price: decimalSchema, amount: decimalSchema, cost: decimalSchema }))
                .refine(
                  (rows) => rows.every((r) => r.symbol === market.symbol) && new Set(rows.map((r) => r.id)).size === rows.length,
                  'Fill identity does not match this drill',
                ),
              { query: { symbol: market.symbol, limit: 100 }, signal },
            )
          : Promise.resolve({ ok: true as const, data: [] }),
      `workbook-fills:${userId}:${market?.symbol}`,
    ),
    reading = useResource(
      (signal) =>
        request
          ? api.query('academy', 'paperDrillResult', request, result, { signal })
          : Promise.resolve({ ok: true as const, data: null }),
      `workbook-result:${userId}:${JSON.stringify(request)}`,
    );
  useEffect(() => {
    setSteps([]);
    setFillIds([]);
    setRequest(null);
  }, [selected, userId, slug]);
  return (
    <Panel title="Simulated workbook drill">
      <Read resource={catalogue.resource} retry={catalogue.reload}>
        {(rows) => (
          <Select
            label="Simulated market"
            value={selected}
            onChange={setSelected}
            options={[
              { value: '', label: 'Choose a published paper market' },
              ...rows.filter((r) => r.paper).map((r) => ({ value: r.id, label: r.symbol })),
            ]}
          />
        )}
      </Read>
      {market && (
        <a className="text-link" href={`/exchange/${encodeURIComponent(market.symbol)}?simulated=true`}>
          Open {market.symbol} on the simulated desk
        </a>
      )}
      <Read resource={gate.resource} retry={gate.reload} empty="Choose a published simulated market to begin">
        {(d) =>
          d ? (
            d.ok ? (
              <>
                <p className="more-badge">{d.disclaimer} · no real ledger · not withdrawable</p>
                <div className="more-grid">
                  {d.steps.map((s) => (
                    <label key={s.id}>
                      <input
                        type="checkbox"
                        aria-label={`Complete: ${s.instruction}`}
                        checked={steps.includes(s.id)}
                        onChange={(e) => setSteps((ids) => (e.target.checked ? [...ids, s.id] : ids.filter((id) => id !== s.id)))}
                      />{' '}
                      {s.instruction}
                    </label>
                  ))}
                </div>
                <h3>Attach your published fills</h3>
                <Read resource={fills.resource} retry={fills.reload} empty="No fills for this simulated market">
                  {(rows) => (
                    <DataTable headers={['Attach', 'Fill', 'Side', 'Price', 'Quantity']} label="Published simulated fills">
                      {rows.map((f) => (
                        <tr key={f.id}>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`Attach fill ${f.id}`}
                              checked={fillIds.includes(f.id)}
                              onChange={(e) => setFillIds((ids) => (e.target.checked ? [...ids, f.id] : ids.filter((id) => id !== f.id)))}
                            />
                          </td>
                          <td>{f.id}</td>
                          <td>{f.side}</td>
                          <td>{f.price}</td>
                          <td>{f.amount}</td>
                        </tr>
                      ))}
                    </DataTable>
                  )}
                </Read>
                <p className="muted">
                  A maximum of 100 fills can be read for this symbol. No fill price, quantity or future mark is typed into this drill. The
                  last traded price is not substituted for an authoritative mark.
                </p>
                <Button
                  variant="secondary"
                  disabled={fills.resource.status !== 'ready' || !userId}
                  onClick={() => {
                    if (!market || fills.resource.status !== 'ready') return;
                    setRequest({
                      slug,
                      market: flag,
                      completedStepIds: steps,
                      fills: fills.resource.data
                        .filter((f) => fillIds.includes(f.id))
                        .map((f) => ({ fillId: f.id, marketId: market.id, side: f.side, price: f.price, size: f.amount })),
                      markPrice: null,
                    });
                  }}
                >
                  Read drill result
                </Button>
              </>
            ) : (
              <p role="status">{d.message}</p>
            )
          ) : null
        }
      </Read>
      {Boolean(request) && (
        <Read resource={reading.resource} retry={reading.reload}>
          {(r) =>
            r ? (
              r.ok ? (
                <>
                  <p>{r.disclaimer}</p>
                  <Details
                    items={[
                      ['Progress', `${r.result.completedCount} of ${r.result.stepCount}`],
                      ['Complete', r.result.complete ? 'Yes' : 'No'],
                      ['Attached fills', r.result.valuation.fillCount],
                      ['Open size', r.result.valuation.openSize],
                      [
                        'Realised P&L',
                        `${r.result.valuation.realisedPnl} simulated ${market?.quote ?? 'quote asset identity unavailable'}`,
                      ],
                      ['Unrealised P&L', r.result.valuation.unrealisedPnl ?? 'Unavailable: no authoritative mark'],
                      ['Total P&L', r.result.valuation.totalPnl ?? 'Unavailable: no authoritative mark'],
                    ]}
                  />
                </>
              ) : (
                <p role="status">{r.message}</p>
              )
            ) : null
          }
        </Read>
      )}
    </Panel>
  );
}
