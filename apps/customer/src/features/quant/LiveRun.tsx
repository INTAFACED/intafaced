import { useState } from 'react';
import { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import { decimalSchema } from '../../shared/money';
import { useResource } from '../../shared/resource';
import { Button, DataTable, Field } from '../../shared/ui';
import { venueBalanceSchema, venueFillSchema, venueOrderSchema, venuePositionSchema } from '../trade/venue-api';
import { Read, Select } from '../more/common';
import { useApi } from '../session/session';
import { liveRunCopy } from './live-run-copy';

// hand-declared-ok: svc-trade's live-run answers (src/quant/live-run/rest.ts) have no browser-safe schema in @intafaced/contracts; the venue rows reuse trade/venue-api's.

/**
 * A live strategy run (J-algo-dev-07): its state, its safeguards (restarts, the strategy state kept or dropped, why it
 * ended), Stop and Liquidate with what each does, a manual order under the run's next sequence number, the sub-account
 * as the venue reports it, the run's own orders and its log. Every decision shown is svc-trade's or the venue's; the page
 * works none out. A press carries its number, so a press after a lost reply is the same press.
 */

const iso = z.string();
const runSchema = z.object({
  runId: z.string(),
  strategyId: z.string(),
  strategyVersion: z.number(),
  strategyName: z.string(),
  subAccount: z.string(),
  asset: z.string(),
  cap: decimalSchema,
  plan: z.array(z.object({ side: z.enum(['buy', 'sell']), symbol: z.string(), qty: z.string() })),
  state: z.enum(['signing', 'running', 'unknown', 'stopped', 'flat', 'ended', 'abandoned']),
  endReason: z.enum(['user_stop', 'liquidated', 'attempts_exhausted', 'account_frozen']).nullable(),
  permission: z.enum(['signing', 'active', 'revoked']),
  liveControl: z.boolean(),
  nextSeq: z.number(),
  stopSeq: z.number().nullable(),
  health: z.object({
    restarts: z.number(),
    restartAttempts: z.number(),
    statePolicy: z.enum(['keep', 'drop']),
    strategyTicks: z.number(),
    heartbeatAt: iso.nullable(),
    heartbeatMs: z.number().nullable(),
  }),
  createdAt: iso,
  startedAt: iso.nullable(),
  test: z.boolean(),
});
type Run = z.infer<typeof runSchema>;
const orderSchema = z.object({
  seq: z.number(),
  actionKey: z.string(),
  kind: z.enum(['strategy', 'manual', 'liquidate']),
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  type: z.enum(['market', 'limit']),
  size: decimalSchema,
  price: decimalSchema,
  reduceOnly: z.boolean(),
  state: z.enum(['admitted', 'accepted', 'refused', 'unknown']),
  order: venueOrderSchema.nullable().optional(),
});
const detailSchema = runSchema.extend({
  orders: z.array(orderSchema),
  venue: z
    .object({
      asOf: iso,
      balances: z.array(venueBalanceSchema),
      positions: z.array(venuePositionSchema),
      openOrders: z.array(venueOrderSchema),
      fills: z.array(venueFillSchema),
    })
    .nullable(),
  venueError: z.string().nullable(),
  log: z.array(z.object({ n: z.number(), at: iso, kind: z.string(), detail: z.string() })),
});
type Detail = z.infer<typeof detailSchema>;
const listSchema = z.object({ runs: z.array(runSchema) });
const manualSchema = z.object({ run: runSchema, order: orderSchema });
const liquidateSchema = z.object({ run: runSchema, orders: z.array(orderSchema) });

const BASE = '/quant/live-runs';
const KNOWN = new Set([
  'quant.permission_denied',
  'quant.account_frozen',
  'quant.run_not_running',
  'quant.order_rejected',
  'quant.order_seq_invalid',
  'quant.order_reused',
  'quant.stop_unavailable',
  'quant.nothing_to_liquidate',
  'quant.run_not_found',
]);
type Refusal = { code: string | null; message: string };
const refusalOf = (res: Extract<ApiResult<unknown>, { ok: false }>): Refusal => ({
  code: res.code && /^quant\.[a-z_]+$/.test(res.code) ? res.code : null,
  message: res.message,
});
const timeText = (value: string) => value.slice(0, 19).replace('T', ' ');

function Refused({ refusal }: { refusal: Refusal }) {
  const { t } = liveRunCopy.useCopy();
  return (
    <p role="alert" data-testid="live-run-refusal" data-code={refusal.code ?? ''}>
      {refusal.code && KNOWN.has(refusal.code)
        ? t(`code_${refusal.code.replaceAll('.', '_')}` as 'code_other')
        : refusal.message || t('code_other')}{' '}
      {refusal.code ? <code lang="zxx">{refusal.code}</code> : null}
    </p>
  );
}

/** `/quant/live`: the person's live runs, newest first. */
export function LiveRuns() {
  const api = useApi();
  const { t } = liveRunCopy.useCopy();
  const list = useResource((signal) => api.rest(BASE, listSchema, { signal }), 'quant-live-runs');
  return (
    <section aria-label={t('listTitle')} data-testid="live-runs">
      <p className="muted">{t('intro')}</p>
      <Read resource={list.resource} retry={list.reload}>
        {(data) =>
          data.runs.length === 0 ? (
            <p className="muted">{t('none')}</p>
          ) : (
            <DataTable label={t('listTitle')} headers={[t('colStrategy'), t('colState'), t('colStarted'), '']}>
              {data.runs.map((r) => (
                <tr key={r.runId} data-testid="live-run-row" data-id={r.runId}>
                  <td>
                    {r.strategyName} · {t('version', { version: r.strategyVersion })}
                  </td>
                  <td>{t(`state_${r.state}`)}</td>
                  <td className="numeric">{r.startedAt ? timeText(r.startedAt) : '—'}</td>
                  <td>
                    <a href={`/quant/live/${encodeURIComponent(r.runId)}`}>{t('open')}</a>
                  </td>
                </tr>
              ))}
            </DataTable>
          )
        }
      </Read>
    </section>
  );
}

/** `/quant/live/:runId`: one run. */
export function LiveRun({ runId }: { runId: string }) {
  const api = useApi();
  const { t } = liveRunCopy.useCopy();
  const [revision, setRevision] = useState(0);
  const detail = useResource(
    (signal) => api.rest(`${BASE}/${encodeURIComponent(runId)}`, detailSchema, { signal }),
    `quant-live-run:${runId}:${revision}`,
  );
  const reload = () => setRevision((n) => n + 1);
  return (
    <section aria-label={t('roomTitle')} data-testid="live-run">
      <p className="muted">{t('intro')}</p>
      <Read resource={detail.resource} retry={detail.reload}>
        {(d) => <RunBody d={d} onChange={reload} />}
      </Read>
    </section>
  );
}

function RunBody({ d, onChange }: { d: Detail; onChange: () => void }) {
  const { t } = liveRunCopy.useCopy();
  return (
    <>
      {d.test ? (
        <p className="muted" data-testid="live-run-test">
          {t('testLabel')}
        </p>
      ) : null}
      <h3>
        {d.strategyName} · {t('version', { version: d.strategyVersion })}
      </h3>
      <dl className="protocol-facts" data-testid="live-run-status">
        <div>
          <dt>{t('stateLabel')}</dt>
          <dd data-testid="live-run-state" data-state={d.state}>
            {t(`state_${d.state}`)}
          </dd>
        </div>
        <div>
          <dt>{t('reasonLabel')}</dt>
          <dd data-testid="live-run-reason" data-reason={d.endReason ?? ''}>
            {d.endReason ? t(`reason_${d.endReason}`) : t('reasonNone')}
          </dd>
        </div>
        <div>
          <dt>{t('permissionLabel')}</dt>
          <dd data-testid="live-run-permission" data-permission={d.permission}>
            {t(`permission_${d.permission}`)}
          </dd>
        </div>
      </dl>
      {d.endReason === 'account_frozen' ? (
        <p role="status" data-testid="live-run-frozen">
          {t('frozenNotice')}
        </p>
      ) : null}
      <Safeguards d={d} />
      <Controls d={d} onChange={onChange} />
      <ManualOrder d={d} onChange={onChange} />
      <VenueRecord d={d} />
      <RunOrders d={d} />
      <section aria-label={t('logTitle')} data-testid="live-run-log">
        <h4>{t('logTitle')}</h4>
        {d.log.length === 0 ? (
          <p className="muted">{t('logNone')}</p>
        ) : (
          <ol>
            {d.log.map((e) => (
              <li key={e.n} data-kind={e.kind}>
                <span className="numeric">{timeText(e.at)}</span> {e.detail}
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}

function Safeguards({ d }: { d: Detail }) {
  const { t } = liveRunCopy.useCopy();
  const h = d.health;
  return (
    <section aria-label={t('safeguards')} data-testid="live-run-health">
      <h4>{t('safeguards')}</h4>
      <dl className="protocol-facts">
        <div>
          <dt>{t('restarts')}</dt>
          <dd data-testid="live-run-restarts" data-restarts={h.restarts} data-attempts={h.restartAttempts}>
            {t('restartsOf', { restarts: h.restarts, attempts: h.restartAttempts })}
          </dd>
        </div>
        <div>
          <dt>{t('statePolicy')}</dt>
          <dd data-testid="live-run-policy" data-policy={h.statePolicy}>
            {t(`policy_${h.statePolicy}`)}
          </dd>
        </div>
        <div>
          <dt>{t('ticks')}</dt>
          <dd className="numeric" data-testid="live-run-ticks">
            {t('ticksOf', { ticks: h.strategyTicks })}
          </dd>
        </div>
        <div>
          <dt>{t('heartbeat')}</dt>
          <dd className="numeric">
            {h.heartbeatAt ? timeText(h.heartbeatAt) : t('heartbeatNever')}
            {h.heartbeatMs ? ` · ${t('heartbeatEvery', { seconds: Math.round(h.heartbeatMs / 1000) })}` : ''}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function Controls({ d, onChange }: { d: Detail; onChange: () => void }) {
  const api = useApi();
  const { t } = liveRunCopy.useCopy();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [confirming, setConfirming] = useState(false);
  // The press's number: the run's own Stop if it was stopped, else the first. Sent again after a lost reply, it is the same press.
  const press = d.stopSeq ?? 1;
  async function stop() {
    setBusy(true);
    setRefused(null);
    setNote(null);
    const res = await api.rest(`${BASE}/${encodeURIComponent(d.runId)}/stop`, runSchema, { method: 'POST', body: { seq: press } });
    setBusy(false);
    if (!res.ok) return setRefused(refusalOf(res));
    setNote(t('stopped'));
    onChange();
  }
  async function liquidate() {
    setBusy(true);
    setRefused(null);
    setNote(null);
    const res = await api.rest(`${BASE}/${encodeURIComponent(d.runId)}/liquidate`, liquidateSchema, {
      method: 'POST',
      body: { seq: press },
    });
    setBusy(false);
    setConfirming(false);
    if (!res.ok) return setRefused(refusalOf(res));
    setNote(t('liquidated'));
    onChange();
  }
  return (
    <section aria-label={t('controls')} data-testid="live-run-controls">
      <h4>{t('controls')}</h4>
      <p className="muted">{t('stopWhat')}</p>
      <Button variant="secondary" disabled={busy} onClick={() => void stop()}>
        {busy ? t('stopping') : t('stop')}
      </Button>
      <p className="muted">{t('liquidateWhat')}</p>
      {confirming ? (
        <>
          <Button variant="danger" disabled={busy} onClick={() => void liquidate()}>
            {t('liquidateConfirm')}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
            {t('liquidateCancel')}
          </Button>
        </>
      ) : (
        <Button variant="danger" disabled={busy} onClick={() => setConfirming(true)}>
          {t('liquidate')}
        </Button>
      )}
      {note ? (
        <p role="status" data-testid="live-run-note">
          {note}
        </p>
      ) : null}
      {refused ? <Refused refusal={refused} /> : null}
    </section>
  );
}

function ManualOrder({ d, onChange }: { d: Detail; onChange: () => void }) {
  const api = useApi();
  const { t } = liveRunCopy.useCopy();
  const [seq, setSeq] = useState(String(d.nextSeq));
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [type, setType] = useState<'market' | 'limit'>('limit');
  const [symbol, setSymbol] = useState(d.plan[0]?.symbol ?? '');
  const [size, setSize] = useState('');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [refused, setRefused] = useState<Refusal | null>(null);
  async function send() {
    setBusy(true);
    setRefused(null);
    setNote(null);
    const res = await api.rest(`${BASE}/${encodeURIComponent(d.runId)}/orders`, manualSchema, {
      method: 'POST',
      body: { seq: Number(seq), side, type, symbol, size, ...(type === 'limit' ? { price } : {}) },
    });
    setBusy(false);
    if (!res.ok) return setRefused(refusalOf(res));
    setNote(t('sent', { seq: res.data.order.seq, state: t(`order_${res.data.order.state}`) }));
    onChange();
  }
  return (
    <section aria-label={t('manualTitle')} data-testid="live-run-manual">
      <h4>{t('manualTitle')}</h4>
      <p className="muted">{t('manualWhat')}</p>
      <form
        aria-label={t('manualTitle')}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <Field label={t('seq')} inputMode="numeric" value={seq} disabled={busy} onChange={(e) => setSeq(e.target.value)} />
        <Select
          label={t('side')}
          value={side}
          onChange={(v) => setSide(v as 'buy' | 'sell')}
          options={[
            { value: 'buy', label: t('side_buy') },
            { value: 'sell', label: t('side_sell') },
          ]}
        />
        <Select
          label={t('type')}
          value={type}
          onChange={(v) => setType(v as 'market' | 'limit')}
          options={[
            { value: 'limit', label: t('type_limit') },
            { value: 'market', label: t('type_market') },
          ]}
        />
        <Field label={t('market')} value={symbol} disabled={busy} onChange={(e) => setSymbol(e.target.value)} />
        <Field label={t('size')} inputMode="decimal" value={size} disabled={busy} onChange={(e) => setSize(e.target.value)} />
        {type === 'limit' ? (
          <Field label={t('price')} inputMode="decimal" value={price} disabled={busy} onChange={(e) => setPrice(e.target.value)} />
        ) : null}
        <Button type="submit" disabled={busy}>
          {t('send')}
        </Button>
      </form>
      {note ? (
        <p role="status" data-testid="live-run-manual-note">
          {note}
        </p>
      ) : null}
      {refused ? <Refused refusal={refused} /> : null}
    </section>
  );
}

function VenueRecord({ d }: { d: Detail }) {
  const { t } = liveRunCopy.useCopy();
  const v = d.venue;
  return (
    <section aria-label={t('venueTitle')} data-testid="live-run-venue">
      <h4>{t('venueTitle')}</h4>
      {!v ? (
        <p role="alert">{d.venueError ?? t('venueUnread')}</p>
      ) : (
        <>
          <p className="muted" data-testid="live-run-as-of">
            {t('asOf', { time: timeText(v.asOf) })}
          </p>
          <DataTable label={t('cash')} headers={[t('colAsset'), t('colFree'), t('colLocked'), t('colTotal')]}>
            {v.balances.map((b) => (
              <tr key={b.asset} data-testid="live-run-cash" data-asset={b.asset}>
                <td>{b.asset}</td>
                <td className="numeric">{b.free}</td>
                <td className="numeric">{b.locked}</td>
                <td className="numeric" data-testid="live-run-cash-total">
                  {b.total}
                </td>
              </tr>
            ))}
          </DataTable>
          <h5>{t('positions')}</h5>
          {v.positions.length === 0 ? (
            <p className="muted" data-testid="live-run-no-position">
              {t('positionsNone')}
            </p>
          ) : (
            <DataTable label={t('positions')} headers={[t('colMarket'), t('colSide'), t('colSize'), t('colEntry'), t('colMark')]}>
              {v.positions.map((p) => (
                <tr key={p.symbol} data-testid="live-run-position" data-symbol={p.symbol} data-size={p.size}>
                  <td>{p.symbol}</td>
                  <td>{p.side}</td>
                  <td className="numeric">{p.size}</td>
                  <td className="numeric">{p.entryPrice}</td>
                  <td className="numeric">{p.markPrice}</td>
                </tr>
              ))}
            </DataTable>
          )}
          <h5>{t('openOrders')}</h5>
          {v.openOrders.length === 0 ? (
            <p className="muted" data-testid="live-run-no-open-order">
              {t('openNone')}
            </p>
          ) : (
            <DataTable label={t('openOrders')} headers={[t('colMarket'), t('colSide'), t('colPrice'), t('colRemaining')]}>
              {v.openOrders.map((o, i) => (
                <tr key={o.venueClientOrderId ?? i} data-testid="live-run-open-order">
                  <td>{o.symbol}</td>
                  <td>{o.side}</td>
                  <td className="numeric">{o.price}</td>
                  <td className="numeric">{o.remaining}</td>
                </tr>
              ))}
            </DataTable>
          )}
          <h5>{t('fills')}</h5>
          {v.fills.length === 0 ? (
            <p className="muted">{t('fillsNone')}</p>
          ) : (
            <DataTable label={t('fills')} headers={[t('colMarket'), t('colSide'), t('colSize'), t('colPrice'), t('colFee'), t('colTime')]}>
              {v.fills.map((f) => (
                <tr key={f.fillId} data-testid="live-run-fill" data-side={f.side} data-amount={f.amount}>
                  <td>{f.symbol}</td>
                  <td>{f.side}</td>
                  <td className="numeric">{f.amount}</td>
                  <td className="numeric">{f.price}</td>
                  <td className="numeric">
                    {f.venueFee} {f.feeAsset}
                  </td>
                  <td className="numeric">{timeText(f.filledAt)}</td>
                </tr>
              ))}
            </DataTable>
          )}
        </>
      )}
    </section>
  );
}

function RunOrders({ d }: { d: Detail }) {
  const { t } = liveRunCopy.useCopy();
  if (d.orders.length === 0) return null;
  return (
    <DataTable
      label={t('ordersTitle')}
      headers={[t('colSeq'), t('colKind'), t('colMarket'), t('colSide'), t('colSize'), t('colPrice'), t('colRecorded'), t('colVenue')]}
    >
      {d.orders.map((o) => (
        <tr
          key={o.seq}
          data-testid="live-run-order"
          data-seq={o.seq}
          data-kind={o.kind}
          data-key={o.actionKey}
          data-reduce-only={String(o.reduceOnly)}
        >
          <td className="numeric">{o.seq}</td>
          <td>{t(`kind_${o.kind}`)}</td>
          <td>{o.symbol}</td>
          <td>
            {o.side}
            {o.reduceOnly ? ` · ${t('reduceOnly')}` : ''}
          </td>
          <td className="numeric">{o.size}</td>
          <td className="numeric">{o.price}</td>
          <td>{t(`order_${o.state}`)}</td>
          <td>{o.order ? o.order.status : '—'}</td>
        </tr>
      ))}
    </DataTable>
  );
}
