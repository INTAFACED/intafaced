import { useMemo, useRef, useState, type FormEvent } from 'react';
import type { ApiKeyRecord } from '@intafaced/contracts/api-keys';
import type { LimitRequest, RateTiersOutput } from '@intafaced/contracts/api-rate-limits';
import type { ApiResult } from '../../../shared/api';
import { Button, Failure, Field } from '../../../shared/ui';
import { useSession } from '../../session/session';
import { readDeveloperKeys } from '../../account/developer-keys-api';
import { docsCopy } from '../developers-docs-copy';
import { useRead } from '../use-read';
import { rateLimitsCopy, type RateLimitsCopyKey } from './rate-limits-copy';
import {
  limitFormRefusal,
  newSubmissionId,
  readMyLimitRequests,
  readRateCosts,
  readRateTiers,
  sendLimitRequest,
  type LimitFormRefusal,
} from './rate-limits-api';

const perSecond = (perMinute: number) => {
  const value = perMinute / 60;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
};

const liveKey = (key: ApiKeyRecord, now: number) =>
  !key.revoked && (key.expiresAt === null || Date.parse(key.expiresAt) > now) && key.mode === 'live';

/**
 * /developers/rate-limits (DV-limits-01 to 03, J-developer-06 #1 #4 #5): the owner's tiers and the per-route costs as
 * the services enforce them (a banner while unset, never an invented number), what a 429 says, the backoff guidance,
 * and, signed in, the form to ask for a higher limit and the person's own requests with each answer.
 */
export function RateLimitsPage({ title }: { title: string }) {
  const { t } = rateLimitsCopy.useCopy();
  const docs = docsCopy.useCopy();
  const { api, userId } = useSession();
  const tiers = useRead((signal) => readRateTiers(api, signal), [api]);
  const costs = useRead((signal) => readRateCosts(api, signal), [api]);
  const tiersSet = tiers.read.status === 'ready' && tiers.read.data.tiers.length > 0;

  return (
    <div className="pub-page" data-testid="developers-rate-limits">
      <header className="pub-heading">
        <h1>{title}</h1>
        <p className="muted">{t('lead')}</p>
      </header>

      {tiers.read.status === 'ready' && !tiersSet && (
        <section className="pub-notice" role="status" data-testid="rate-limits__unset">
          <p>{t('tiersUnset')}</p>
        </section>
      )}

      <section className="pub-card" aria-labelledby="rl-model">
        <h2 id="rl-model">{t('modelTitle')}</h2>
        <p>{t('modelBucket')}</p>
        <p>{t('modelCost')}</p>
        <p className="muted">{t('modelReplica')}</p>
      </section>

      <section className="pub-card" aria-labelledby="rl-tiers">
        <h2 id="rl-tiers">{t('tiersTitle')}</h2>
        {tiers.read.status === 'loading' && <p className="muted">{t('loading')}</p>}
        {tiers.read.status === 'failed' && (
          <p className="error-text" role="alert">
            {t('tiersFailed')}{' '}
            <button type="button" className="text-link" onClick={tiers.reload}>
              {t('refresh')}
            </button>
          </p>
        )}
        {tiers.read.status === 'ready' && <TiersTable data={tiers.read.data} />}
      </section>

      <section className="pub-card" aria-labelledby="rl-costs">
        <h2 id="rl-costs">{t('costsTitle')}</h2>
        <p className="muted">{t('costsLead')}</p>
        {costs.read.status === 'loading' && <p className="muted">{t('loading')}</p>}
        {costs.read.status === 'failed' && (
          <p className="error-text" role="alert">
            {t('costsFailed')}{' '}
            <button type="button" className="text-link" onClick={costs.reload}>
              {t('refresh')}
            </button>
          </p>
        )}
        {costs.read.status === 'ready' && costs.read.data.costs.length === 0 && (
          <p className="pub-notice" role="status">
            {t('costsUnset')}
          </p>
        )}
        <div className="table-scroll">
          <table className="pub-table">
            <thead>
              <tr>
                <th scope="col">{t('colRoute')}</th>
                <th scope="col">{t('colCost')}</th>
              </tr>
            </thead>
            <tbody>
              {costs.read.status === 'ready' &&
                costs.read.data.costs.map((row) => (
                  <tr key={row.route} data-route={row.route}>
                    <th scope="row">
                      <code>{row.route}</code>
                    </th>
                    <td>{row.cost}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="pub-card" aria-labelledby="rl-refusal">
        <h2 id="rl-refusal">{t('refusalTitle')}</h2>
        <p>{t('refusalBody')}</p>
        <p>{t('refusalHeaders')}</p>
      </section>

      <section className="pub-card" aria-labelledby="rl-backoff" data-testid="rate-limits__backoff">
        <h2 id="rl-backoff">{t('backoffTitle')}</h2>
        <p>{t('backoffBody')}</p>
        <p className="muted">{t('backoffExample')}</p>
      </section>

      {userId ? (
        <LimitRequests tiers={tiers.read.status === 'ready' ? tiers.read.data : null} tiersSet={tiersSet} />
      ) : (
        <section className="pub-card" aria-labelledby="rl-form">
          <h2 id="rl-form">{t('formTitle')}</h2>
          <p>
            <a className="text-link" href="/login?next=%2Fdevelopers%2Frate-limits">
              {t('formSignIn')}
            </a>
          </p>
        </section>
      )}

      <a className="text-link" href="/developers">
        ← {docs.t('back')}
      </a>
    </div>
  );
}

function TiersTable({ data }: { data: RateTiersOutput }) {
  const { t } = rateLimitsCopy.useCopy();
  return (
    <>
      <div className="table-scroll">
        <table className="pub-table">
          <thead>
            <tr>
              <th scope="col">{t('colTier')}</th>
              <th scope="col">{t('colBurst')}</th>
              <th scope="col">{t('colRefillMinute')}</th>
              <th scope="col">{t('colRefillSecond')}</th>
            </tr>
          </thead>
          <tbody>
            {data.tiers.map((tier) => (
              <tr key={tier.id} data-tier={tier.id}>
                <th scope="row">{t(`tier_${tier.id}`)}</th>
                <td>{tier.burst}</td>
                <td>{tier.refillPerMinute}</td>
                <td>{perSecond(tier.refillPerMinute)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.tiers.length > 0 && (
        <p className="muted">
          {data.grantCeilingPerMinute === null ? t('ceilingUnset') : t('ceiling', { count: data.grantCeilingPerMinute })}
        </p>
      )}
    </>
  );
}

const STATUS_KEY: Record<
  LimitRequest['status'],
  Extract<RateLimitsCopyKey, 'status_waiting' | 'status_granted' | 'status_granted_in_part' | 'status_refused'>
> = {
  waiting: 'status_waiting',
  granted: 'status_granted',
  granted_in_part: 'status_granted_in_part',
  refused: 'status_refused',
};

function LimitRequests({ tiers, tiersSet }: { tiers: RateTiersOutput | null; tiersSet: boolean }) {
  const { t, requestedLocale } = rateLimitsCopy.useCopy();
  const { api, userId } = useSession();
  const keys = useRead((signal) => readDeveloperKeys(api, signal), [api, userId]);
  const mine = useRead((signal) => readMyLimitRequests(api, signal), [api, userId]);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<LimitFormRefusal | 'invalidAsked' | null>(null);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const [sent, setSent] = useState(false);
  const submission = useRef<{ fields: string; id: string } | null>(null);
  const when = useMemo(
    () => new Intl.DateTimeFormat(requestedLocale, { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' }),
    [requestedLocale],
  );
  const now = Date.now();
  const live = keys.read.status === 'ready' ? keys.read.data.keys.filter((key) => liveKey(key, now)) : [];
  const formOpen = tiersSet && live.length > 0;

  async function send(form: HTMLFormElement) {
    if (busy) return;
    const data = new FormData(form);
    const asked = Number(String(data.get('asked') ?? '').trim());
    setSent(false);
    setFailure(null);
    if (!Number.isInteger(asked) || asked <= 0) return setRefusal('invalidAsked');
    const starts = String(data.get('spikeStarts') ?? '') || null;
    const ends = String(data.get('spikeEnds') ?? '') || null;
    const fields = JSON.stringify([data.get('keyId'), asked, starts, ends, data.get('note')]);
    // The same fields sent again (a retry after a lost reply) reuse the id, so the service records one request.
    if (submission.current?.fields !== fields) submission.current = { fields, id: newSubmissionId() };
    setBusy(true);
    setRefusal(null);
    try {
      const answer = await sendLimitRequest(api, {
        keyId: String(data.get('keyId') ?? ''),
        askedPerMinute: asked,
        spikeStartsOn: starts,
        spikeEndsOn: ends,
        note: String(data.get('note') ?? ''),
        requestId: submission.current.id,
      });
      if (answer.ok) {
        setSent(true);
        submission.current = null;
        form.reset();
        mine.reload();
        return;
      }
      const named = limitFormRefusal(answer);
      if (named) setRefusal(named);
      else setFailure(answer);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form
        className="pub-card"
        aria-label={t('formTitle')}
        noValidate
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          void send(event.currentTarget);
        }}
      >
        <h2>{t('formTitle')}</h2>
        <p className="muted">{t('formLead')}</p>
        {tiers && !tiersSet && (
          <p className="pub-notice" role="status">
            {t('formUnset')}
          </p>
        )}
        {tiersSet && keys.read.status === 'ready' && live.length === 0 && <p className="muted">{t('formNoKeys')}</p>}
        {keys.read.status === 'failed' && <p className="error-text">{t('requestsFailed')}</p>}
        <label className="field">
          <span>{t('fieldKey')}</span>
          <select name="keyId" disabled={!formOpen || busy} required>
            {live.map((key) => (
              <option key={key.id} value={key.id}>
                {key.name}
              </option>
            ))}
          </select>
        </label>
        <Field label={t('fieldAsked')} hint={t('fieldAskedHint')} name="asked" inputMode="numeric" disabled={!formOpen || busy} />
        <Field label={t('fieldSpikeStarts')} hint={t('fieldSpikeHint')} name="spikeStarts" type="date" disabled={!formOpen || busy} />
        <Field label={t('fieldSpikeEnds')} name="spikeEnds" type="date" disabled={!formOpen || busy} />
        <Field label={t('fieldNote')} name="note" maxLength={500} disabled={!formOpen || busy} />
        {refusal && (
          <p className="error-text" role="alert">
            {t(refusal === 'invalidAsked' ? 'invalidAsked' : `refused.${refusal}`)}
          </p>
        )}
        {failure && <Failure result={failure} />}
        {sent && <p role="status">{t('sent')}</p>}
        <Button type="submit" disabled={!formOpen || busy}>
          {busy ? t('sending') : t('send')}
        </Button>
      </form>

      <section className="pub-card" aria-labelledby="rl-requests">
        <h2 id="rl-requests">{t('requestsTitle')}</h2>
        {mine.read.status === 'loading' && <p className="muted">{t('loading')}</p>}
        {mine.read.status === 'failed' && (
          <p className="error-text" role="alert">
            {t('requestsFailed')}{' '}
            <button type="button" className="text-link" onClick={mine.reload}>
              {t('refresh')}
            </button>
          </p>
        )}
        {mine.read.status === 'ready' && (
          <>
            <p className="muted">
              {t('asOf', { at: `${when.format(new Date(mine.read.data.asOf))} UTC` })}{' '}
              <button type="button" className="text-link" onClick={mine.reload}>
                {t('refresh')}
              </button>
            </p>
            {mine.read.data.requests.length === 0 && <p className="muted">{t('requestsEmpty')}</p>}
          </>
        )}
        <div className="table-scroll">
          <table className="pub-table">
            <thead>
              <tr>
                <th scope="col">{t('colKey')}</th>
                <th scope="col">{t('colAsked')}</th>
                <th scope="col">{t('colHad')}</th>
                <th scope="col">{t('colSpike')}</th>
                <th scope="col">{t('colStatus')}</th>
                <th scope="col">{t('colAnswer')}</th>
              </tr>
            </thead>
            <tbody>
              {mine.read.status === 'ready' &&
                mine.read.data.requests.map((request) => (
                  <tr key={request.id} data-request={request.id} data-status={request.status}>
                    <th scope="row">
                      <bdi lang="und">{request.keyName}</bdi>
                    </th>
                    <td>{request.askedPerMinute}</td>
                    <td>{request.currentPerMinute}</td>
                    <td>
                      {request.spikeStartsOn && request.spikeEndsOn
                        ? t('spikeRange', { from: request.spikeStartsOn, to: request.spikeEndsOn })
                        : t('spikeNone')}
                    </td>
                    <td>{t(STATUS_KEY[request.status])}</td>
                    <td>
                      {request.grantedPerMinute === null ? t('answerNone') : t('answerGranted', { count: request.grantedPerMinute })}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
