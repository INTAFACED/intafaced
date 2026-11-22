import type { Resource } from '../../../shared/resource';

import { useAccountDetailsRead } from '../AccountDetails';

import type { AccountDetailSet, AccountDetailsRow } from '../contracts';

import { accountDetailsCopy } from '../account-details-copy';

import { uiCopy } from '../../../shared/ui-copy';

import { Copy, DisabledAction, FailureBox, Panel } from './deposit-parts';

/**
 * The deposit room's own drawing of the account numbers a bank transfer to the customer uses (BK-acct-03), in the Volt kit.
 * The same read, words, ids and states as `AccountDetailsPanel` in `../AccountDetails`, which the account home and pay
 * rooms still draw: every value is the banking partner's own string, shown and copied exactly, and with no partner
 * connected the bank says so for each currency and no number is shown or made up.
 */

type FieldKey = 'accountNumber' | 'sortCode' | 'routingNumber' | 'bsb' | 'iban' | 'bic';
/** The same fields, in the same order, as `DETAIL_FIELDS` in `../AccountDetails`. */
const DETAIL_FIELDS: readonly FieldKey[] = ['accountNumber', 'sortCode', 'routingNumber', 'bsb', 'iban', 'bic'];

function SetView({ set }: { set: AccountDetailSet }) {
  const { t } = accountDetailsCopy.useCopy();
  return (
    <div data-testid="account-details-set">
      <dl className="lt-kv">
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
                <Copy value={value} label={t('copy', { label: t(key) })} />
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

function AccountDetailsList({ rows }: { rows: readonly AccountDetailsRow[] }) {
  const { t } = accountDetailsCopy.useCopy();
  if (rows.length === 0) return <p className="lt-hint">{t('detailsEmpty')}</p>;
  const stateKey = {
    unavailable: 'stateUnavailable',
    pending_user: 'statePending',
    requirements_fulfilled: 'stateFulfilled',
    done: 'stateDone',
  } as const;
  return (
    <div>
      {rows.map((row) => (
        <section key={row.currency} aria-label={row.currency} data-testid={`account-details-${row.currency}`}>
          <h3>{row.currency}</h3>
          <p role="status">
            {t(stateKey[row.state])} {row.blocker && <small className="lt-hint">{t('blocker', { code: row.blocker })}</small>}
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

function AccountDetailsBody({ resource, reload }: { resource: Resource<{ currencies: AccountDetailsRow[] }>; reload: () => void }) {
  const { t } = accountDetailsCopy.useCopy();
  const ui = uiCopy.useCopy();
  if (resource.status === 'loading') return <p role="status">{ui.t('loading')}…</p>;
  if (resource.status === 'failed' && resource.failure.code === 'bank.company_account_unwired') {
    return (
      <p role="status" data-testid="account-details-company">
        {t('companyUnwired')} <small className="lt-hint">{t('blocker', { code: resource.failure.code })}</small>
      </p>
    );
  }
  if (resource.status === 'failed') return <FailureBox result={resource.failure} retry={reload} />;
  return <AccountDetailsList rows={resource.data.currencies} />;
}

export function AccountDetailsPanel() {
  const { t } = accountDetailsCopy.useCopy();
  const read = useAccountDetailsRead();
  return (
    <Panel title={t('detailsTitle')} lead={t('detailsLead')}>
      <AccountDetailsBody resource={read.resource} reload={read.reload} />
    </Panel>
  );
}
