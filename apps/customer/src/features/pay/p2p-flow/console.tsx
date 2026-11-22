import { useState, type ReactNode } from 'react';
import { Button, ChoiceGroup, Field, Select } from '@intafaced/ui/lit';
import { Checkbox, Sheet } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../../shared/api';
import { useResource } from '../../../shared/resource';
import type { PersonalPayApi } from '../pay-api';
import type { BulkOutcome, Offer, Presence, PresenceWindow } from '../schemas';
import { consoleCopy } from '../personal/p2p-console-copy';
import { Failure, State, Time } from './parts';

/**
 * The kit view of the merchant console's My offers parts (`../personal/p2p-console.tsx`, P-ads-merchant-08, J-p2p-05
 * #4): presence (online, offline or a weekly schedule in the person's own time zone) and the bulk action that pauses,
 * resumes or removes several ads, each answering for itself.
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
    <section aria-label={t('presenceTitle')} data-testid="merchant-presence">
      <h3>
        <Copy k="presenceTitle" />
      </h3>
      <State resource={presence.resource} retry={presence.reload}>
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
      </State>
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
    <div>
      <p data-testid="presence-state" data-on-board={current.onBoard ? 'true' : 'false'}>
        <Copy k={current.onBoard ? 'presenceOnBoard' : 'presenceOffBoard'} />
        {current.nextChangeAt ? (
          <>
            {' '}
            <span data-testid="presence-next">
              <Copy k={current.onBoard ? 'presenceLeavesAt' : 'presenceBackAt'} /> <Time value={current.nextChangeAt} />.
            </span>
          </>
        ) : null}
      </p>
      <ChoiceGroup
        legend={<Copy k="presenceHint" />}
        name="presence-mode"
        value={mode}
        onChange={setMode}
        options={(['online', 'offline', 'scheduled'] as const).map((value) => ({
          value,
          label: <Copy k={value === 'online' ? 'presenceOnline' : value === 'offline' ? 'presenceOffline' : 'presenceScheduled'} />,
        }))}
      />
      {mode === 'scheduled' ? (
        <div data-testid="presence-schedule">
          <Field label={t('presenceZone')} value={timezone} onChange={(event) => setTimezone(event.target.value)} />
          {windows.map((row, index) => (
            <div className="lt-actions" key={index} data-testid="presence-window">
              <Select label={t('presenceDay')} value={row.day} onChange={(event) => change(index, { day: Number(event.target.value) })}>
                {DAYS.map((day) => (
                  <option key={day} value={day}>
                    {t(dayKey(day))}
                  </option>
                ))}
              </Select>
              <Field
                label={t('presenceFrom')}
                type="time"
                value={row.start}
                onChange={(event) => change(index, { start: event.target.value })}
              />
              <Field
                label={t('presenceTo')}
                value={row.end}
                pattern="\d{2}:\d{2}"
                onChange={(event) => change(index, { end: event.target.value })}
              />
              <Button tone="quiet" disabled={windows.length === 1} onClick={() => setWindows((rows) => rows.filter((_, i) => i !== index))}>
                <Copy k="presenceRemoveWindow" />
              </Button>
            </div>
          ))}
          <Button onClick={() => setWindows((rows) => [...rows, { day: 1, start: '09:00', end: '17:00' }])}>
            <Copy k="presenceAddWindow" />
          </Button>
        </div>
      ) : null}
      {failure ? (
        failure.code === 'p2p.schedule_invalid' ? (
          <p role="alert" data-testid="failure">
            <Copy k="presenceInvalid" />
          </p>
        ) : (
          <Failure result={failure} />
        )
      ) : null}
      <div className="lt-actions">
        <Button tone="primary" disabled={busy} onClick={() => void save()}>
          <Copy k={busy ? 'presenceSaving' : 'presenceSave'} />
        </Button>
      </div>
    </div>
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
  side: (offer: Offer) => ReactNode;
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
    <section aria-label={t('bulkTitle')} data-testid="bulk-ads">
      <h3>
        <Copy k="bulkTitle" />
      </h3>
      <State resource={active.resource} retry={active.reload}>
        {() =>
          ads.length === 0 ? (
            <p className="lt-hint">
              <Copy k="bulkNone" />
            </p>
          ) : (
            <fieldset>
              <legend className="lt-hint">
                <Copy k="bulkPick" />
              </legend>
              {ads.map((ad) => (
                <div key={ad.id} data-testid="bulk-ad" data-offer-id={ad.id}>
                  <Checkbox
                    label={
                      <>
                        {side(ad)} · {ad.status}
                      </>
                    }
                    checked={picked.includes(ad.id)}
                    onChange={(event) => setPicked((ids) => (event.target.checked ? [...ids, ad.id] : ids.filter((id) => id !== ad.id)))}
                  />
                </div>
              ))}
            </fieldset>
          )
        }
      </State>
      {picked.length > MAX_BULK ? (
        <p className="lt-hint" data-testid="bulk-too-many">
          {t('bulkTooMany', { max: String(MAX_BULK) })}
        </p>
      ) : null}
      <div className="lt-actions">
        {(['pause', 'resume', 'remove'] as const).map((action) => (
          <Button
            key={action}
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
        <Sheet open title={t('bulkConfirmTitle')} dismissible={!busy} onClose={() => (busy ? undefined : setAsking(null))}>
          <div data-testid="bulk-confirm">
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
            {failure ? <Failure result={failure} /> : null}
            <div className="lt-actions">
              <Button tone="quiet" disabled={busy} onClick={() => setAsking(null)}>
                <Copy k="bulkCancel" />
              </Button>
              <Button tone="primary" disabled={busy} onClick={() => void run()}>
                <Copy k={busy ? 'bulkWorking' : 'bulkGo'} />
              </Button>
            </div>
          </div>
        </Sheet>
      ) : null}
      {outcome ? (
        <div role="status" data-testid="bulk-result">
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
