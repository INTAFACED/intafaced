import { useRef, useState } from 'react';
import { parseAmount } from '../../../shared/money';
import { usePolled } from '../../../features/protocol/wallet/use-polled';
import {
  SPOT_CONDITIONAL_KINDS,
  type SpotConditionalKind,
  type SpotConditionalRequest,
  type SpotConditionalView,
  type SpotFeeLeg,
  type SpotLegView,
  type VenueMarket,
} from '../../../features/trade/venue-api';
import { VENUE_POLL_MS, outcomeText, useVenueApi } from '../../../features/trade/venue/VenueKit';
import { venueCopy } from '../../../features/trade/venue/venue-copy';
import { refusalOf, useSignPrepared, type Refusal } from '../futures/VenueProtect';
import { canonical } from '../futures/venue-protect-logic';
import { Button } from './deps';
import { spotConditionalCopy } from './spot-conditional-copy';
import { SPOT_FIELDS, legsOutOfOrder, optionalField, spotClientId, type SpotField } from './spot-conditional-logic';

type CT = ReturnType<typeof spotConditionalCopy.useCopy>['t'];

/**
 * Conditional orders on the venue spot desk (J-cex-spot-08): a stop-limit, a stop-market, an OCO, a bracket and an entry
 * with a linked close. Whether the venue holds a stop on spot is its own declaration; a kind it lacks is run by
 * INTAFACED on our engine under the agent permission the person approves once, and every such order says so. The
 * pending list reads each order and each leg as svc-trade and the venue report it now.
 */
export function VenueConditionalOrders({ market, owner, venueName }: { market: VenueMarket; owner: string | null; venueName: string }) {
  const { t } = spotConditionalCopy.useCopy();
  if (!owner) return null;
  return (
    <section className="dk-panel form-stack" aria-label={t('Title')} data-testid="spot-conditional">
      <h2 className="dk-tab-title">{t('Title')}</h2>
      <p className="muted">{t('Note')}</p>
      <ConditionalForm market={market} owner={owner} venueName={venueName} />
    </section>
  );
}

const fieldLabel = (t: CT, kind: SpotConditionalKind, f: SpotField) =>
  (kind === 'oco' || kind === 'bracket') && (f === 'triggerPrice' || f === 'limitPrice') ? t(`field_${f}_oco`) : t(`field_${f}`);

function positive(value: string): boolean {
  try {
    return /^\d+(\.\d+)?$/.test(value.trim()) && parseAmount(value.trim()) > 0n;
  } catch {
    return false;
  }
}

function RefusalAlert({ refusal }: { refusal: Refusal | null }) {
  const { t } = spotConditionalCopy.useCopy();
  if (!refusal) return null;
  return (
    <div className="failure" role="alert" data-testid="spot-conditional-refusal">
      <p>{refusal.message}</p>
      {refusal.code ? <p className="muted">{t('Code', { code: refusal.code })}</p> : null}
    </div>
  );
}

function ConditionalForm({ market, owner, venueName }: { market: VenueMarket; owner: string; venueName: string }) {
  const { t } = spotConditionalCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const venue = useVenueApi();
  const sign = useSignPrepared(owner);
  const [kind, setKind] = useState<SpotConditionalKind>('stop_limit');
  const [side, setSide] = useState<'buy' | 'sell'>('sell');
  const [tif, setTif] = useState<'GTC' | 'IOC'>('GTC');
  const [size, setSize] = useState('');
  const [fields, setFields] = useState<Partial<Record<SpotField, string>>>({});
  const [review, setReview] = useState<SpotFeeLeg[] | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const busy = useRef(false);
  const counter = useRef(0);
  // One client id per drafted order: a second press of Place is the same order, never a second one.
  const [clientId, setClientId] = useState(() => spotClientId(Date.now(), 0));
  const list = usePolled((signal) => venue.spotOrders(owner, signal), `spot-orders:${owner}`, VENUE_POLL_MS);
  const mine = (list.data?.orders ?? []).filter((o) => o.symbol === market.symbol);
  const engine = (market.triggerSources ?? []).includes('last') && (kind === 'stop_limit' || kind === 'stop_market') ? 'venue' : 'engine';
  const shown = SPOT_FIELDS[kind];

  const redraft = () => {
    setReview(null);
    setOutcome(null);
    setRefusal(null);
    setClientId(spotClientId(Date.now(), (counter.current += 1)));
  };

  /** The request the form holds now, or a refusal in its words before anything is sent. */
  function request(): SpotConditionalRequest | Refusal {
    if (!positive(size)) return { message: t('Size invalid'), code: null };
    const out: SpotConditionalRequest = { owner, symbol: market.symbol, kind, side, quantity: canonical(size), clientOrderId: clientId };
    for (const f of shown) {
      const value = (fields[f] ?? '').trim();
      // A blank trigger goes to svc-trade, which refuses it in its own words; any other blank needed field stops here.
      if (value === '') {
        if (f === 'triggerPrice' || optionalField(kind, side, f) || (f === 'limitPrice' && kind !== 'stop_limit')) continue;
        return { message: t('Field invalid', { field: fieldLabel(t, kind, f) }), code: null };
      }
      if (!positive(value)) return { message: t('Field invalid', { field: fieldLabel(t, kind, f) }), code: null };
      out[f] = canonical(value);
    }
    if (kind === 'bracket' || kind === 'oto') out.entryTif = tif;
    // The form refuses legs out of order before anything is sent.
    const problem = legsOutOfOrder(kind, side, out);
    if (problem) {
      const words =
        problem.key === 'tp_above_sl' || problem.key === 'tp_below_sl'
          ? t(`order_${problem.key}`, { tp: problem.tp, sl: problem.sl })
          : problem.key === 'limit_past_trigger'
            ? t(`order_limit_past_trigger_${problem.exit}`)
            : t(`order_close_side_${problem.side}`);
      return { message: words, code: 'form.legs_out_of_order' };
    }
    return out;
  }

  async function doReview() {
    if (busy.current) return;
    setRefusal(null);
    setOutcome(null);
    const req = request();
    if ('message' in req) return setRefusal(req);
    busy.current = true;
    try {
      const answer = await venue.reviewSpotOrder(req);
      if (!answer.ok) return setRefusal({ message: answer.message, code: answer.code ?? null });
      setReview(answer.data.legs);
    } finally {
      busy.current = false;
    }
  }

  async function place() {
    if (busy.current) return;
    setRefusal(null);
    setOutcome(null);
    const req = request();
    if ('message' in req) return setRefusal(req);
    busy.current = true;
    try {
      const created = await venue.createSpotOrder(req);
      if (!created.ok) return setRefusal({ message: created.message, code: created.code ?? null });
      const made = created.data;
      if (made.restsOn === 'venue') {
        const answer = await sign(made);
        const refused = refusalOf(answer, (r) => outcomeText(v, r));
        if (refused) return setRefusal(refused);
        return setOutcome(t('Placed venue'));
      }
      if (made.entry && !made.entry.signed) {
        const answer = await sign(made.entry);
        const refused = refusalOf(answer, (r) => outcomeText(v, r));
        if (refused) return setRefusal(refused);
        return setOutcome(t('Placed entry'));
      }
      setOutcome(made.reused ? t('Placed same') : t('Placed engine'));
    } finally {
      busy.current = false;
      list.reload();
    }
  }

  return (
    <div className="form-stack" data-testid="spot-conditional-form" data-client-order-id={clientId}>
      <div role="group" aria-label={t('Kind')} className="dk-order-opts">
        {SPOT_CONDITIONAL_KINDS.map((k) => (
          <Button
            key={k}
            size={32}
            variant={kind === k ? 'primary' : 'secondary'}
            aria-pressed={kind === k}
            onClick={() => {
              setKind(k);
              redraft();
            }}
          >
            {t(`kind_${k}`)}
          </Button>
        ))}
      </div>
      <div role="group" aria-label={t('Side')} className="dk-order-opts">
        {(['buy', 'sell'] as const).map((x) => (
          <Button
            key={x}
            size={32}
            variant={side === x ? 'primary' : 'secondary'}
            aria-pressed={side === x}
            onClick={() => {
              setSide(x);
              redraft();
            }}
          >
            {t(`side_${x}`)}
          </Button>
        ))}
      </div>
      <p data-testid="spot-conditional-where" data-where={engine}>
        {engine === 'engine' ? t('where_engine') : t('where_venue')}
      </p>
      {engine === 'engine' ? <p className="muted">{t('where_engine_note', { venue: venueName })}</p> : null}
      {engine === 'engine' ? <AgentPermission owner={owner} /> : null}
      <NumberField
        label={t('Size', { base: market.baseAsset })}
        value={size}
        onChange={(x) => {
          setSize(x);
          setReview(null);
        }}
      />
      {shown.map((f) => (
        <NumberField
          key={`${kind}:${f}`}
          label={fieldLabel(t, kind, f)}
          value={fields[f] ?? ''}
          onChange={(x) => {
            setFields({ ...fields, [f]: x });
            setReview(null);
          }}
        />
      ))}
      {kind === 'bracket' || kind === 'oto' ? (
        <div role="group" aria-label={t('Entry tif')} className="dk-order-opts">
          {(['GTC', 'IOC'] as const).map((x) => (
            <Button key={x} size={32} variant={tif === x ? 'primary' : 'secondary'} aria-pressed={tif === x} onClick={() => setTif(x)}>
              {t(`tif_${x}`)}
            </Button>
          ))}
        </div>
      ) : null}
      <div className="dk-order-opts">
        <Button variant="secondary" onClick={() => void doReview()}>
          {t('Review')}
        </Button>
        <Button onClick={() => void place()}>{t('Place')}</Button>
      </div>
      {review ? <ReviewRows legs={review} /> : null}
      <RefusalAlert refusal={refusal} />
      {outcome ? (
        <p role="status" data-testid="spot-conditional-outcome">
          {outcome}
        </p>
      ) : null}
      <PendingList orders={mine} loaded={list.data !== null} failure={list.failure?.message ?? null} onChanged={list.reload} />
    </div>
  );
}

function ReviewRows({ legs }: { legs: SpotFeeLeg[] }) {
  const { t } = spotConditionalCopy.useCopy();
  return (
    <section aria-label={t('Review title')} data-testid="spot-conditional-review" className="form-stack">
      <h3 className="dk-tab-title">{t('Review title')}</h3>
      <ul>
        {legs.map((leg) => {
          const base = {
            role: t(`role_${leg.role}`),
            side: t(`side_${leg.side}`),
            quantity: canonical(leg.quantity),
            price: canonical(leg.price),
            liquidity: t(`liquidity_${leg.liquidity}`),
          };
          return (
            <li key={leg.role} data-leg={leg.role} data-liquidity={leg.liquidity}>
              {leg.venueFeeBps === null || leg.estimatedFee === null
                ? t('review_row_unpublished', base)
                : t('review_row', {
                    ...base,
                    bps: canonical(leg.venueFeeBps),
                    builder: canonical(leg.builderFeeBps ?? '0'),
                    fee: canonical(leg.estimatedFee),
                    asset: leg.feeAsset,
                  })}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input inputMode="decimal" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** The agent permission our engine needs: the spot-order key approved on the person's venue account, once. */
function AgentPermission({ owner }: { owner: string }) {
  const { t } = spotConditionalCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const venue = useVenueApi();
  const sign = useSignPrepared(owner);
  const agent = usePolled((signal) => venue.spotAgent(owner, signal), `spot-agent:${owner}`, VENUE_POLL_MS);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [accepted, setAccepted] = useState(false);
  const busy = useRef(false);

  async function approve() {
    if (busy.current) return;
    busy.current = true;
    setRefusal(null);
    try {
      const prepared = await venue.prepareSpotAgent(owner);
      if (!prepared.ok) return setRefusal({ message: prepared.message, code: prepared.code ?? null });
      const answer = await sign(prepared.data);
      const refused = refusalOf(answer, (r) => outcomeText(v, r));
      if (refused) return setRefusal(refused);
      setAccepted(true);
    } finally {
      busy.current = false;
      agent.reload();
    }
  }

  const approved = agent.data?.approved === true || accepted;
  return (
    <section className="form-stack" aria-label={t('Agent permission')} data-testid="spot-agent">
      <h3 className="dk-tab-title">{t('Agent permission')}</h3>
      <p>{t('Agent note')}</p>
      {approved ? (
        <p role="status">{t('Agent approved')}</p>
      ) : agent.failure ? (
        <RefusalAlert refusal={{ message: agent.failure.message, code: agent.failure.code ?? null }} />
      ) : agent.data ? (
        <Button onClick={() => void approve()}>{t('Agent approve')}</Button>
      ) : (
        <p className="muted">{t('Agent checking')}</p>
      )}
      <RefusalAlert refusal={refusal} />
    </section>
  );
}

function PendingList({
  orders,
  loaded,
  failure,
  onChanged,
}: {
  orders: SpotConditionalView[];
  loaded: boolean;
  failure: string | null;
  onChanged: () => void;
}) {
  const { t } = spotConditionalCopy.useCopy();
  return (
    <section aria-label={t('Pending title')} data-testid="spot-conditional-pending" className="form-stack">
      <h3 className="dk-tab-title">{t('Pending title')}</h3>
      {failure ? (
        <p className="failure">{failure}</p>
      ) : orders.length === 0 ? (
        loaded ? (
          <p className="muted">{t('Pending empty')}</p>
        ) : null
      ) : (
        <table className="dk-table">
          <thead>
            <tr>
              {(['kind', 'side', 'size', 'trigger', 'reference', 'status', 'where', 'legs', 'actions'] as const).map((c) => (
                <th key={c} scope="col">
                  {t(`col_${c}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <PendingRow key={o.id} order={o} onChanged={onChanged} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const LIVE = new Set(['entry', 'placing', 'open', 'armed']);
const REASONS = ['entry_filled_nothing', 'take_profit_ended', 'cancelled'] as const;
const isReason = (r: string | null): r is (typeof REASONS)[number] => REASONS.includes(r as (typeof REASONS)[number]);

function legLine(t: CT, leg: SpotLegView, asset: (leg: SpotLegView) => string): string {
  return t('leg_line', {
    role: t(`role_${leg.role}`),
    side: t(`side_${leg.side}`),
    quantity: canonical(leg.quantity),
    price: leg.type === 'market' ? t('leg_market') : leg.price ? t('leg_price', { price: canonical(leg.price) }) : '',
    trigger: leg.triggerPrice ? t('leg_trigger', { price: canonical(leg.triggerPrice) }) : '',
    where: leg.restsOn === 'venue' ? t('leg_venue') : t('leg_engine'),
    status: t(`leg_${leg.status}`),
    locked: leg.locked && parseAmount(leg.locked) > 0n ? t('leg_locked', { locked: canonical(leg.locked), asset: asset(leg) }) : '',
    linked: leg.linkedTo ? t('leg_linked', { role: t(`role_${leg.linkedTo}`).toLowerCase() }) : '',
  });
}

function PendingRow({ order: o, onChanged }: { order: SpotConditionalView; onChanged: () => void }) {
  const { t } = spotConditionalCopy.useCopy();
  const venue = useVenueApi();
  const [editing, setEditing] = useState(false);
  const [trigger, setTrigger] = useState(o.triggerPrice ?? '');
  const [limit, setLimit] = useState(o.limitPrice ?? '');
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  // A fired stop-limit's limit order that still rests on the venue can be cancelled there too.
  const resting = o.kind === 'stop_limit' && o.status === 'fired' && ['open', 'partially_filled'].includes(o.legs[0]?.status ?? '');
  const live = LIVE.has(o.status);
  const modifiable = live && o.kind !== 'oto' && o.triggerPrice !== null;

  async function cancel() {
    setRefusal(null);
    const answer = await venue.cancelSpotOrder(o.id);
    if (!answer.ok) setRefusal({ message: answer.message, code: answer.code ?? null });
    onChanged();
  }

  async function save() {
    setRefusal(null);
    const body: { triggerPrice: string; limitPrice?: string } = { triggerPrice: canonical(trigger) };
    if (o.kind === 'stop_limit' || o.limitPrice !== null) body.limitPrice = canonical(limit);
    const answer = await venue.modifySpotOrder(o.id, body);
    if (!answer.ok) return setRefusal({ message: answer.message, code: answer.code ?? null });
    setEditing(false);
    onChanged();
  }

  const asset = (leg: SpotLegView) => leg.lockedAsset ?? '';
  return (
    <tr data-client-order-id={o.clientOrderId} data-kind={o.kind} data-status={o.status} data-id={o.id}>
      <td data-cell="kind">{t(`kind_${o.kind}`)}</td>
      <td data-cell="side">{t(`side_${o.side}`)}</td>
      <td data-cell="size">{canonical(o.quantity)}</td>
      <td data-cell="trigger">{o.triggerPrice ? canonical(o.triggerPrice) : ''}</td>
      <td data-cell="reference">
        {o.referencePrice ? `${canonical(o.referencePrice)} (${t('Reference note')})` : live ? t('reference_none') : ''}
      </td>
      <td data-cell="status">
        {t(`status_${o.status}`)}
        {o.failure ? <span className="failure"> · {t('Failure', { failure: o.failure })}</span> : null}
        {o.status === 'cancelled' && isReason(o.cancelReason) ? <span> · {t(`Cancel reason ${o.cancelReason}`)}</span> : null}
      </td>
      <td data-cell="where">{o.label}</td>
      <td data-cell="legs">
        <ul>
          {o.legs.map((leg) => (
            <li key={leg.role} data-leg={leg.role} data-leg-status={leg.status} data-rests-on={leg.restsOn}>
              {legLine(t, leg, asset)}
            </li>
          ))}
        </ul>
      </td>
      <td data-cell="actions">
        {modifiable && !editing ? (
          <Button size={32} variant="secondary" aria-label={`${t('Modify')} ${o.clientOrderId}`} onClick={() => setEditing(true)}>
            {t('Modify')}
          </Button>
        ) : null}
        {editing ? (
          <span className="form-stack">
            <NumberField label={t('Modify trigger')} value={trigger} onChange={setTrigger} />
            {o.kind === 'stop_limit' || o.limitPrice !== null ? (
              <NumberField label={t('Modify limit')} value={limit} onChange={setLimit} />
            ) : null}
            <Button size={32} onClick={() => void save()}>
              {t('Save')}
            </Button>
          </span>
        ) : null}
        {live || resting ? (
          <Button size={32} variant="secondary" aria-label={`${t('Cancel')} ${o.clientOrderId}`} onClick={() => void cancel()}>
            {t('Cancel')}
          </Button>
        ) : null}
        <RefusalAlert refusal={refusal} />
      </td>
    </tr>
  );
}
