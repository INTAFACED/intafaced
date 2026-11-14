import {
  quantQuotaSchema,
  quantTierListSchema,
  QUANT_QUOTA_RESOURCES,
  type QuantQuotaResource,
  type QuantTier,
} from '@intafaced/contracts/quant-algo';
import { useState } from 'react';
import { Button, DataTable, Panel } from '../../shared/ui';
import { useResource } from '../../shared/resource';
import { Read } from '../more/common';
import { useApi } from '../session/session';
import { tierCopy } from './tier-copy';
import { usageCopy } from './usage-copy';

/** What a plan holds, tier or not: its freshness, priority class and one limit per resource; null is "not set". */
interface PlanValues {
  readonly dataFreshnessSeconds: string | null;
  readonly priorityClass: string | null;
  readonly limits: Readonly<Record<QuantQuotaResource, string | null>>;
}

const valuesOf = (tier: QuantTier): PlanValues => ({
  dataFreshnessSeconds: tier.dataFreshnessSeconds,
  priorityClass: tier.priorityClass,
  limits: Object.fromEntries(QUANT_QUOTA_RESOURCES.map((r) => [r, tier.limits.find((row) => row.resource === r)?.limit ?? null])) as Record<
    QuantQuotaResource,
    string | null
  >,
});

/**
 * The plan tiers (RC-algo-dev-05): each published tier, what it changes (data freshness, execution priority class, and
 * the limits of its profile) side by side, or an honest empty state when none is published. Choosing a tier shows what
 * would change against the caller's plan; moving to it is an operator's assignment, not done here.
 */
export function PlanTiers({ revision }: { revision: number }) {
  const api = useApi();
  const { t } = tierCopy.useCopy();
  const { t: u } = usageCopy.useCopy();
  const [chosen, setChosen] = useState<string | null>(null);
  const tiers = useResource(async (signal) => {
    const [list, usage] = await Promise.all([
      api.query('quant', 'tier.list', undefined, quantTierListSchema, { signal }),
      api.query('quant', 'quota.get', undefined, quantQuotaSchema, { signal }),
    ]);
    if (!list.ok) return list;
    if (!usage.ok) return usage;
    return { ok: true as const, data: { ...list.data, usage: usage.data } };
  }, `quant-tiers:${revision}`);

  const freshness = (value: string | null) =>
    value === null ? t('notSet') : value === '0' ? t('freshnessLive') : t('freshnessValue', { seconds: value });
  const priority = (value: string | null) => (value === null ? t('notSet') : t('priorityValue', { value }));
  const limit = (value: string | null) => value ?? t('notSet');

  return (
    <Panel title={t('title')}>
      <section data-testid="quant-plan-tiers" aria-label={t('title')}>
        <p className="muted">{t('intro')}</p>
        <Read resource={tiers.resource} retry={tiers.reload}>
          {(data) => {
            if (data.tiers.length === 0) {
              return (
                <p role="status" data-testid="quant-plan-tiers-empty">
                  {t('empty')}
                </p>
              );
            }
            const current = data.current?.profile ?? null;
            const ownTier = data.tiers.find((tier) => tier.profile === current);
            // Your plan as it stands: its tier's values when it is a published tier; otherwise its limits, no tier values.
            const yours: PlanValues | null = ownTier
              ? valuesOf(ownTier)
              : current
                ? {
                    dataFreshnessSeconds: null,
                    priorityClass: null,
                    limits: Object.fromEntries(data.usage.resources.map((row) => [row.resource, row.limit])) as Record<
                      QuantQuotaResource,
                      string | null
                    >,
                  }
                : null;
            const picked = data.tiers.find((tier) => tier.profile === chosen) ?? null;
            const rows: { key: string; what: string; show: (v: PlanValues) => string }[] = [
              { key: 'freshness', what: t('freshness'), show: (v) => freshness(v.dataFreshnessSeconds) },
              { key: 'priority', what: t('priority'), show: (v) => priority(v.priorityClass) },
              ...QUANT_QUOTA_RESOURCES.map((resource) => ({
                key: resource,
                what: u(resource),
                show: (v: PlanValues) => limit(v.limits[resource]),
              })),
            ];
            const changed = picked && yours ? rows.filter((row) => row.show(yours) !== row.show(valuesOf(picked))) : [];
            return (
              <>
                <DataTable
                  label={t('title')}
                  headers={[
                    t('changes'),
                    ...data.tiers.map((tier) => (tier.profile === current ? t('yours', { profile: tier.profile }) : tier.profile)),
                  ]}
                >
                  {rows.map((row) => (
                    <tr key={row.key} data-row={row.key}>
                      <th scope="row">{row.what}</th>
                      {data.tiers.map((tier) => (
                        <td key={tier.profile} data-tier={tier.profile}>
                          {row.show(valuesOf(tier))}
                        </td>
                      ))}
                    </tr>
                  ))}
                </DataTable>
                <div className="actions">
                  {data.tiers.map((tier) => (
                    <Button key={tier.profile} variant="secondary" onClick={() => setChosen(tier.profile)}>
                      {t('choose', { profile: tier.profile })}
                    </Button>
                  ))}
                </div>
                {picked && (
                  <div data-testid="quant-plan-choice" data-tier={picked.profile} role="status">
                    <p>
                      {current ? t('choiceTitle', { profile: picked.profile, current }) : t('choiceNoPlan', { profile: picked.profile })}
                    </p>
                    {picked.profile === current ? (
                      <p>{t('choiceIsYours')}</p>
                    ) : changed.length === 0 ? (
                      <p>{t('choiceSame')}</p>
                    ) : (
                      <ul>
                        {changed.map((row) => (
                          <li key={row.key} data-row={row.key}>
                            {t('choiceRow', {
                              what: row.what,
                              from: yours ? row.show(yours) : t('notSet'),
                              to: row.show(valuesOf(picked)),
                            })}
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="muted">{t('move')}</p>
                  </div>
                )}
                {!picked && <p className="muted">{t('move')}</p>}
              </>
            );
          }}
        </Read>
      </section>
    </Panel>
  );
}
