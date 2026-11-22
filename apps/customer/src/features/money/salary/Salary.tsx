import { Skeleton } from '@intafaced/ui/lit/templates';
import { useSession } from '../../session';
import { amount, date, useBankRead, useSpaces, type ActionSpec } from '../components';
import type { AccountDetailsRow, SalaryCredit } from '../contracts';
import { salaryCopy } from '../salary-copy';
import type { Space } from '../client';
import { Copy as CopyButton } from './SalaryCopy';
import { SalaryDetailsList as AccountDetailsList } from './SalaryDetails';
import { SalaryFailure as Failure } from './SalaryFailure';
import { Loaded as ResourceView, NoRows, Part as Section } from './SalaryParts';
import { SalarySorter as IncomeSorter } from './SalarySorter';

/**
 * `/bank/salary` (J-bank-30): salary paid in by direct deposit. The partner bank's account details the employer pays,
 * with Copy on each field and the employer form; the person's split, which is their income sorter for that currency; and
 * each salary credit as the bank recorded it: received, returned or reversed. Every figure and name is the bank's answer.
 * The money is the partner bank's, so nothing here is a ledger balance.
 */
export function SalaryRoom({ open }: { open: (spec: ActionSpec) => void }) {
  const { t } = salaryCopy.useCopy();
  const { profiles } = useSession();
  const details = useBankRead('salary.details', { profile: profiles.active });
  const spaces = useSpaces(200);
  const credits = useBankRead('salary.credits', { limit: 50 });
  const spaceRows: Space[] = spaces.resource.status === 'ready' ? (spaces.resource.data as Space[]) : [];
  const nameOf = (spaceId: string) => spaceRows.find((space) => space.id === spaceId)?.name ?? t('unknownSpace');

  return (
    <div data-testid="salary-room">
      <Section title={t('detailsTitle')} description={t('detailsLead')}>
        {details.resource.status === 'loading' ? (
          <Skeleton shape="rows" />
        ) : details.resource.status === 'failed' ? (
          <div data-testid="salary-details-refused" data-code={details.resource.failure.code ?? undefined}>
            <Failure result={details.resource.failure} retry={details.reload} />
          </div>
        ) : (
          <div data-testid="salary-details">
            <p>{t('heldAt', { bank: details.resource.data.partnerBank, network: details.resource.data.network })}</p>
            <dl className="lt-kv">
              <div>
                <dt>{t('holder')}</dt>
                <dd data-testid="salary-holder">
                  {details.resource.data.holderName ? (
                    <>
                      <span lang="und">{details.resource.data.holderName}</span>{' '}
                      <CopyButton value={details.resource.data.holderName} label={t('holder')} />
                    </>
                  ) : (
                    t('holderUnknown')
                  )}
                </dd>
              </div>
            </dl>
            <AccountDetailsList rows={details.resource.data.currencies} />
            {details.resource.data.holderName &&
              details.resource.data.currencies
                .filter((row) => row.sets.length > 0)
                .map((row) => <EmployerForm key={row.currency} row={row} />)}
          </div>
        )}
      </Section>
      <Section title={t('splitTitle')} description={t('splitLead')}>
        <ResourceView resource={spaces.resource} reload={spaces.reload}>
          {(rows) => <IncomeSorter spaces={rows as Space[]} open={open} />}
        </ResourceView>
      </Section>
      <Section title={t('creditsTitle')}>
        <ResourceView resource={credits.resource} reload={credits.reload}>
          {(rows) =>
            rows.length ? (
              <ul data-testid="salary-credits">
                {rows.map((credit) => (
                  <CreditRow key={credit.networkId} credit={credit} nameOf={nameOf} />
                ))}
              </ul>
            ) : (
              <NoRows title={t('creditsNone')} />
            )
          }
        </ResourceView>
      </Section>
    </div>
  );
}

function EmployerForm({ row }: { row: AccountDetailsRow }) {
  const { t } = salaryCopy.useCopy();
  const { profiles } = useSession();
  const form = useBankRead('salary.form', { currency: row.currency, profile: profiles.active });
  return (
    <section aria-label={t('formTitle', { currency: row.currency })} data-testid={`salary-form-${row.currency}`}>
      <h4>{t('formTitle', { currency: row.currency })}</h4>
      <p>{t('formLead')}</p>
      <ResourceView resource={form.resource} reload={form.reload}>
        {(data) => (
          <>
            <pre lang="und" data-testid="salary-form-text">
              {data.text}
            </pre>
            <p>
              <a
                className="lt-link"
                download={`salary-form-${data.currency}.txt`}
                href={`data:text/plain;charset=utf-8,${encodeURIComponent(data.text)}`}
              >
                {t('formDownload')}
              </a>{' '}
              <CopyButton value={data.text} label={t('formDownload')} />
            </p>
          </>
        )}
      </ResourceView>
    </section>
  );
}

function CreditRow({ credit, nameOf }: { credit: SalaryCredit; nameOf: (spaceId: string) => string }) {
  const { t } = salaryCopy.useCopy();
  const state = { pending: t('pending'), received: t('received'), returned: t('returned'), reversed: t('reversed') }[credit.state];
  return (
    <li data-testid="salary-credit" data-network={credit.networkId} data-state={credit.state}>
      <p>
        <strong data-testid="salary-credit-title">{t('creditFrom', { name: credit.originatorName })}</strong>{' '}
        <span data-testid="salary-credit-amount">{amount(credit.amount, credit.assetId)}</span>{' '}
        <span data-testid="salary-credit-state">{state}</span>
      </p>
      <p className="lt-hint">{date(credit.receivedAt ?? credit.createdAt)}</p>
      {credit.state === 'returned' && credit.refusalCode && (
        <p className="lt-hint" data-testid="salary-credit-code" data-code={credit.refusalCode}>
          {t('returnedWhy', { code: credit.refusalCode })}
        </p>
      )}
      {credit.state === 'reversed' && (
        <p className="lt-hint" data-testid="salary-credit-reversed">
          {t('reversedOn', { date: date(credit.reversedAt) })}
        </p>
      )}
      {credit.legs.length > 0 && (
        <ul>
          {credit.legs.map((leg) => {
            const words = { amount: amount(leg.amount, credit.assetId), space: nameOf(leg.spaceId), code: leg.rejectionCode ?? '' };
            const key = { settled: 'legSettled', rejected: 'legRejected', pending: 'legPending', unsplit: 'legUnsplit' } as const;
            return (
              <li key={leg.position} data-testid="salary-credit-leg" data-status={leg.status}>
                {t(key[leg.status], words)}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}
