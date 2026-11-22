import { useId } from 'react';
import { Button } from '@intafaced/ui/lit';
import type { AccountDetailSet, AccountDetailsRow } from '../contracts';
import { accountDetailsCopy } from '../account-details-copy';
import { Copy } from './SalaryCopy';

/**
 * The salary room's drawing of `AccountDetailsList` (../AccountDetails.tsx, which other rooms still draw): the account
 * numbers a bank transfer to the customer uses, one block per currency (BK-acct-03), with the same words, ids and
 * states, in the Volt kit. Every value is the banking partner's own string, shown and copied exactly.
 */

type FieldKey = 'accountNumber' | 'sortCode' | 'routingNumber' | 'bsb' | 'iban' | 'bic';
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

export function SalaryDetailsList({ rows, heading: Heading = 'h3' }: { rows: readonly AccountDetailsRow[]; heading?: 'h3' | 'h4' }) {
  const { t } = accountDetailsCopy.useCopy();
  if (rows.length === 0) return <p>{t('detailsEmpty')}</p>;
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
          <Heading>{row.currency}</Heading>
          <p role="status">
            {t(stateKey[row.state])} {row.blocker && <small>{t('blocker', { code: row.blocker })}</small>}
          </p>
          {row.sets.map((set) => (
            <SetView key={set.id} set={set} />
          ))}
          {row.state === 'unavailable' && <AskDetails />}
        </section>
      ))}
    </div>
  );
}

/** The ask control, on the screen but off, with the reason beside it (as `DisabledAction` in ../DepthParts.tsx). */
function AskDetails() {
  const { t } = accountDetailsCopy.useCopy();
  const id = useId();
  return (
    <div>
      <Button tone="secondary" disabled aria-describedby={id}>
        {t('askDetails')}
      </Button>
      <p id={id}>{t('askReason')}</p>
    </div>
  );
}
