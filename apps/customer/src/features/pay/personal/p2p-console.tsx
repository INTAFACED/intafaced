import { useState } from 'react';
import { Button, ReviewDialog as Dialog } from '@intafaced/ui';
import type { ApiResult } from '../../../shared/api';
import { useResource } from '../../../shared/resource';
import { uiCopy } from '../../../shared/ui-copy';
import type { PersonalPayApi } from '../pay-api';
import type { BulkOutcome, Offer, Presence, PresenceWindow, TodoItem } from '../schemas';
import { PayFailure, PayState, PayTime } from '../components';
import { consoleCopy } from './p2p-console-copy';

/**
 * P-ads-merchant-08 (J-p2p-05 #4): the merchant console. Presence (online, offline or a weekly schedule in the person's
 * own time zone) decides whether their ads are on the board; the to-do list shows the open orders that wait on someone,
 * soonest deadline first; a bulk action pauses, resumes or removes several ads, each answering for itself.
 */

const DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
/** The most ads one bulk action takes (svc-p2p's own limit). */
const MAX_BULK = 100;
const dayKey = (day: number) => `day${day}` as `day${(typeof DAYS)[number]}`;
const ownZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

export function MerchantPresence({ pay, userId, onChanged }: { pay: PersonalPayApi; userId: string | null; onChanged?: () => void }) {
  const { Copy, t } = consoleCopy.useCopy();
  const [revision, setRevision] = useState(0);
  const presence = useResource((signal) => pay.presence(signal), `pay:presence:${userId}:${revision}`);
  return (
    <section className="stack" aria-label={t('presenceTitle')} data-testid="merchant-presence">
      <h3>
        <Copy k="presenceTitle" />
      </h3>
      <PayState resource={presence.resource} retry={presence.reload}>
        {(current) => (
          <PresenceForm
            key={`${current.updatedAt ?? 'none'}`}
            pay={pay}
            current={current}
            onSaved={() => {
              setRevision((n) => n + 1);
              onChanged?.();
            }}
          />
        )}
      </PayState>
    </section>
  );
}

function PresenceForm({ pay, current, onSaved }: { pay: PersonalPayApi; current: Presence; onSaved: () => void }) {
  const { Copy, t } = consoleCopy.useCopy();
  const [mode, setMode] = useState<Presence['mode']>(current.mode);
  const [timezone, setTimezone] = useState(current.mode === 'scheduled' ? current.timezone : ownZone());
  const [windows, setWindows] = useState<PresenceWindow[]>(
    current.windows.length ? current.windows : [{ day: 1, start: '09:00', end: '17:00' }],
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const result = await pay.setPresence(mode === 'scheduled' ? { mode, timezone, windows } : { mode });
    setBusy(false);
    if (!result.ok) return setFailure(result);
    onSaved();
  };
  const change = (index: number, patch: Partial<PresenceWindow>) =>
    setWindows((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <div className="form-stack">
      <p data-testid="presence-state" data-on-board={current.onBoard ? 'true' : 'false'}>
        <Copy k={current.onBoard ? 'presenceOnBoard' : 'presenceOffBoard'} />
        {current.nextChangeAt ? (
          <>
            {' '}
            <span data-testid="presence-next">
              <Copy k={current.onBoard ? 'presenceLeavesAt' : 'presenceBackAt'} /> <PayTime value={current.nextChangeAt} />.
            </span>
          </>
        ) : null}
      </p>
      <fieldset className="form-stack">
        <legend className="muted">
          <Copy k="presenceHint" />
        </legend>
        {(['online', 'offline', 'scheduled'] as const).map((value) => (
          <label key={value}>
            <input type="radio" name="presence-mode" value={value} checked={mode === value} onChange={() => setMode(value)} />{' '}
            <Copy k={value === 'online' ? 'presenceOnline' : value === 'offline' ? 'presenceOffline' : 'presenceScheduled'} />
          </label>
        ))}
      </fieldset>
      {mode === 'scheduled' ? (
        <div className="form-stack" data-testid="presence-schedule">
          <label>
            <Copy k="presenceZone" /> <input value={timezone} onChange={(event) => setTimezone(event.target.value)} />
          </label>
          {windows.map((row, index) => (
            <div className="actions" key={index} data-testid="presence-window">
              <label>
                <Copy k="presenceDay" />{' '}
                <select value={row.day} onChange={(event) => change(index, { day: Number(event.target.value) })}>
                  {DAYS.map((day) => (
                    <option key={day} value={day}>
                      {t(dayKey(day))}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <Copy k="presenceFrom" />{' '}
                <input type="time" value={row.start} onChange={(event) => change(index, { start: event.target.value })} />
              </label>
              <label>
                <Copy k="presenceTo" />{' '}
                <input value={row.end} pattern="\d{2}:\d{2}" onChange={(event) => change(index, { end: event.target.value })} />
              </label>
              <Button
                variant="ghost"
                disabled={windows.length === 1}
                onClick={() => setWindows((rows) => rows.filter((_, i) => i !== index))}
              >
                <Copy k="presenceRemoveWindow" />
              </Button>
            </div>
          ))}
          <Button variant="secondary" onClick={() => setWindows((rows) => [...rows, { day: 1, start: '09:00', end: '17:00' }])}>
            <Copy k="presenceAddWindow" />
          </Button>
        </div>
      ) : null}
      {failure ? (
        failure.code === 'p2p.schedule_invalid' ? (
          <p className="failure" role="alert" data-testid="failure">
            <Copy k="presenceInvalid" />
          </p>
        ) : (
          <PayFailure result={failure} />
        )
      ) : null}
      <div className="actions">
        <Button variant="primary" disabled={busy} onClick={() => void save()}>
          <Copy k={busy ? 'presenceSaving' : 'presenceSave'} />
        </Button>
      </div>
    </div>
  );
}

const TODO_LABEL = {
  payment_required: 'todoPay',
  release_required: 'todoRelease',
  counterparty_action: 'todoOther',
  dispute_open: 'todoDispute',
} as const;

export function MerchantTodos({ pay, userId }: { pay: PersonalPayApi; userId: string | null }) {
  const { Copy, t } = consoleCopy.useCopy();
  const todos = useResource((signal) => pay.todos(signal), `pay:todos:${userId}`);
  return (
    <section className="stack" aria-label={t('todoTitle')} data-testid="merchant-todos">
      <h3>
        <Copy k="todoTitle" />
      </h3>
      <PayState resource={todos.resource} retry={todos.reload}>
        {(items) =>
          items.length === 0 ? (
            <p className="muted">
              <Copy k="todoNone" />
            </p>
          ) : (
            <ol className="stack">
              {items.map((item) => (
                <TodoRow key={item.tradeId} item={item} />
              ))}
            </ol>
          )
        }
      </PayState>
    </section>
  );
}

function TodoRow({ item }: { item: TodoItem }) {
  const { Copy } = consoleCopy.useCopy();
  return (
    <li data-testid="todo-item" data-trade-id={item.tradeId} data-kind={item.kind}>
      <strong>
        <Copy k={TODO_LABEL[item.kind]} />
      </strong>{' '}
      · {item.amount} {item.asset} · {item.fiatAmount} {item.fiatCurrency} ·{' '}
      {item.deadlineAt ? (
        <>
          <Copy k="todoBy" /> <PayTime value={item.deadlineAt} />
        </>
      ) : (
        <Copy k="todoNoDeadline" />
      )}{' '}
      <a className="text-link" href={item.link}>
        <Copy k="todoOpen" />
      </a>
    </li>
  );
}

const RESULT_LABEL: Record<string, 'bulkClosed' | 'bulkHasOrders' | 'bulkNotYours'> = {
  'p2p.offer_closed': 'bulkClosed',
  'p2p.offer_has_open_trades': 'bulkHasOrders',
  'p2p.not_a_party': 'bulkNotYours',
  'p2p.offer_not_found': 'bulkNotYours',
};

export function BulkAds({
  pay,
  userId,
  revision,
  side,
  onChanged,
}: {
  pay: PersonalPayApi;
  userId: string | null;
  revision: number;
  side: (offer: Offer) => React.ReactNode;
  onChanged: () => void;
}) {
  const { Copy, t } = consoleCopy.useCopy();
  const active = useResource((signal) => pay.activeOffers(signal), `pay:bulk-active:${userId}:${revision}`);
  const paused = useResource((signal) => pay.pausedOffers(signal), `pay:bulk-paused:${userId}:${revision}`);
  const [picked, setPicked] = useState<string[]>([]);
  const [asking, setAsking] = useState<BulkOutcome['action'] | null>(null);
  // The request's key names this action on these ads, asked at this moment: a retry from the same confirmation after a
  // lost reply sends it again and is answered once; cancelling and asking again is a new request with a new key.
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const [outcome, setOutcome] = useState<BulkOutcome | null>(null);
  const ads = [
    ...(active.resource.status === 'ready' ? active.resource.data : []),
    ...(paused.resource.status === 'ready' ? paused.resource.data : []),
  ];
  const chosen = ads.filter((ad) => picked.includes(ad.id));
  const run = async () => {
    if (!asking || busy) return;
    setBusy(true);
    setFailure(null);
    const result = await pay.bulkOffers({ action: asking, offerIds: picked, idempotencyKey: key });
    setBusy(false);
    if (!result.ok) return setFailure(result);
    setOutcome(result.data);
    setAsking(null);
    setPicked([]);
    onChanged();
  };
  return (
    <section className="stack" aria-label={t('bulkTitle')} data-testid="bulk-ads">
      <h3>
        <Copy k="bulkTitle" />
      </h3>
      <PayState resource={active.resource} retry={active.reload}>
        {() =>
          ads.length === 0 ? (
            <p className="muted">
              <Copy k="bulkNone" />
            </p>
          ) : (
            <fieldset className="form-stack">
              <legend className="muted">
                <Copy k="bulkPick" />
              </legend>
              {ads.map((ad) => (
                <label key={ad.id} data-testid="bulk-ad" data-offer-id={ad.id}>
                  <input
                    type="checkbox"
                    checked={picked.includes(ad.id)}
                    onChange={(event) => setPicked((ids) => (event.target.checked ? [...ids, ad.id] : ids.filter((id) => id !== ad.id)))}
                  />{' '}
                  {side(ad)} · {ad.status}
                </label>
              ))}
            </fieldset>
          )
        }
      </PayState>
      {picked.length > MAX_BULK ? (
        <p className="muted" data-testid="bulk-too-many">
          {t('bulkTooMany', { max: String(MAX_BULK) })}
        </p>
      ) : null}
      <div className="actions">
        {(['pause', 'resume', 'remove'] as const).map((action) => (
          <Button
            key={action}
            variant="secondary"
            disabled={picked.length === 0 || picked.length > MAX_BULK}
            onClick={() => {
              setFailure(null);
              setKey(`bulk:${action}:${picked.length}:${Date.now()}`);
              setAsking(action);
            }}
          >
            <Copy k={action === 'pause' ? 'bulkPause' : action === 'resume' ? 'bulkResume' : 'bulkRemove'} />
          </Button>
        ))}
      </div>
      {asking ? (
        <Dialog closeLabel={uiCopy.t('closeDialog')} title={t('bulkConfirmTitle')} onClose={() => (busy ? undefined : setAsking(null))}>
          <div className="form-stack" data-testid="bulk-confirm">
            <p>
              <Copy k={asking === 'pause' ? 'bulkConfirmPause' : asking === 'resume' ? 'bulkConfirmResume' : 'bulkConfirmRemove'} />
            </p>
            <ul>
              {chosen.map((ad) => (
                <li key={ad.id} data-offer-id={ad.id}>
                  {side(ad)}
                </li>
              ))}
            </ul>
            {failure ? <PayFailure result={failure} /> : null}
            <div className="actions">
              <Button variant="ghost" disabled={busy} onClick={() => setAsking(null)}>
                <Copy k="bulkCancel" />
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => void run()}>
                <Copy k={busy ? 'bulkWorking' : 'bulkGo'} />
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
      {outcome ? (
        <div className="stack" role="status" data-testid="bulk-result">
          <p>
            <Copy k="bulkDone" />
          </p>
          <ul>
            {outcome.results.map((result) => (
              <li
                key={result.offerId}
                data-offer-id={result.offerId}
                data-ok={result.ok ? 'true' : 'false'}
                data-code={result.code ?? undefined}
              >
                {ads.find((ad) => ad.id === result.offerId)?.id.slice(0, 8) ?? result.offerId.slice(0, 8)} ·{' '}
                <Copy k={result.ok ? 'bulkOk' : (RESULT_LABEL[result.code ?? ''] ?? 'bulkRefused')} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
