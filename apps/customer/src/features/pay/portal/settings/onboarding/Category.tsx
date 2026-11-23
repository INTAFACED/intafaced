import { useState } from 'react';
import { useResource, type Resource } from '../../../../../shared/resource';
import type { ApiResult } from '../../../../../shared/api';
import type { PortalApi } from '../../api';
import type { MemberRole } from '../../schemas';
import { DateTime } from '../../ui/DateTime';
import { categoryCopy } from './category-copy';
import type { CategoryTerms, CategoryView } from './category-api';
import { Gate, Section, SelectField } from '../../volt/parts';
import { Button } from '@intafaced/ui/lit';

export type ChooseCategory = (categoryKey: string, expectedTableVersion: number) => Promise<ApiResult<CategoryView>>;

/**
 * `/pay/compliance`: the categories INTAFACED takes, what each class allows, and the business's own choice
 * (RC-merchant-08). The owner chooses until the business is verified; a team member reads it. svc-pay checks both again.
 */
export function BusinessCategory({ portal, merchantId, role }: { portal: PortalApi; merchantId: string; role: MemberRole }) {
  const { resource, reload } = useResource((signal) => portal.merchantCategory(merchantId, signal), `portal:category:${merchantId}`);
  return (
    <BusinessCategoryView
      resource={resource}
      reload={reload}
      canChoose={role === 'owner'}
      choose={(key, version) => portal.merchantCategoryChoose(merchantId, key, version)}
    />
  );
}

export function BusinessCategoryView({
  resource,
  reload,
  canChoose,
  choose,
}: {
  resource: Resource<CategoryView>;
  reload: () => void;
  canChoose: boolean;
  choose: ChooseCategory;
}) {
  const { t } = categoryCopy.useCopy();
  // Kept here, outside the Gate, so the saved or refused line survives the reload that follows a choice.
  const [outcome, setOutcome] = useState<Outcome>(null);
  return (
    <Section title={t('title')} description={t('body')}>
      <Gate resource={resource} retry={reload} rows={2}>
        {(view) =>
          view.policy.categories.length === 0 ? (
            <div data-testid="category-no-rule">
              <h4>{t('noRule')}</h4>
              <p className="lt-hint">{t('noRuleBody')}</p>
            </div>
          ) : (
            <div>
              {view.chosen ? (
                <div data-testid="category-chosen">
                  <h4>{t('yours')}</h4>
                  <p>
                    <strong>{view.chosen.category.label}</strong>
                  </p>
                  <CategoryFacts category={view.chosen.category} />
                  <p className="lt-hint">
                    {t('chosenOn')}: <DateTime value={view.chosen.chosenAt} />
                  </p>
                </div>
              ) : (
                <p className="lt-hint">{t('notChosen')}</p>
              )}
              {view.locked ? (
                <p className="lt-hint">{t('locked')}</p>
              ) : canChoose ? (
                <ChooseForm view={view} choose={choose} reload={reload} onOutcome={setOutcome} />
              ) : (
                <p className="lt-hint">{t('ownerOnly')}</p>
              )}
              <h4>{t('allCategories')}</h4>
              <ul aria-label={t('allCategories')}>
                {view.policy.categories.map((category) => (
                  <li key={category.key} aria-label={category.label}>
                    <strong>{category.label}</strong>
                    <CategoryFacts category={category} />
                  </li>
                ))}
              </ul>
            </div>
          )
        }
      </Gate>
      {outcome &&
        (outcome.ok ? (
          <p className="lt-hint" role="status">
            {outcome.text}
          </p>
        ) : (
          <p className="lt-hint" role="alert">
            {outcome.text}
          </p>
        ))}
    </Section>
  );
}

/** One category's class, what the class allows, and (for a high-risk one) its reserve and extra documents. */
export function CategoryFacts({ category }: { category: CategoryTerms }) {
  const { t } = categoryCopy.useCopy();
  return (
    <dl data-testid="pp-facts" className="lt-kv">
      <div>
        <dt>{t('classLabel')}</dt>
        <dd>{t(`class_${category.class}`)}</dd>
      </div>
      <div>
        <dt>{t('ruleLabel')}</dt>
        <dd>{t(`rule_${category.class}`)}</dd>
      </div>
      {category.class === 'restricted' && (
        <>
          <div>
            <dt>{t('reserveLabel')}</dt>
            <dd>
              {category.reserve
                ? t('reserveValue', { percent: category.reserve.percent, days: String(category.reserve.holdDays) })
                : t('reserveUnset')}
            </dd>
          </div>
          <div>
            <dt>{t('documentsLabel')}</dt>
            <dd>{category.extraDocuments.length === 0 ? t('noDocuments') : category.extraDocuments.join('; ')}</dd>
          </div>
        </>
      )}
    </dl>
  );
}

type Outcome = { ok: boolean; text: string } | null;

function ChooseForm({
  view,
  choose,
  reload,
  onOutcome: setOutcome,
}: {
  view: CategoryView;
  choose: ChooseCategory;
  reload: () => void;
  onOutcome: (outcome: Outcome) => void;
}) {
  const { t } = categoryCopy.useCopy();
  const [key, setKey] = useState(view.chosen?.category.key ?? '');
  const [busy, setBusy] = useState(false);
  const unchanged = key === '' || key === view.chosen?.category.key;
  async function save() {
    setBusy(true);
    setOutcome(null);
    try {
      const result = await choose(key, view.policy.tableVersion);
      if (result.ok) {
        setOutcome({ ok: true, text: t('chosen') });
        reload();
      } else {
        setOutcome({ ok: false, text: result.message });
        // The table or the business changed meanwhile: show it as it now stands.
        if (
          result.code === 'pay.category_policy_changed' ||
          result.code === 'pay.category_not_found' ||
          result.code === 'pay.category_locked'
        )
          reload();
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <div data-testid="form-stack">
      <SelectField
        label={t('chooseLabel')}
        value={key}
        onChange={setKey}
        options={[['', t('choosePlaceholder')] as const, ...view.policy.categories.map((c) => [c.key, c.label] as const)]}
      />
      <div className="lt-actions">
        <Button tone="primary" disabled={unchanged || busy} onClick={() => void save()}>
          {busy ? t('choosing') : t('choose')}
        </Button>
      </div>
    </div>
  );
}
