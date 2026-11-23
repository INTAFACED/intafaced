// volt-room: /quant/live/:runId
import { useEffect, useState, type ReactNode } from 'react';
import { MonitorTemplate } from '@intafaced/ui/lit/templates';
import { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import { decimalSchema } from '../../shared/money';
import { useResource } from '../../shared/resource';
import { Button, Field, Select } from '@intafaced/ui/lit';
import { venueBalanceSchema, venueFillSchema, venueOrderSchema, venuePositionSchema } from '../trade';
import { ReadView } from '../../shared/record/record-parts';
import { useApi } from '../session';
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
  /** The risk desk's halt standing on the strategy (J-algo-dev-11): no new order; Liquidate still passes. */
  halt: z
    .object({ reason: z.string(), scope: z.enum(['one', 'all']), haltedAt: iso })
    .nullable()
    .optional(),
});
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
/** The list `/quant/live` reads (live-runs/LiveRunsRoom.tsx). */
export const listSchema = z.object({ runs: z.array(runSchema) });
const manualSchema = z.object({ run: runSchema, order: orderSchema });
const liquidateSchema = z.object({ run: runSchema, orders: z.array(orderSchema) });

const BASE = '/quant/live-runs';
/** The live-runs path, for the list room (live-runs/LiveRunsRoom.tsx). */
export const liveRunsBase = BASE;
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
  'quant.strategy_halted',
  'quant.halt_unavailable',
]);
type Refusal = { code: string | null; message: string };
const refusalOf = (res: Extract<ApiResult<unknown>, { ok: false }>): Refusal => ({
  code: res.code && /^quant\.[a-z_]+$/.test(res.code) ? res.code : null,
  message: res.message,
});
export const timeText = (value: string) => value.slice(0, 19).replace('T', ' ');

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

/** `/quant/live/:runId`: one run, on the monitor template: its state as the key figure, Stop and Liquidate as the room's
 * actions, and the safeguards, manual order, venue record, orders and log as its panels. */
export function LiveRun({ runId }: { runId: string }) {
  const api = useApi();
  const { t } = liveRunCopy.useCopy();
  const [revision, setRevision] = useState(0);
  const detail = useResource(
    (signal) => api.rest(`${BASE}/${encodeURIComponent(runId)}`, detailSchema, { signal }),
    `quant-live-run:${runId}:${revision}`,
  );
  const reload = () => setRevision((n) => n + 1);
  // After an action the run is read again; until that answer comes, the room keeps showing the run as last read, so the
  // controls stay mounted and their note ("Stopped…", "Order under sequence…") stays on screen.
  const [shown, setShown] = useState<Detail | null>(null);
  const ready = detail.resource.status === 'ready' ? detail.resource.data : null;
  useEffect(() => {
    if (ready) setShown(ready);
  }, [ready]);
  const current = ready ?? (detail.resource.status === 'loading' ? shown : null);
  const intro = <p className="lt-hint">{t('intro')}</p>;
  return (
    <section aria-label={t('roomTitle')} data-testid="live-run">
      {current ? (
        <MonitorTemplate
          title={t('roomTitle')}
          description={t('description')}
          state={{ kind: 'ready' }}
          figures={[<RunStatus key="status" d={current} />]}
          actions={<Controls d={current} onChange={reload} />}
          panels={<RunPanels d={current} onChange={reload} />}
          explain={intro}
        />
      ) : (
        <MonitorTemplate
          title={t('roomTitle')}
          description={t('description')}
          state={{ kind: 'ready' }}
          figures={[]}
          panels={
            <ReadView resource={detail.resource} retry={detail.reload}>
              {() => null}
            </ReadView>
          }
          explain={intro}
        />
      )}
    </section>
  );
}

/** The run's name and version, and its state, why it ended and its permission, as the room's key figure. */
function RunStatus({ d }: { d: Detail }) {
  const { t } = liveRunCopy.useCopy();
  return (
    <div className="lt-stack">
      {d.test ? (
        <p className="lt-hint" data-testid="live-run-test">
          {t('testLabel')}
        </p>
      ) : null}
      <h2>
        {d.strategyName} · {t('version', { version: d.strategyVersion })}
      </h2>
      <dl className="lt-kv" data-testid="live-run-status">
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
      {d.halt ? (
        <p role="status" data-testid="live-run-halted" data-scope={d.halt.scope}>
          {t('haltedNotice', { reason: d.halt.reason })}
        </p>
      ) : null}
      {d.endReason === 'account_frozen' ? (
        <p role="status" data-testid="live-run-frozen">
          {t('frozenNotice')}
        </p>
      ) : null}
    </div>
  );
}

/** The run's panels, each under its own heading, one section apart. */
function RunPanels({ d, onChange }: { d: Detail; onChange: () => void }) {
  const { t } = liveRunCopy.useCopy();
  return (
    <div className="lt-sections">
      <Safeguards d={d} />
      <ManualOrder d={d} onChange={onChange} />
      <VenueRecord d={d} />
      <RunOrders d={d} />
      <section aria-label={t('logTitle')} data-testid="live-run-log">
        <h2>{t('logTitle')}</h2>
        {d.log.length === 0 ? (
          <p className="lt-hint">{t('logNone')}</p>
        ) : (
          <ol className="lt-list">
            {d.log.map((e) => (
              <li key={e.n} data-kind={e.kind}>
                <span className="lt-num lt-muted">{timeText(e.at)}</span> {e.detail}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function Safeguards({ d }: { d: Detail }) {
  const { t } = liveRunCopy.useCopy();
  const h = d.health;
  return (
    <section aria-label={t('safeguards')} data-testid="live-run-health">
      <h2>{t('safeguards')}</h2>
      <dl className="lt-kv">
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
          <dd className="lt-num" data-testid="live-run-ticks">
            {t('ticksOf', { ticks: h.strategyTicks })}
          </dd>
        </div>
        <div>
          <dt>{t('heartbeat')}</dt>
          <dd className="lt-num">
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
    <section aria-label={t('controls')} data-testid="live-run-controls" className="lt-stack">
      <h2>{t('controls')}</h2>
      <p className="lt-hint">{t('stopWhat')}</p>
      <div className="lt-toolbar">
        <Button tone="secondary" disabled={busy} onClick={() => void stop()}>
          {busy ? t('stopping') : t('stop')}
        </Button>
      </div>
      <p className="lt-hint">{t('liquidateWhat')}</p>
      <div className="lt-toolbar">
        {confirming ? (
          <>
            <Button tone="secondary" disabled={busy} onClick={() => void liquidate()}>
              {t('liquidateConfirm')}
            </Button>
            <Button tone="quiet" disabled={busy} onClick={() => setConfirming(false)}>
              {t('liquidateCancel')}
            </Button>
          </>
        ) : (
          <Button tone="secondary" disabled={busy} onClick={() => setConfirming(true)}>
            {t('liquidate')}
          </Button>
        )}
      </div>
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
    <section aria-label={t('manualTitle')} data-testid="live-run-manual" className="lt-stack">
      <h2>{t('manualTitle')}</h2>
      <p className="lt-hint">{t('manualWhat')}</p>
      <form
        className="lt-stack"
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
        <Button type="submit" tone="primary" disabled={busy}>
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
    <section aria-label={t('venueTitle')} data-testid="live-run-venue" className="lt-stack">
      <h2>{t('venueTitle')}</h2>
      {!v ? (
        <p role="alert">{d.venueError ?? t('venueUnread')}</p>
      ) : (
        <>
          <p className="lt-hint" data-testid="live-run-as-of">
            {t('asOf', { time: timeText(v.asOf) })}
          </p>
          <LitTable label={t('cash')} headers={[t('colAsset'), t('colFree'), t('colLocked'), t('colTotal')]}>
            {v.balances.map((b) => (
              <tr key={b.asset} data-testid="live-run-cash" data-asset={b.asset}>
                <td>{b.asset}</td>
                <td className="lt-num">{b.free}</td>
                <td className="lt-num">{b.locked}</td>
                <td className="lt-num" data-testid="live-run-cash-total">
                  {b.total}
                </td>
              </tr>
            ))}
          </LitTable>
          <h3>{t('positions')}</h3>
          {v.positions.length === 0 ? (
            <p className="lt-hint" data-testid="live-run-no-position">
              {t('positionsNone')}
            </p>
          ) : (
            <LitTable label={t('positions')} headers={[t('colMarket'), t('colSide'), t('colSize'), t('colEntry'), t('colMark')]}>
              {v.positions.map((p) => (
                <tr key={p.symbol} data-testid="live-run-position" data-symbol={p.symbol} data-size={p.size}>
                  <td>{p.symbol}</td>
                  <td>{p.side}</td>
                  <td className="lt-num">{p.size}</td>
                  <td className="lt-num">{p.entryPrice}</td>
                  <td className="lt-num">{p.markPrice}</td>
                </tr>
              ))}
            </LitTable>
          )}
          <h3>{t('openOrders')}</h3>
          {v.openOrders.length === 0 ? (
            <p className="lt-hint" data-testid="live-run-no-open-order">
              {t('openNone')}
            </p>
          ) : (
            <LitTable label={t('openOrders')} headers={[t('colMarket'), t('colSide'), t('colPrice'), t('colRemaining')]}>
              {v.openOrders.map((o, i) => (
                <tr key={o.venueClientOrderId ?? i} data-testid="live-run-open-order">
                  <td>{o.symbol}</td>
                  <td>{o.side}</td>
                  <td className="lt-num">{o.price}</td>
                  <td className="lt-num">{o.remaining}</td>
                </tr>
              ))}
            </LitTable>
          )}
          <h3>{t('fills')}</h3>
          {v.fills.length === 0 ? (
            <p className="lt-hint">{t('fillsNone')}</p>
          ) : (
            <LitTable label={t('fills')} headers={[t('colMarket'), t('colSide'), t('colSize'), t('colPrice'), t('colFee'), t('colTime')]}>
              {v.fills.map((f) => (
                <tr key={f.fillId} data-testid="live-run-fill" data-side={f.side} data-amount={f.amount}>
                  <td>{f.symbol}</td>
                  <td>{f.side}</td>
                  <td className="lt-num">{f.amount}</td>
                  <td className="lt-num">{f.price}</td>
                  <td className="lt-num">
                    {f.venueFee} {f.feeAsset}
                  </td>
                  <td className="lt-num">{timeText(f.filledAt)}</td>
                </tr>
              ))}
            </LitTable>
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
    <section aria-label={t('ordersTitle')} className="lt-stack">
      <h2>{t('ordersTitle')}</h2>
      <LitTable
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
            <td className="lt-num">{o.seq}</td>
            <td>{t(`kind_${o.kind}`)}</td>
            <td>{o.symbol}</td>
            <td>
              {o.side}
              {o.reduceOnly ? ` · ${t('reduceOnly')}` : ''}
            </td>
            <td className="lt-num">{o.size}</td>
            <td className="lt-num">{o.price}</td>
            <td>{t(`order_${o.state}`)}</td>
            <td>{o.order ? o.order.status : '—'}</td>
          </tr>
        ))}
      </LitTable>
    </section>
  );
}

/** A table the room fills with its own rows, in a named region that scrolls on its own. */
function LitTable({ headers, children, label }: { headers: readonly ReactNode[]; children: ReactNode; label: string }) {
  return (
    <div className="lt-scroll-row" tabIndex={0} role="region" aria-label={label}>
      <table className="lt-table">
        <thead>
          <tr>
            {headers.map((head, index) => (
              <th key={index} scope="col">
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
