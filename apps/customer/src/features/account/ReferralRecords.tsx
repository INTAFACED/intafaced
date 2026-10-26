import { useState, type ReactNode } from 'react';
import { z } from 'zod';
import { useResource, type Resource } from '../../shared/resource';
import { decimalSchema, displayAmount, formatAmount, parseAmount } from '../../shared/money';
import { usePreferences } from '../../shared/preferences';
import { shortReference } from '../../shared/reference';
import { Button, EmptyState, Failure, Loading } from '../../shared/ui';
import { useSession } from '../session/session';
import { referralCopy as copy } from './referral-copy';
import './referrals.css';

const date = z.string().datetime({ offset: true });
const nonblank = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, 'Expected a published identifier');
// svc-identity stores exact unsigned decimals with at most 18 fractional places.
const amount = decimalSchema.and(z.string().regex(/^(0|[1-9]\d*)(\.\d{1,18})?$/));
const accrual = z.object({
  feeEventId: nonblank,
  beneficiaryId: z.string().guid(),
  payerId: z.string().guid(),
  hop: z.number().int().nonnegative(),
  rate: amount.refine((value) => parseAmount(value) <= parseAmount('1'), 'Rate exceeds one'),
  feeAmount: amount,
  commissionAmount: amount,
  asset: nonblank,
  accruedAt: date,
  sourceModule: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
});
const ended = z.object({
  userId: z.string().uuid(),
  referrerId: z.string().uuid(),
  attributedAt: date,
  lastActivityAt: date,
  periodSeconds: z.number().int().positive(),
  lapsedAt: date,
});
const lapseSchema = z.object({
  state: z.enum(['unset', 'none', 'active']),
  periodSeconds: z.number().int().positive().nullable(),
  lastActivityAt: date.nullable(),
  endsAt: date.nullable(),
  ended: ended.nullable(),
});
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
      api.query(
        'identity',
        'affiliates.myReferrer',
        undefined,
        z
          .object({ userId: z.string().guid(), referrerId: z.string().guid(), attributedAt: date })
          .nullable()
          .refine((row) => !row || (row.userId === userId && row.referrerId !== userId), 'Referral attribution ownership is invalid'),
        { signal },
      ),
    `referral-edge:${userId}:${cycle}`,
  );
  const lapse = useResource(
    (signal) =>
      api.query(
        'identity',
        'affiliates.myLapse',
        undefined,
        lapseSchema.refine((row) => !row.ended || row.ended.userId === userId, 'Referral lapse ownership is invalid'),
        { signal },
      ),
    `referral-lapse:${userId}:${cycle}`,
  );
  const chain = useResource(
    (signal) =>
      api.query(
        'identity',
        'affiliates.myAncestors',
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
      api.query(
        'identity',
        'affiliates.myAccruals',
        { limit },
        z
          .object({ rows: z.array(accrual).max(limit) })
          .refine(
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
    <section className="referral-records" aria-label={t('title')} lang={languageFor('title')}>
      <header className="referral-heading">
        <h2>
          <Copy k="title" />
        </h2>
        <Button variant="ghost" onClick={() => setCycle((value) => value + 1)}>
          <Copy k="refresh" />
        </Button>
      </header>
      <details className="referral-caption">
        <summary>
          <Copy k="disclosure" />
        </summary>
        <Copy k="owner" />: <span>{userId}</span>
      </details>
      <section className="referral-block" aria-label={t('referrer')}>
        <h3>
          <Copy k="referrer" />
        </h3>
        <Read resource={edge.resource} retry={edge.reload}>
          {(row) =>
            row ? (
              <div className="referral-relationship">
                <p title={row.referrerId}>
                  <Copy k="member" params={{ ref: shortReference(row.referrerId) }} />
                </p>
                <p className="referral-caption">
                  <Copy k="attributed" />:{' '}
                  <time dateTime={row.attributedAt}>
                    {timestamp(row.attributedAt)} · {timeZoneLabel}
                  </time>
                </p>
              </div>
            ) : (
              <EmptyState title={<Copy k="noReferrer" />}>
                <Copy k="noReferrerBody" />
              </EmptyState>
            )
          }
        </Read>
      </section>
      <section className="referral-block" aria-label={t('term')}>
        <h3>
          <Copy k="term" />
        </h3>
        <Read resource={lapse.resource} retry={lapse.reload}>
          {(row) => (
            <>
              {row.state === 'none' && (
                <p className="referral-caption">
                  <Copy k="termNone" />
                </p>
              )}
              {row.state === 'unset' && (
                <p className="referral-caption">
                  <Copy k="termUnset" />
                </p>
              )}
              {row.state === 'active' && row.periodSeconds && row.lastActivityAt && row.endsAt && (
                <>
                  <dl className="referral-details">
                    {detail('lastActivity', instant(row.lastActivityAt))}
                    {detail('endsAt', instant(row.endsAt))}
                  </dl>
                  <p className="referral-caption">
                    <Copy k="termRule" params={{ period: period(row.periodSeconds) }} />
                  </p>
                </>
              )}
              {row.ended && (
                <section className="referral-block" aria-label={t('ended')}>
                  <h4>
                    <Copy k="ended" />
                  </h4>
                  <dl className="referral-details">
                    {detail(
                      'referrer',
                      <span title={row.ended.referrerId}>{t('member', { ref: shortReference(row.ended.referrerId) })}</span>,
                    )}
                    {detail('attributed', instant(row.ended.attributedAt))}
                    {detail('lastActivity', instant(row.ended.lastActivityAt))}
                    {detail('endedAt', instant(row.ended.lapsedAt))}
                  </dl>
                  <p className="referral-caption">
                    <Copy k="endedMeaning" params={{ period: period(row.ended.periodSeconds) }} />
                  </p>
                </section>
              )}
            </>
          )}
        </Read>
      </section>
      <section className="referral-block" aria-label={t('chain')}>
        <Read resource={chain.resource} retry={chain.reload}>
          {(rows) =>
            rows.length ? (
              <>
                <Button variant="ghost" className="referral-link" aria-expanded={chainOpen} onClick={() => setChainOpen(!chainOpen)}>
                  <Copy k={chainOpen ? 'hideChain' : 'showChain'} params={{ count: String(rows.length) }} />
                </Button>
                {chainOpen && (
                  <>
                    <ol data-testid="referral-chain" className="referral-chain">
                      {rows.map((id) => (
                        <li key={id} title={id}>
                          <Copy k="member" params={{ ref: shortReference(id) }} />
                        </li>
                      ))}
                    </ol>
                    <p className="referral-caption">
                      <Copy k="chainMeaning" />
                    </p>
                  </>
                )}
              </>
            ) : (
              <EmptyState title={<Copy k="noChain" />}>
                <Copy k="noChainBody" />
              </EmptyState>
            )
          }
        </Read>
      </section>
      <section className="referral-block referral-section" aria-label={t('accruals')}>
        <h3>
          <Copy k="accruals" />
        </h3>
        <p className="referral-description">
          <Copy k="meaning" />
        </p>
        <Read resource={records.resource} retry={records.reload}>
          {({ rows }) => (
            <>
              {rows.length ? (
                <div className="referral-list">
                  {rows.map((row) => (
                    <article className="referral-row" key={recordKey(row)} aria-label={`${row.feeEventId} · ${row.hop}`}>
                      <p className="referral-amount">
                        {quantity(row.commissionAmount)} <span>{row.asset}</span>
                      </p>
                      <p className="referral-caption">
                        <time dateTime={row.accruedAt}>
                          {timestamp(row.accruedAt)} · {timeZoneLabel}
                        </time>{' '}
                        · {row.sourceModule}
                      </p>
                      <Button
                        variant="ghost"
                        className="referral-link"
                        aria-pressed={Boolean(selected && recordKey(selected) === recordKey(row))}
                        onClick={() => setSelected({ feeEventId: row.feeEventId, hop: row.hop })}
                      >
                        <Copy k="inspect" />
                      </Button>
                    </article>
                  ))}
                </div>
              ) : (
                <EmptyState title={<Copy k="noAccruals" />}>
                  <Copy k="noAccrualsBody" />
                </EmptyState>
              )}
              <p className="referral-caption">
                <Copy k="window" params={{ count: String(rows.length), limit: String(limit) }} />
              </p>
              <div className="referral-actions">
                {rows.length === limit && limit < 500 && (
                  <Button variant="secondary" onClick={() => setLimit(Math.min(limit * 2, 500))}>
                    <Copy k="expand" params={{ limit: String(Math.min(limit * 2, 500)) }} />
                  </Button>
                )}
                {limit > 50 && (
                  <Button variant="ghost" onClick={() => setLimit(50)}>
                    <Copy k="latest" />
                  </Button>
                )}
              </div>
            </>
          )}
        </Read>
      </section>
      {selected && (
        <section className="referral-block referral-section" aria-label={t('selected')}>
          <h3>
            <Copy k="selected" />
          </h3>
          <dl className="referral-details">
            {detail('event', selected.feeEventId)}
            {detail('hop', String(selected.hop))}
          </dl>
          {current ? (
            <section className="referral-block" aria-label={t('details')}>
              <h4>
                <Copy k="details" />
              </h4>
              <dl className="referral-details">
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
              <p className="referral-caption">
                <Copy k="hopMeaning" />
              </p>
              {hideBalances && (
                <p className="referral-caption">
                  <Copy k="hidden" />
                </p>
              )}
            </section>
          ) : (
            <p className="referral-description">
              <Copy k="missing" />
            </p>
          )}
          <Button variant="ghost" className="referral-link" onClick={() => setSelected(null)}>
            <Copy k="hideInspection" />
          </Button>
        </section>
      )}
    </section>
  );
}
