import { useState } from 'react';
import { Button, Failure, Loading } from '../../shared/ui';
import type { Resource } from '../../shared/resource';
import { useBankRead } from './components';
import type { Eligibility } from './contracts';
import { accountDetailsCopy } from './account-details-copy';
import { DepthPanel } from './DepthParts';

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
    <div className="bd-stack" data-testid="eligibility">
      <dl className="bd-facts">
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
        <p className="money-caption">{t('noProductLimits')}</p>
      ) : (
        <ul className="bd-list">
          {rules.productRestrictions.map((entry) => (
            <li key={`${entry.product}:${entry.restriction}`} lang="und">
              <strong>{entry.product}</strong>: {entry.restriction}
            </li>
          ))}
        </ul>
      )}
      {verdict && (
        <div className="bd-address" role="status" data-testid="eligibility-verdict">
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
  const read = useBankRead('eligibility.get', asked === null ? undefined : { region: asked });
  return (
    <DepthPanel title={t('eligibilityTitle')} lead={t('eligibilityLead')}>
      <EligibilityBody resource={read.resource} reload={read.reload} />
      <form
        className="bd-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (isRegion(typed)) setAsked(typed.trim().toUpperCase());
        }}
        noValidate
      >
        <label className="field">
          <span>{t('checkRegion')}</span>
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            maxLength={2}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            aria-describedby="eligibility-region-hint"
          />
          <small id="eligibility-region-hint">{t('regionHint')}</small>
        </label>
        <Button type="submit" variant="secondary" disabled={!isRegion(typed)}>
          {t('regionCheck')}
        </Button>
      </form>
    </DepthPanel>
  );
}
