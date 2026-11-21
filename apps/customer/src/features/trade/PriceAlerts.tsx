import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { z } from 'zod';
import { parsesAs, type ApiResult } from '../../shared/api';
import { customerRoomHref } from '../../app/navigation';
import { useResource } from '../../shared/resource';
import { Button, Dialog, EmptyState, Failure, Field, Loading } from '../../shared/ui';
import { useSession } from '../session';
import type { Listing } from './trade-api';
import {
  alertEvaluationSchema,
  alertListSchema,
  cancelAlertReplySchema,
  createAlertReplySchema,
  evaluateAlertReplySchema,
  priceAlertSchema,
} from '@intafaced/contracts/notify-room';
import { priceAlertsCopy as copy } from './price-alerts-copy';
import { readMarker, storageKey, type Marker, type Stored } from './price-alert-marker';
import './price-alerts.css';
import {
  NOTIFY_ALERTS,
  NOTIFY_CREATE_ALERT,
  NOTIFY_CANCEL_ALERT,
  NOTIFY_EVALUATE_ALERT,
} from '@intafaced/contracts/notify-notify-procedures';

// Alert targets permit arbitrary decimal precision. The 18-place money parser
// would silently change a threshold; prices never pass through a JS number.
const validPrice = (value: string) => /^\+?\d+(?:\.\d+)?$/.test(value.trim()) && /[1-9]/.test(value.trim());
const positive = priceAlertSchema.shape.targetPrice.refine(validPrice);
/** A watch as svc-notify answers it, narrowed to what this panel shows: a positive target, and a fired watch has its time. */
// This panel only manages level alerts (no condition, or above/below a level); a crossing alert is kept on the alerts page,
// because its evaluation depends on the side the price was last seen on.
const alertSchema = priceAlertSchema
  .pick({
    id: true,
    userId: true,
    marketId: true,
    kind: true,
    direction: true,
    status: true,
    firedAt: true,
    createdAt: true,
    condition: true,
  })
  .extend({ targetPrice: positive })
  .refine((row) => row.status !== 'fired' || row.firedAt !== null);
const evaluation = alertEvaluationSchema.refine((row) =>
  row.canFire ? row.markSource === 'live' && row.code === null : row.code !== null,
);
type Alert = z.infer<typeof alertSchema>;
type Evaluation = z.infer<typeof evaluation>;
type Review =
  | { action: 'create'; direction: Alert['direction']; targetPrice: string; evaluation: Evaluation }
  | { action: 'cancel' | 'check'; row: Alert; evaluation: Evaluation };
const signature = (value: unknown) => JSON.stringify(value);
const sameWatch = (row: Alert, original: Alert) =>
  row.id === original.id &&
  row.userId === original.userId &&
  row.marketId === original.marketId &&
  row.kind === original.kind &&
  row.direction === original.direction &&
  row.targetPrice === original.targetPrice &&
  row.createdAt === original.createdAt;

function comparePrice(a: string, b: string): number {
  const parts = (value: string) => {
    const [whole, fraction = ''] = value.trim().replace(/^\+/, '').split('.');
    return [whole!.replace(/^0+(?=\d)/, ''), fraction] as const;
  };
  const [ai, af] = parts(a),
    [bi, bf] = parts(b);
  if (ai.length !== bi.length) return ai.length > bi.length ? 1 : -1;
  if (ai !== bi) return ai > bi ? 1 : -1;
  const length = Math.max(af.length, bf.length),
    left = af.padEnd(length, '0'),
    right = bf.padEnd(length, '0');
  return left === right ? 0 : left > right ? 1 : -1;
}

export function PriceAlerts({ market }: { market: Listing }) {
  const { userId, mode } = useSession();
  const { Copy, languageFor } = copy.useCopy();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" className="price-alerts-trigger" onClick={() => setOpen(true)}>
        <Copy k="title" />
      </Button>
      {open &&
        (market.paper || !userId || mode !== 'Personal' ? (
          createPortal(
            <Dialog title={<Copy k="title" />} onClose={() => setOpen(false)}>
              <div lang={languageFor('title')} className="price-alerts">
                <p>
                  <Copy k={market.paper ? 'simulation' : mode !== 'Personal' ? 'company' : 'signIn'} />
                </p>
                {!market.paper && !userId && (
                  <a className="text-link" href={'/login?redirect=' + encodeURIComponent(location.pathname + location.search)}>
                    <Copy k="signIn" />
                  </a>
                )}
              </div>
            </Dialog>,
            document.body,
          )
        ) : (
          <OwnerAlerts key={userId + ':' + market.id} userId={userId} market={market} onClose={() => setOpen(false)} />
        ))}
    </>
  );
}

function OwnerAlerts({ userId, market, onClose }: { userId: string; market: Listing; onClose: () => void }) {
  const { api } = useSession();
  const { t, Copy, languageFor } = copy.useCopy();
  const [limit, setLimit] = useState(50);
  const owned = alertSchema.refine((row) => row.userId === userId);
  const listSchema = alertListSchema
    .extend({ items: z.array(owned).max(100), evaluation })
    .refine(({ items }) => new Set(items.map((row) => row.id)).size === items.length);
  const read = useResource(
    (signal) => api.call(NOTIFY_ALERTS, { limit }, { signal, accept: parsesAs(listSchema.refine((data) => data.items.length <= limit)) }),
    userId + ':' + market.id + ':' + limit,
  );
  const [direction, setDirection] = useState<Alert['direction']>('above');
  const [targetPrice, setTargetPrice] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<'noDispatch' | 'changed' | 'storage' | 'another' | null>(null);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const [result, setResult] = useState<{
    key: 'saved' | 'cancelledResult' | 'notCancelled' | 'absentResult' | 'held' | 'firedResult' | 'fireIncomplete' | 'refused';
    row: Alert | null;
    mark?: string;
    code?: string;
    evaluation?: Evaluation;
  } | null>(null);
  const key = storageKey(userId);
  const [stored, setStored] = useState<Stored>(() => readMarker(key));
  const alive = useRef(true),
    running = useRef(false),
    controller = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    const changed = (event: StorageEvent) => {
      if (event.key === key || event.key === null) setStored(readMarker(key));
    };
    window.addEventListener('storage', changed);
    return () => {
      alive.current = false;
      controller.current?.abort();
      window.removeEventListener('storage', changed);
    };
  }, [key]);
  const rows =
    read.resource.status === 'ready'
      ? read.resource.data.items.filter(
          (row) =>
            row.marketId === market.id &&
            row.kind === 'price' &&
            (row.condition === undefined || row.condition === 'greater_than' || row.condition === 'less_than'),
        )
      : [];
  const selected = rows.find((row) => row.id === selectedId);
  const currentEvaluation = read.resource.status === 'ready' ? read.resource.data.evaluation : null;
  const blocked = busy || stored.failed || stored.marker !== null;
  const clearNotice = () => {
    setProblem(null);
    setFailure(null);
    setResult(null);
  };
  function begin(next: Review) {
    clearNotice();
    setAck(false);
    setReview(next);
  }
  function refresh() {
    if (!running.current) read.reload();
  }
  function removeMarker(marker: Marker): boolean {
    const current = readMarker(key);
    if (current.failed || current.marker?.requestId !== marker.requestId) return false;
    try {
      localStorage.removeItem(key);
      return localStorage.getItem(key) === null;
    } catch {
      return false;
    }
  }
  async function confirm() {
    if (!review || blocked || running.current || (!review.evaluation.canFire && review.action === 'create' && !ack)) return;
    if (!navigator.locks) {
      setProblem('storage');
      return;
    }
    const original = review;
    running.current = true;
    setBusy(true);
    clearNotice();
    try {
      await navigator.locks.request('customer-price-alerts:' + userId, { ifAvailable: true }, async (lock) => {
        if (!alive.current || !api.canWrite()) return;
        if (!lock) {
          setProblem('another');
          return;
        }
        const pending = readMarker(key);
        setStored(pending);
        if (pending.failed || pending.marker) {
          if (pending.failed) setProblem('storage');
          return;
        }
        const abort = new AbortController();
        controller.current = abort;
        const fresh = await api.call(NOTIFY_ALERTS, { limit: 100 }, { signal: abort.signal, accept: parsesAs(listSchema) });
        if (!alive.current || !api.canWrite()) return;
        if (!fresh.ok) {
          setFailure(fresh);
          setProblem('noDispatch');
          return;
        }
        const changed =
          signature(fresh.data.evaluation) !== signature(original.evaluation) ||
          (original.action !== 'create' &&
            !fresh.data.items.some(
              (row) => sameWatch(row, original.row) && row.status === 'active' && row.firedAt === original.row.firedAt,
            ));
        if (changed) {
          setProblem('changed');
          read.reload();
          return;
        }
        const marker: Marker = {
          requestId: crypto.randomUUID(),
          action: original.action,
          marketId: market.id,
          alertId: original.action === 'create' ? null : original.row.id,
          createdAt: new Date().toISOString(),
        };
        try {
          localStorage.setItem(key, JSON.stringify(marker));
          const saved = readMarker(key);
          if (saved.failed || saved.marker?.requestId !== marker.requestId) {
            setStored(saved);
            setProblem('storage');
            return;
          }
        } catch {
          setProblem('storage');
          return;
        }
        setStored({ marker, failed: false });
        let outcome: ApiResult<unknown>;
        let next: typeof result = null;
        if (original.action === 'create') {
          const response = createAlertReplySchema.extend({
            alert: owned.refine(
              (row) =>
                row.kind === 'price' &&
                row.marketId === market.id &&
                row.direction === original.direction &&
                row.targetPrice === original.targetPrice &&
                row.status === 'active' &&
                row.firedAt === null,
            ),
            evaluation,
          });
          const answer = await api.call(
            NOTIFY_CREATE_ALERT,
            { kind: 'price', marketId: market.id, direction: original.direction, targetPrice: original.targetPrice },
            { accept: parsesAs(response) },
          );
          outcome = answer;
          if (answer.ok) next = { key: 'saved', row: answer.data.alert, evaluation: answer.data.evaluation };
        } else {
          const returned = owned.refine((row) => sameWatch(row, original.row));
          if (original.action === 'cancel') {
            const response = cancelAlertReplySchema
              .extend({ alert: returned.nullable() })
              .refine((data) => data.cancelled === (data.alert?.status === 'cancelled'));
            const answer = await api.call(NOTIFY_CANCEL_ALERT, { id: original.row.id }, { accept: parsesAs(response) });
            outcome = answer;
            if (answer.ok)
              next = {
                key: answer.data.cancelled ? 'cancelledResult' : answer.data.alert ? 'notCancelled' : 'absentResult',
                row: answer.data.alert,
              };
          } else {
            const response = evaluateAlertReplySchema
              .extend({ alert: returned.nullable(), evaluation })
              .refine((data) => data.outcome.kind === 'refuse' || validPrice(data.outcome.markPrice))
              .refine(
                (data) =>
                  data.alert !== null ||
                  (data.outcome.kind === 'refuse' &&
                    (data.outcome.code === 'alert.not_active' ||
                      (data.outcome.code === 'alert.price_unavailable' &&
                        data.evaluation.markSource === 'dark' &&
                        !data.evaluation.canFire &&
                        data.evaluation.code === 'alert.price_unavailable'))),
              )
              .refine((data) => {
                if (data.outcome.kind === 'refuse') return true;
                const comparison = comparePrice(data.outcome.markPrice, original.row.targetPrice);
                const met = original.row.direction === 'above' ? comparison >= 0 : comparison <= 0;
                return data.outcome.kind === (met ? 'fire' : 'hold');
              });
            const answer = await api.call(NOTIFY_EVALUATE_ALERT, { id: original.row.id }, { accept: parsesAs(response) });
            outcome = answer;
            if (answer.ok) {
              const data = answer.data;
              next = {
                key:
                  data.outcome.kind === 'refuse'
                    ? 'refused'
                    : data.outcome.kind === 'hold'
                      ? 'held'
                      : data.alert?.status === 'fired'
                        ? 'firedResult'
                        : 'fireIncomplete',
                row: data.alert,
                ...(data.outcome.kind === 'refuse' ? { code: data.outcome.code } : { mark: data.outcome.markPrice }),
              };
            }
          }
        }
        // Only the matching original response can release this local attempt.
        // A later list row, matching create parameters or empty read cannot.
        const absentCreateService =
          !outcome.ok &&
          original.action === 'create' &&
          outcome.status === 412 &&
          outcome.code === 'PRECONDITION_FAILED' &&
          outcome.message === 'alert.price_unavailable';
        const definitive =
          outcome.ok || outcome.status === 401 || outcome.status === 403 || outcome.reason === 'aborted' || absentCreateService;
        if (definitive) {
          if (!removeMarker(marker)) {
            if (alive.current) setProblem('storage');
          }
        }
        if (!alive.current) return;
        setStored(readMarker(key));
        if (!outcome.ok) setFailure(definitive ? outcome : { ...outcome, reason: 'uncertain' });
        else {
          setResult(next);
          if (next?.row) setSelectedId(next.row.id);
          setReview(null);
        }
        read.reload();
      });
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const Availability = ({ data }: { data: Evaluation }) => (
    <div className={'price-alerts-availability' + (data.canFire ? ' price-alerts-availability--ready' : '')}>
      <strong>
        <Copy k={data.canFire ? 'connected' : 'dark'} />
      </strong>
      <p className="muted">
        <Copy k="availability" />
      </p>
      {data.code && (
        <p>
          <Copy k="serviceCode" />: <code lang="">{data.code}</code>
        </p>
      )}
    </div>
  );
  const condition = (row: Pick<Alert, 'direction' | 'targetPrice'>) => (
    <>
      <Copy k={row.direction} />{' '}
      <span lang="" className="price-alerts-quantity">
        {row.targetPrice}
      </span>
    </>
  );
  return createPortal(
    <Dialog
      title={
        <Copy
          k={review ? (review.action === 'create' ? 'reviewTitle' : review.action === 'cancel' ? 'cancelTitle' : 'checkTitle') : 'title'}
        />
      }
      onClose={() => {
        if (!running.current) onClose();
      }}
    >
      <div className="price-alerts" lang={languageFor('title')}>
        <p className="muted">
          <span lang="">{market.symbol}</span> · <Copy k="personal" />
        </p>
        {stored.failed && (
          <p role="alert">
            <Copy k="storage" />
          </p>
        )}
        {stored.marker && (
          <section className="price-alerts-original" role="status">
            <h3>
              <Copy k={busy ? 'working' : 'unknown'} />
            </h3>
            {!busy && (
              <p>
                <Copy k="unknownBody" />
              </p>
            )}
            <p>
              <Copy k="pendingAction" />:{' '}
              <Copy
                k={stored.marker.action === 'create' ? 'createAction' : stored.marker.action === 'cancel' ? 'cancelAction' : 'checkAction'}
              />
            </p>
            <p>
              <Copy k="marketId" />: <code lang="">{stored.marker.marketId}</code>
            </p>
            {stored.marker.alertId && (
              <p>
                <Copy k="alertId" />: <code lang="">{stored.marker.alertId}</code>
              </p>
            )}
            <p>
              <Copy k="browserAttempt" />: <code lang="">{stored.marker.requestId}</code>
            </p>
            <p className="muted">
              <Copy k="lookup" />
            </p>
          </section>
        )}
        {problem && (
          <p role="status">
            <Copy k={problem} />
          </p>
        )}
        {failure && (
          <div lang="">
            <Failure result={failure} />
          </div>
        )}
        {busy && <Loading label={<Copy k="working" />} />}
        {result && (
          <section className="price-alerts-result" role="status">
            <strong>
              <Copy k={result.key} />
            </strong>
            {result.evaluation && <Availability data={result.evaluation} />}
            {result.row && (
              <p>
                <Copy k={result.row.status} /> · {condition(result.row)}{' '}
                <Copy k="unit" params={{ quote: market.quote, base: market.base }} />
              </p>
            )}
            {result.mark && (
              <p>
                <Copy k="mark" />:{' '}
                <span lang="" className="price-alerts-quantity">
                  {result.mark}
                </span>{' '}
                <Copy k="unit" params={{ quote: market.quote, base: market.base }} />
              </p>
            )}
            {result.code && <code lang="">{result.code}</code>}
          </section>
        )}
        {review && !stored.marker ? (
          <section className="price-alerts-review">
            <p>
              <Copy k="price" params={{ quote: market.quote, base: market.base }} />
            </p>
            <strong className="price-alerts-quantity" lang="">
              {review.action === 'create' ? review.targetPrice : review.row.targetPrice}
            </strong>
            <p>
              <Copy k={review.action === 'create' ? review.direction : review.row.direction} />
            </p>
            {review.action !== 'create' && (
              <p>
                <Copy k="alertId" />: <code lang="">{review.row.id}</code>
              </p>
            )}
            <Availability data={review.evaluation} />
            <p className="muted">
              <Copy k={review.action === 'create' ? 'oneShot' : review.action === 'cancel' ? 'cancelMeaning' : 'checkMeaning'} />
            </p>
            {review.action === 'create' && !review.evaluation.canFire && (
              <label className="price-alerts-ack">
                <input type="checkbox" checked={ack} disabled={busy} onChange={(event) => setAck(event.target.checked)} />
                <Copy k="darkAck" />
              </label>
            )}
            <div className="price-alerts-actions">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setReview(null);
                  clearNotice();
                }}
              >
                <Copy k="back" />
              </Button>
              <Button
                variant={review.action === 'cancel' ? 'danger' : 'primary'}
                disabled={blocked || (review.action === 'create' && !review.evaluation.canFire && !ack)}
                onClick={() => void confirm()}
              >
                <Copy k={review.action === 'create' ? 'save' : review.action === 'cancel' ? 'cancel' : 'check'} />
              </Button>
            </div>
          </section>
        ) : (
          !stored.marker && (
            <>
              <p className="muted">
                <Copy k="scope" />
              </p>
              {currentEvaluation && <Availability data={currentEvaluation} />}
              <form
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  const price = targetPrice.trim();
                  if (!positive.safeParse(price).success) {
                    setInvalid(true);
                    return;
                  }
                  if (currentEvaluation && !blocked)
                    begin({ action: 'create', targetPrice: price, direction, evaluation: currentEvaluation });
                }}
              >
                <h3>
                  <Copy k="newAlert" />
                </h3>
                <label className="field">
                  <span>
                    <Copy k="direction" />
                  </span>
                  <select
                    aria-label={t('direction')}
                    value={direction}
                    disabled={blocked}
                    onChange={(event) => setDirection(event.target.value as Alert['direction'])}
                  >
                    <option value="above">{t('above')}</option>
                    <option value="below">{t('below')}</option>
                  </select>
                </label>
                <Field
                  label={<Copy k="price" params={{ quote: market.quote, base: market.base }} />}
                  inputMode="decimal"
                  maxLength={64}
                  value={targetPrice}
                  disabled={blocked}
                  error={invalid ? <Copy k="invalidPrice" /> : undefined}
                  onChange={(event) => {
                    setTargetPrice(event.target.value);
                    setInvalid(false);
                  }}
                />
                <Button type="submit" disabled={blocked || !currentEvaluation}>
                  <Copy k="review" />
                </Button>
              </form>
            </>
          )
        )}
        <section className="price-alerts-list">
          <header>
            <h3>
              <Copy k="currentAlerts" />
            </h3>
            <Button variant="ghost" disabled={busy} onClick={refresh}>
              <Copy k="refresh" />
            </Button>
          </header>
          {read.resource.status === 'loading' ? (
            <Loading />
          ) : read.resource.status === 'failed' ? (
            <div lang="">
              <Failure result={read.resource.failure} retry={refresh} />
            </div>
          ) : (
            <>
              {rows.length ? (
                rows.map((row) => (
                  <article className="price-alerts-row" key={row.id}>
                    <div>
                      <strong>{condition(row)}</strong>
                      <span className={'price-alerts-status price-alerts-status--' + row.status}>
                        <Copy k={row.status} />
                      </span>
                    </div>
                    <p className="muted">
                      <Copy k="unit" params={{ quote: market.quote, base: market.base }} />
                    </p>
                    <Button variant="secondary" onClick={() => setSelectedId(row.id)}>
                      <Copy k="inspect" />
                    </Button>
                  </article>
                ))
              ) : (
                <EmptyState title={<Copy k="empty" />}>
                  <Copy k="emptyBody" />
                </EmptyState>
              )}
              <p className="muted">
                <Copy k="window" params={{ limit }} />
              </p>
              {limit < 100 && read.resource.data.items.length >= limit && (
                <Button variant="secondary" onClick={() => setLimit(100)}>
                  <Copy k="more" />
                </Button>
              )}
            </>
          )}
        </section>
        {selectedId && (
          <section className="price-alerts-selection" aria-label={t('selected')}>
            <header>
              <h3>
                <Copy k="selected" />
              </h3>
              <Button variant="ghost" onClick={() => setSelectedId(null)}>
                <Copy k="closeSelection" />
              </Button>
            </header>
            <p>
              <Copy k="alertId" />: <code lang="">{selectedId}</code>
            </p>
            {selected ? (
              <>
                <p>
                  {condition(selected)} <Copy k="unit" params={{ quote: market.quote, base: market.base }} /> · <Copy k={selected.status} />
                </p>
                <p>
                  <Copy k="created" />:{' '}
                  <time lang="" dateTime={selected.createdAt}>
                    {selected.createdAt}
                  </time>
                </p>
                {selected.firedAt && (
                  <p>
                    <Copy k="firedAt" />:{' '}
                    <time lang="" dateTime={selected.firedAt}>
                      {selected.firedAt}
                    </time>
                  </p>
                )}
                {selected.status === 'active' && currentEvaluation && (
                  <div className="price-alerts-actions">
                    <Button
                      variant="secondary"
                      disabled={blocked}
                      onClick={() => begin({ action: 'check', row: selected, evaluation: currentEvaluation })}
                    >
                      <Copy k="reviewCheck" />
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={blocked}
                      onClick={() => begin({ action: 'cancel', row: selected, evaluation: currentEvaluation })}
                    >
                      <Copy k="reviewCancel" />
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <p className="muted">
                <Copy k="missing" />
              </p>
            )}
          </section>
        )}
        <nav className="price-alerts-exits">
          <a className="text-link" href={customerRoomHref('/support')}>
            <Copy k="support" />
          </a>
          <a className="text-link" href="/notifications">
            <Copy k="settings" />
          </a>
        </nav>
      </div>
    </Dialog>,
    document.body,
  );
}
