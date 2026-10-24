import { useState } from 'react';
import { Failure, Loading } from '../../shared/ui';
import type { Resource } from '../../shared/resource';
import { CopyButton } from '../../screens/account/CopyButton';
import { useSession } from '../session/session';
import { useBankRead } from './components';
import type { AccountDetailSet, AccountDetailsRow } from './contracts';
import { accountDetailsCopy } from './account-details-copy';
import { DepthPanel, DisabledAction } from './DepthParts';

/**
 * The account numbers a bank transfer to the customer uses, one block per currency (BK-acct-03). Every value is the banking
 * partner's own string, shown and copied exactly. With no partner connected the bank says so for each currency and no number is
 * shown or made up; the ask control stays off with that reason beside it.
 */

type FieldKey = 'accountNumber' | 'sortCode' | 'routingNumber' | 'bsb' | 'iban' | 'bic';
export const DETAIL_FIELDS: readonly FieldKey[] = ['accountNumber', 'sortCode', 'routingNumber', 'bsb', 'iban', 'bic'];

function SetView({ set }: { set: AccountDetailSet }) {
  const { t } = accountDetailsCopy.useCopy();
  return (
    <div className="bd-stack" data-testid="account-details-set">
      <dl className="bd-facts">
        {DETAIL_FIELDS.map((key) => {
          const value = set[key];
          if (value === null) return null;
          return (
            <div key={key}>
              <dt>{t(key)}</dt>
              <dd>
                <span lang="und" data-withdrawal-private>
                  {value}
                </span>{' '}
                <CopyButton value={value} label={t('copy', { label: t(key) })} />
              </dd>
            </div>
          );
        })}
        <div>
          <dt>{t('partnerBank')}</dt>
          <dd lang="und">{set.partnerBank}</dd>
        </div>
        {set.restrictions.length > 0 && (
          <div>
            <dt>{t('restrictions')}</dt>
            <dd lang="und">{set.restrictions.join(', ')}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

export function AccountDetailsList({ rows }: { rows: readonly AccountDetailsRow[] }) {
  const { t } = accountDetailsCopy.useCopy();
  if (rows.length === 0) return <p className="money-caption">{t('detailsEmpty')}</p>;
  const stateKey = {
    unavailable: 'stateUnavailable',
    pending_user: 'statePending',
    requirements_fulfilled: 'stateFulfilled',
    done: 'stateDone',
  } as const;
  return (
    <div className="bd-stack">
      {rows.map((row) => (
        <section key={row.currency} aria-label={row.currency} data-testid={`account-details-${row.currency}`}>
          <h3>{row.currency}</h3>
          <p role="status">
            {t(stateKey[row.state])} {row.blocker && <small className="muted">{t('blocker', { code: row.blocker })}</small>}
          </p>
          {row.sets.map((set) => (
            <SetView key={set.id} set={set} />
          ))}
          {row.state === 'unavailable' && <DisabledAction label={t('askDetails')} reason={t('askReason')} />}
        </section>
      ))}
    </div>
  );
}

export function AccountDetailsBody({ resource, reload }: { resource: Resource<{ currencies: AccountDetailsRow[] }>; reload: () => void }) {
  const { t } = accountDetailsCopy.useCopy();
  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'failed' && resource.failure.code === 'bank.company_account_unwired') {
    return (
      <p role="status" data-testid="account-details-company">
        {t('companyUnwired')} <small className="muted">{t('blocker', { code: resource.failure.code })}</small>
      </p>
    );
  }
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  return <AccountDetailsList rows={resource.data.currencies} />;
}

export function AccountDetailsPanel() {
  const { t } = accountDetailsCopy.useCopy();
  const { profiles } = useSession();
  // The profile in view goes with the read: the bank proves it is held, and a business has no details of its own.
  const read = useBankRead('accountDetails.list', { profile: profiles.active });
  return (
    <DepthPanel title={t('detailsTitle')} lead={t('detailsLead')}>
      <AccountDetailsBody resource={read.resource} reload={read.reload} />
    </DepthPanel>
  );
}

/**
 * Receiving from abroad (J-bank-05 #5): pick one currency the account holds and see its details, or the bank's own reason
 * there are none. The rows are the bank's answer for the profile in view; nothing is listed that it did not send.
 */
export function AccountDetailsByCurrency() {
  const { t } = accountDetailsCopy.useCopy();
  const { profiles } = useSession();
  const read = useBankRead('accountDetails.list', { profile: profiles.active });
  const [currency, setCurrency] = useState('');
  if (read.resource.status !== 'ready' || read.resource.data.currencies.length === 0) {
    return <AccountDetailsBody resource={read.resource} reload={read.reload} />;
  }
  const rows = read.resource.data.currencies;
  const chosen = rows.find((row) => row.currency === currency);
  return (
    <div className="bd-stack" data-testid="receive-details">
      <label>
        {t('receiveCurrency')}{' '}
        <select value={currency} onChange={(event) => setCurrency(event.target.value)}>
          <option value="">{t('receiveChoose')}</option>
          {rows.map((row) => (
            <option key={row.currency} value={row.currency}>
              {row.currency}
            </option>
          ))}
        </select>
      </label>
      {chosen && <AccountDetailsList rows={[chosen]} />}
    </div>
  );
}
