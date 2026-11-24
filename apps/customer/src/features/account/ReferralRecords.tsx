import { useState, type ReactNode } from 'react';
import { z } from 'zod';
import { referralAccrualsSchema, referralEdgeSchema, referralLapseSchema } from '@intafaced/contracts/identity-account-room';
import { useResource, type Resource } from '../../shared/resource';
import { displayAmount, formatAmount, parseAmount } from '../../shared/money';
import { usePreferences } from '../../shared/preferences';
import { shortReference } from '../../shared/reference';
import { Button } from '@intafaced/ui/lit';
import { Empty, Failure, Loading } from './kit-parts';
import { useSession } from '../session';
import { referralCopy as copy } from './referral-copy';
import { callAs } from '../../shared/api';
import {
  IDENTITY_AFFILIATES_MY_REFERRER,
  IDENTITY_AFFILIATES_MY_LAPSE,
  IDENTITY_AFFILIATES_MY_ANCESTORS,
  IDENTITY_AFFILIATES_MY_ACCRUALS,
} from '@intafaced/contracts/identity-affiliates-procedures';

const lapseSchema = referralLapseSchema;
type Selection = { feeEventId: string; hop: number };
const recordKey = (row: Selection) => JSON.stringify([row.feeEventId, row.hop]);
type DetailKey =
  | 'event'
  | 'hop'
  | 'commission'
  | 'fee'
  | 'rate'
  | 'payer'
  | 'beneficiary'
  | 'asset'
  | 'accrued'
  | 'source'
  | 'referrer'
  | 'attributed'
  | 'lastActivity'
  | 'endsAt'
  | 'endedAt';

function Read<T>({ resource, retry, children }: { resource: Resource<T>; retry: () => void; children: (data: T) => ReactNode }) {
  return resource.status === 'loading' ? (
    <Loading />
  ) : resource.status === 'failed' ? (
    <Failure result={resource.failure} retry={retry} />
  ) : (
    children(resource.data)
  );
}

/** A new actor remounts all private resources, the window and its selection. */
export function ReferralRecords() {
  const { userId } = useSession();
  return userId ? <OwnerRecords key={userId} userId={userId} /> : null;
}

function OwnerRecords({ userId }: { userId: string }) {
  const { api } = useSession();
  const { hideBalances, timeZone } = usePreferences();
  const { Copy, t, requestedLocale, languageFor } = copy.useCopy();
  const [limit, setLimit] = useState(50);
  const [cycle, setCycle] = useState(0);
  const [chainOpen, setChainOpen] = useState(false);
  const [selected, setSelected] = useState<Selection | null>(null);
  const edge = useResource(
    (signal) =>
      callAs(
        api,
        IDENTITY_AFFILIATES_MY_REFERRER,
        undefined,
        referralEdgeSchema.refine(
          (row) => !row || (row.userId === userId && row.referrerId !== userId),
          'Referral attribution ownership is invalid',
        ),
        { signal },
      ),
    `referral-edge:${userId}:${cycle}`,
  );
  const lapse = useResource(
    (signal) =>
      callAs(
        api,
        IDENTITY_AFFILIATES_MY_LAPSE,
        undefined,
        lapseSchema.refine((row) => !row.ended || row.ended.userId === userId, 'Referral lapse ownership is invalid'),
        { signal },
      ),
    `referral-lapse:${userId}:${cycle}`,
  );
  const chain = useResource(
    (signal) =>
      callAs(
        api,
        IDENTITY_AFFILIATES_MY_ANCESTORS,
        undefined,
        z
          .array(z.string().guid())
          .refine((rows) => !rows.includes(userId) && new Set(rows).size === rows.length, 'Referral chain contains a cycle'),
        { signal },
      ),
    `referral-chain:${userId}:${cycle}`,
  );
  const records = useResource(
    (signal) =>
      callAs(
        api,
        IDENTITY_AFFILIATES_MY_ACCRUALS,
        { limit },
        referralAccrualsSchema(limit).refine(
          (data) => data.rows.every((row) => row.beneficiaryId === userId) && new Set(data.rows.map(recordKey)).size === data.rows.length,
          'Accrual ownership or record IDs are invalid',
        ),
        { signal },
      ),
    `referral-accruals:${userId}:${limit}:${cycle}`,
  );
  const current =
    selected && records.resource.status === 'ready'
      ? records.resource.data.rows.find((row) => recordKey(row) === recordKey(selected))
      : undefined;
  function timestamp(value: string) {
    return new Intl.DateTimeFormat(requestedLocale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      ...(timeZone === 'device' ? {} : { timeZone: timeZone === 'UTC+8' ? 'Asia/Makassar' : 'UTC' }),
    }).format(new Date(value));
  }
  const timeZoneLabel = timeZone === 'device' ? Intl.DateTimeFormat().resolvedOptions().timeZone : timeZone;
  /** A period in the largest whole unit it fills: 3600 reads "1 hour", 90 reads "90 seconds". */
  function period(seconds: number) {
    const units = [
      ['day', 86_400],
      ['hour', 3_600],
      ['minute', 60],
    ] as const;
    const [unit, size] = units.find(([, size]) => seconds % size === 0) ?? ['second', 1];
    return new Intl.NumberFormat(requestedLocale, { style: 'unit', unit, unitDisplay: 'long' }).format(seconds / size);
  }
  function instant(value: string) {
    return (
      <time dateTime={value}>
        {timestamp(value)} · {timeZoneLabel}
      </time>
    );
  }
  function quantity(value: string) {
    return hideBalances ? <span aria-label={t('amountHidden')}>••••</span> : displayAmount(value);
  }
  function detail(label: DetailKey, value: ReactNode) {
    return (
      <div>
        <dt>
          <Copy k={label} />
        </dt>
        <dd>{value}</dd>
      </div>
    );
  }
  return (
    <section className="lt-stack" aria-label={t('title')} lang={languageFor('title')}>
      <header className="lt-title-row">
        <h2>
          <Copy k="title" />
        </h2>
        <Button tone="quiet" onClick={() => setCycle((value) => value + 1)}>
          <Copy k="refresh" />
        </Button>
      </header>
      <details className="lt-hint">
        <summary>
          <Copy k="disclosure" />
        </summary>
        <Copy k="owner" />: <span>{userId}</span>
      </details>
      <section className="lt-stack" aria-label={t('referrer')}>
        <h3>
          <Copy k="referrer" />
        </h3>
        <Read resource={edge.resource} retry={edge.reload}>
          {(row) =>
            row ? (
              <div className="lt-lines">
                <p title={row.referrerId}>
                  <Copy k="member" params={{ ref: shortReference(row.referrerId) }} />
                </p>
                <p className="lt-hint">
                  <Copy k="attributed" />:{' '}
                  <time dateTime={row.attributedAt}>
                    {timestamp(row.attributedAt)} · {timeZoneLabel}
                  </time>
                </p>
              </div>
            ) : (
              <Empty title={<Copy k="noReferrer" />}>
                <Copy k="noReferrerBody" />
              </Empty>
            )
          }
        </Read>
      </section>
      <section className="lt-stack" aria-label={t('term')}>
        <h3>
          <Copy k="term" />
        </h3>
        <Read resource={lapse.resource} retry={lapse.reload}>
          {(row) => (
            <>
              {row.state === 'none' && (
                <p className="lt-hint">
                  <Copy k="termNone" />
                </p>
              )}
              {row.state === 'unset' && (
                <p className="lt-hint">
                  <Copy k="termUnset" />
                </p>
              )}
              {row.state === 'active' && row.periodSeconds && row.lastActivityAt && row.endsAt && (
                <>
                  <dl className="lt-kv">
                    {detail('lastActivity', instant(row.lastActivityAt))}
                    {detail('endsAt', instant(row.endsAt))}
                  </dl>
                  <p className="lt-hint">
                    <Copy k="termRule" params={{ period: period(row.periodSeconds) }} />
                  </p>
                </>
              )}
              {row.ended && (
                <section className="lt-stack" aria-label={t('ended')}>
                  <h4>
                    <Copy k="ended" />
                  </h4>
                  <dl className="lt-kv">
                    {detail(
                      'referrer',
                      <span title={row.ended.referrerId}>{t('member', { ref: shortReference(row.ended.referrerId) })}</span>,
                    )}
                    {detail('attributed', instant(row.ended.attributedAt))}
                    {detail('lastActivity', instant(row.ended.lastActivityAt))}
                    {detail('endedAt', instant(row.ended.lapsedAt))}
                  </dl>
                  <p className="lt-hint">
                    <Copy k="endedMeaning" params={{ period: period(row.ended.periodSeconds) }} />
                  </p>
                </section>
              )}
            </>
          )}
        </Read>
      </section>
      <section className="lt-stack" aria-label={t('chain')}>
        <Read resource={chain.resource} retry={chain.reload}>
          {(rows) =>
            rows.length ? (
              <>
                <Button tone="quiet" aria-expanded={chainOpen} onClick={() => setChainOpen(!chainOpen)}>
                  <Copy k={chainOpen ? 'hideChain' : 'showChain'} params={{ count: String(rows.length) }} />
                </Button>
                {chainOpen && (
                  <>
                    <ol data-testid="referral-chain" className="lt-rows">
                      {rows.map((id) => (
                        <li key={id} title={id}>
                          <Copy k="member" params={{ ref: shortReference(id) }} />
                        </li>
                      ))}
                    </ol>
                    <p className="lt-hint">
                      <Copy k="chainMeaning" />
                    </p>
                  </>
                )}
              </>
            ) : (
              <Empty title={<Copy k="noChain" />}>
                <Copy k="noChainBody" />
              </Empty>
            )
          }
        </Read>
      </section>
      <section className="lt-stack" aria-label={t('accruals')}>
        <h3>
          <Copy k="accruals" />
        </h3>
        <p className="lt-hint">
          <Copy k="meaning" />
        </p>
        <Read resource={records.resource} retry={records.reload}>
          {({ rows }) => (
            <>
              {rows.length ? (
                <div className="lt-rows">
                  {rows.map((row) => (
                    <article className="lt-lines" key={recordKey(row)} aria-label={`${row.feeEventId} · ${row.hop}`}>
                      <p className="lt-figure">
                        {quantity(row.commissionAmount)} <span>{row.asset}</span>
                      </p>
                      <p className="lt-hint">
                        <time dateTime={row.accruedAt}>
                          {timestamp(row.accruedAt)} · {timeZoneLabel}
                        </time>{' '}
                        · {row.sourceModule}
                      </p>
                      <Button
                        tone="quiet"

                        aria-pressed={Boolean(selected && recordKey(selected) === recordKey(row))}
                        onClick={() => setSelected({ feeEventId: row.feeEventId, hop: row.hop })}
                      >
                        <Copy k="inspect" />
                      </Button>
                    </article>
                  ))}
                </div>
              ) : (
                <Empty title={<Copy k="noAccruals" />}>
                  <Copy k="noAccrualsBody" />
                </Empty>
              )}
              <p className="lt-hint">
                <Copy k="window" params={{ count: String(rows.length), limit: String(limit) }} />
              </p>
              <div className="lt-actions">
                {rows.length === limit && limit < 500 && (
                  <Button tone="secondary" onClick={() => setLimit(Math.min(limit * 2, 500))}>
                    <Copy k="expand" params={{ limit: String(Math.min(limit * 2, 500)) }} />
                  </Button>
                )}
                {limit > 50 && (
                  <Button tone="quiet" onClick={() => setLimit(50)}>
                    <Copy k="latest" />
                  </Button>
                )}
              </div>
            </>
          )}
        </Read>
      </section>
      {selected && (
        <section className="lt-stack" aria-label={t('selected')}>
          <h3>
            <Copy k="selected" />
          </h3>
          <dl className="lt-kv">
            {detail('event', selected.feeEventId)}
            {detail('hop', String(selected.hop))}
          </dl>
          {current ? (
            <section className="lt-stack" aria-label={t('details')}>
              <h4>
                <Copy k="details" />
              </h4>
              <dl className="lt-kv">
                {detail(
                  'commission',
                  <>
                    {quantity(current.commissionAmount)} {current.asset}
                  </>,
                )}
                {detail(
                  'fee',
                  <>
                    {quantity(current.feeAmount)} {current.asset}
                  </>,
                )}
                {detail('rate', `${formatAmount(parseAmount(current.rate) * 100n)}%`)}
                {detail('payer', current.payerId)}
                {detail('beneficiary', current.beneficiaryId)}
                {detail('asset', current.asset)}
                {detail(
                  'accrued',
                  <time dateTime={current.accruedAt}>
                    {timestamp(current.accruedAt)} · {timeZoneLabel}
                  </time>,
                )}
                {detail('source', current.sourceModule)}
              </dl>
              <p className="lt-hint">
                <Copy k="hopMeaning" />
              </p>
              {hideBalances && (
                <p className="lt-hint">
                  <Copy k="hidden" />
                </p>
              )}
            </section>
          ) : (
            <p className="lt-hint">
              <Copy k="missing" />
            </p>
          )}
          <Button tone="quiet" onClick={() => setSelected(null)}>
            <Copy k="hideInspection" />
          </Button>
        </section>
      )}
    </section>
  );
}
