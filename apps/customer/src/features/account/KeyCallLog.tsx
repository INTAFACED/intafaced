import { useId, useMemo, useState, type FormEvent } from 'react';
import { apiKeyCallsOutputSchema, type ApiKeyCallsInput, type ApiKeyCallsOutput } from '@intafaced/contracts/api-keys';
import type { ApiClient, ApiResult } from '../../shared/api';
import { defineCopy } from '../../shared/i18n';
import { useResource } from '../../shared/resource';
import { Button, Failure, Field, Loading } from '../../shared/ui';
import { useSession } from '../session/session';

const copy = defineCopy('api-key-call-log', {
  title: 'Call log',
  lead: 'Each call this key made, as the server answered it. A body or a header value is never kept, and neither is the key.',
  colAt: 'Time',
  colCall: 'Call',
  colStatus: 'Status',
  colRequest: 'Request id',
  outside: 'Outside the IP list',
  status: 'Status',
  statusAll: 'All statuses',
  from: 'From',
  to: 'To',
  dayHint: 'A day in UTC.',
  refresh: 'Refresh',
  empty: 'No calls match.',
  asOf: 'As of {at}',
  loading: 'Reading the call log…',
});

/** The most rows one read shows. */
export const CALL_LOG_LIMIT = 100;

/** The statuses the filter offers: the ones the edge and the services answer a key's call with. */
export const CALL_LOG_STATUSES = [200, 201, 204, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503] as const;

type Filter = Pick<ApiKeyCallsInput, 'status' | 'from' | 'to'>;

export const readKeyCalls = (api: ApiClient, keyId: string, filter: Filter, signal: AbortSignal): Promise<ApiResult<ApiKeyCallsOutput>> =>
  api.query('identity', 'developerKeys.calls', { keyId, limit: CALL_LOG_LIMIT, ...filter }, apiKeyCallsOutputSchema, { signal });

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The form's filter: a blank or unreadable field narrows nothing. */
export function filterFromForm(form: HTMLFormElement): Filter {
  const data = new FormData(form);
  const status = Number(data.get('status'));
  const from = String(data.get('from') ?? '');
  const to = String(data.get('to') ?? '');
  return {
    ...(Number.isInteger(status) && status >= 100 ? { status } : {}),
    ...(DAY.test(from) ? { from } : {}),
    ...(DAY.test(to) ? { to } : {}),
  };
}

/**
 * The key detail's call log (DV-keys-06, J-developer-08 #1 to #3): one row per call with its status and request id, the
 * call from outside the key's IP list flagged, never a body or a header value. Status and date narrow it on Refresh,
 * which reads again and moves the as-of time.
 */
export function KeyCallLog({ keyId }: { keyId: string }) {
  const { t, requestedLocale } = copy.useCopy();
  const { api, userId } = useSession();
  const [filter, setFilter] = useState<{ value: Filter; round: number }>({ value: {}, round: 0 });
  const { resource, reload } = useResource(
    (signal) => readKeyCalls(api, keyId, filter.value, signal),
    `key-calls:${userId}:${keyId}:${JSON.stringify(filter.value)}:${filter.round}`,
  );
  const when = useMemo(
    () => new Intl.DateTimeFormat(requestedLocale, { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' }),
    [requestedLocale],
  );
  const at = (iso: string) => `${when.format(new Date(iso))} UTC`;
  const log = resource.status === 'ready' ? resource.data : null;
  const statusId = useId();

  return (
    <section data-testid="security__card" className="api-keys__detail security__card" aria-labelledby="api-key-call-log">
      <h2 id="api-key-call-log">{t('title')}</h2>
      <p className="muted">{t('lead')}</p>
      <form
        className="api-keys__form"
        noValidate
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          // Read now: React clears the event's target before a state updater runs.
          const value = filterFromForm(event.currentTarget);
          setFilter((prev) => ({ value, round: prev.round + 1 }));
        }}
      >
        <label className="field" htmlFor={statusId}>
          <span id={`${statusId}-label`}>{t('status')}</span>
          <select id={statusId} name="status" defaultValue="" aria-labelledby={`${statusId}-label`}>
            <option value="">{t('statusAll')}</option>
            {CALL_LOG_STATUSES.map((status) => (
              <option key={status} value={String(status)}>
                {status}
              </option>
            ))}
          </select>
        </label>
        <Field label={t('from')} hint={t('dayHint')} name="from" type="date" />
        <Field label={t('to')} hint={t('dayHint')} name="to" type="date" />
        <div className="api-keys__actions">
          <Button type="submit" variant="secondary" disabled={resource.status === 'loading'}>
            {t('refresh')}
          </Button>
        </div>
      </form>
      {resource.status === 'loading' && <Loading label={t('loading')} />}
      {resource.status === 'failed' && <Failure result={resource.failure} retry={reload} />}
      {log && (
        <>
          <div className="api-keys__table-wrap">
            <table className="api-keys__table" aria-labelledby="api-key-call-log">
              <thead>
                <tr>
                  <th scope="col">{t('colAt')}</th>
                  <th scope="col">{t('colCall')}</th>
                  <th scope="col">{t('colStatus')}</th>
                  <th scope="col">{t('colRequest')}</th>
                </tr>
              </thead>
              <tbody>
                {log.calls.map((call) => (
                  <tr key={call.requestId} data-request-id={call.requestId} data-status={String(call.status)}>
                    <td>
                      <time dateTime={call.at}>{at(call.at)}</time>
                    </td>
                    <td>
                      <code lang="und">
                        {call.method} {call.path}
                      </code>
                      {call.outsideIpList && <small className="api-keys__note error-text">{t('outside')}</small>}
                    </td>
                    <td>{call.status}</td>
                    <td>
                      <code lang="und">{call.requestId}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {log.calls.length === 0 && <p className="muted">{t('empty')}</p>}
          <p data-testid="api-keys__calls-as-of">
            <time dateTime={log.asOf}>{t('asOf', { at: at(log.asOf) })}</time>
          </p>
        </>
      )}
    </section>
  );
}
