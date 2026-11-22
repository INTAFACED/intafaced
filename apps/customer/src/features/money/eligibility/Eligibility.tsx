import { useState } from 'react';
import { BANK_ELIGIBILITY_GET } from '@intafaced/contracts/bank-eligibility-procedures';
import { Button, Field } from '@intafaced/ui/lit';
import type { Resource } from '../../../shared/resource';
import { useBankRecord } from '../components';
import type { Eligibility } from '../contracts';
import { accountDetailsCopy } from '../account-details-copy';
import { Failure, Loading, Panel } from '../bank-settings/parts';

/**
 * Who can open an account (BK-acct-03): the countries, account types and product limits the bank has published, exactly as
 * published, and, for a country the customer types, whether the bank is available there. A rule set that has not been published
 * refuses in words and nothing is listed in its place.
 */

export function EligibilityView({ data }: { data: Eligibility }) {
  const { t } = accountDetailsCopy.useCopy();
  const { rules, verdict } = data;
  const verdictKey = { open: 'verdictOpen', restricted: 'verdictRestricted', blocked: 'verdictBlocked' } as const;
  return (
    <div data-testid="eligibility">
      <dl>
        <div>
          <dt>{t('countries')}</dt>
          <dd lang="und">{rules.countries.join(', ')}</dd>
        </div>
        <div>
          <dt>{t('entityTypes')}</dt>
          <dd lang="und">{rules.entityTypes.join(', ')}</dd>
        </div>
      </dl>
      <h3>{t('productLimits')}</h3>
      {rules.productRestrictions.length === 0 ? (
        <p className="lt-hint">{t('noProductLimits')}</p>
      ) : (
        <ul>
          {rules.productRestrictions.map((entry) => (
            <li key={`${entry.product}:${entry.restriction}`} lang="und">
              <strong>{entry.product}</strong>: {entry.restriction}
            </li>
          ))}
        </ul>
      )}
      {verdict && (
        <div role="status" data-testid="eligibility-verdict">
          <strong>{t(verdictKey[verdict.status], { region: verdict.region })}</strong>
          <p>{verdict.listed ? t('verdictListed') : t('verdictNotListed')}</p>
          {verdict.notes && <p lang="und">{verdict.notes}</p>}
          {verdict.status !== 'blocked' && <p>{t('verdictTier', { tier: verdict.minTier })}</p>}
        </div>
      )}
    </div>
  );
}

export function EligibilityBody({ resource, reload }: { resource: Resource<Eligibility>; reload: () => void }) {
  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  return <EligibilityView data={resource.data} />;
}

export const isRegion = (value: string) => /^[A-Za-z]{2}$/.test(value.trim());

export function EligibilityStatement() {
  const { t } = accountDetailsCopy.useCopy();
  const [typed, setTyped] = useState('');
  const [asked, setAsked] = useState<string | null>(null);
  const read = useBankRecord(BANK_ELIGIBILITY_GET, asked === null ? undefined : { region: asked });
  return (
    <Panel title={t('eligibilityTitle')} lead={t('eligibilityLead')} level={3}>
      <EligibilityBody resource={read.resource} reload={read.reload} />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (isRegion(typed)) setAsked(typed.trim().toUpperCase());
        }}
        noValidate
      >
        <Field
          label={t('checkRegion')}
          hint={t('regionHint')}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          maxLength={2}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
        />
        <Button type="submit" tone="secondary" disabled={!isRegion(typed)}>
          {t('regionCheck')}
        </Button>
      </form>
    </Panel>
  );
}
