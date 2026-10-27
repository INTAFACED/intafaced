import { useState } from 'react';
import { z } from 'zod';
import { Button, Page } from '../../shared/ui';
import { useResource } from '../../shared/resource';
import { parseAmount } from '../../shared/money';
import type { ApiResult } from '../../shared/api';
import { useSession, useApi } from '../session/session';
import { createMoneyClient } from './client';
import { bankReads, ruleSchema } from './contracts';
import { t } from './repeat-buy-copy';
import {
  funds,
  cadenceField,
  Continuation,
  date,
  iso,
  NoRows,
  positiveMoney,
  ResourceView,
  Section,
  startsField,
  useBankRead,
  usePageLimit,
  type ActionSpec,
} from './components';

type Rule = z.infer<typeof ruleSchema>;
const validAsset = (asset: string) => asset.trim().length > 0 && asset === asset.trim() && asset.length <= 16;
const refusal = (message: string): ApiResult<null> => ({ ok: false, reason: 'error', code: 'money.review_changed', message });
const readRefusal = (subject: string): ApiResult<null> => ({
  ok: false,
  reason: 'error',
  code: 'money.review_read_unavailable',
  message: t('readCheckFailed', { subject }),
});

export function AutoInvestRules({ asset, open }: { asset?: string; open: (spec: ActionSpec) => void }) {
  const api = useApi();
  const [limit, setLimit] = usePageLimit();
  const { resource, reload } = useBankRead('autoInvest.list', { limit });
  function lifecycle(rule: Rule, action: 'pause' | 'resume' | 'cancel'): ActionSpec {
    const facts: [string, string][] = [
      [t('reference'), rule.id],
      [t('from'), t('mainAsset', { asset: rule.assetId })],
    ];
    if (rule.kind === 'dca') {
      facts.push([t('buy'), rule.buyAssetId ?? t('buyUnavailable')], [t('budget'), funds(rule.amount, rule.assetId)]);
      facts.push([t('cadence'), rule.cadence ?? t('eventDriven')]);
    } else facts.push([rule.kind === 'threshold_sweep' ? t('sweep') : t('roundup'), funds(rule.threshold ?? rule.amount, rule.assetId)]);
    facts.push([t('nextRun'), date(rule.nextRunAt)]);
    return {
      title: t(action === 'pause' ? 'pauseTitle' : action === 'resume' ? 'resumeTitle' : 'cancelTitle'),
      procedure: `autoInvest.${action}`,
      facts,
      notes: [t(action === 'pause' ? 'pauseNote' : action === 'resume' ? 'pausedNote' : 'cancelNote')],
      input: () => ({ ruleId: rule.id }),
      verifyOutcome:
        action === 'cancel'
          ? undefined
          : (data) => {
              const returned = data as z.infer<typeof ruleSchema>;
              const sameQuantity = (a: string | null, b: string | null) =>
                a === null || b === null ? a === b : parseAmount(a) === parseAmount(b);
              return (
                returned.kind === rule.kind &&
                returned.assetId === rule.assetId &&
                returned.buyAssetId === rule.buyAssetId &&
                returned.targetPoolId === rule.targetPoolId &&
                (returned.targetSpaceId ?? null) === (rule.targetSpaceId ?? null) &&
                returned.cadence === rule.cadence &&
                returned.createdAt === rule.createdAt &&
                sameQuantity(returned.amount, rule.amount) &&
                sameQuantity(returned.threshold, rule.threshold)
              );
            },
      unit: rule.assetId,
      preflight: async () => {
        const latest = await api.query('bank', 'autoInvest.list', { limit }, bankReads['autoInvest.list']);
        if (!latest.ok) return readRefusal(t('rulesSubject'));
        const current = latest.data.find((row) => row.id === rule.id);
        // Missing from this bounded read cannot establish cancellation or an outcome.
        if (!current || JSON.stringify(current) !== JSON.stringify(rule)) return refusal(t('contextChanged'));
        if (action === 'resume') {
          const policy = await api.query('bank', 'autoInvest.policy', undefined, bankReads['autoInvest.policy']);
          if (!policy.ok) return readRefusal(t('policySubject'));
          if (!policy.data.enabled || (rule.kind === 'dca' && !policy.data.convertWired)) return refusal(t('contextChanged'));
        }
        return { ok: true, data: null };
      },
    };
  }
  return (
    <Section
      title={asset ? t('buyingRules', { asset }) : t('allRules')}
      description={asset ? t('buyingRulesDetail', { asset }) : t('allRulesDetail')}
      actions={
        <Button variant="ghost" onClick={reload}>
          {t('refresh')}
        </Button>
      }
    >
      <ResourceView resource={resource} reload={reload}>
        {(all) => {
          const rows = asset ? all.filter((rule) => rule.kind === 'dca' && rule.buyAssetId === asset) : all;
          return (
            <>
              {rows.length ? (
                rows.map((rule) => (
                  <article data-testid="money-repeat-rule" className="money-record money-repeat-rule" key={rule.id}>
                    <header>
                      <div>
                        <h3>
                          {rule.kind === 'dca'
                            ? t('pair', { amount: funds(rule.amount, rule.assetId), asset: rule.buyAssetId ?? t('buyUnavailable') })
                            : rule.kind === 'threshold_sweep'
                              ? t('sweep')
                              : t('roundup')}
                        </h3>
                        <p className={rule.status === 'active' ? 'money-repeat-active' : undefined}>
                          {rule.status} · {rule.cadence ?? t('eventDriven')}
                        </p>
                      </div>
                      {rule.kind === 'dca' ? (
                        <span className="muted">{t('budget')}</span>
                      ) : (
                        <span className="numeric">{funds(rule.threshold ?? rule.amount, rule.assetId)}</span>
                      )}
                    </header>
                    <dl className="detail-list">
                      <div>
                        <dt>{t('nextRun')}</dt>
                        <dd>{date(rule.nextRunAt)}</dd>
                      </div>
                      <div>
                        <dt>{t('reference')}</dt>
                        <dd>{rule.id}</dd>
                      </div>
                    </dl>
                    {rule.status === 'paused' && <p className="muted">{t('pausedNote')}</p>}
                    {rule.status !== 'cancelled' && (
                      <div className="actions">
                        <Button variant="secondary" onClick={() => open(lifecycle(rule, rule.status === 'paused' ? 'resume' : 'pause'))}>
                          {t(rule.status === 'paused' ? 'resume' : 'pause')}
                        </Button>
                        <Button variant="ghost" onClick={() => open(lifecycle(rule, 'cancel'))}>
                          {t('cancel')}
                        </Button>
                      </div>
                    )}
                  </article>
                ))
              ) : (
                <NoRows title={asset ? t('noRules', { asset }) : t('noAutomation')}>{t('noRulesDetail')}</NoRows>
              )}
              {asset && (
                <p className="muted money-repeat-coverage">{t('matching', { count: String(rows.length), total: String(all.length) })}</p>
              )}
              <Continuation count={all.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
              <p className="muted money-repeat-coverage">{t('historyMissing')}</p>
              {asset && (
                <a className="text-link" href="/bank/earn">
                  {t('otherAutomation')}
                </a>
              )}
            </>
          );
        }}
      </ResourceView>
    </Section>
  );
}

function SpendingSource({ asset, open }: { asset: string; open: (spec: ActionSpec) => void }) {
  const { api, userId } = useSession();
  const [selected, setSelected] = useState('');
  const { resource, reload } = useResource(async (signal) => createMoneyClient(api).balances(signal), `${userId}:repeat-buy-main-balances`);
  return (
    <ResourceView resource={resource} reload={reload}>
      {(balances) => {
        const sources = Object.entries(balances.balances).filter(([id]) => validAsset(id) && id !== asset);
        const spendAsset = sources.some(([id]) => id === selected) ? selected : sources.length === 1 ? sources[0]![0] : '';
        const source = sources.find(([id]) => id === spendAsset);
        if (!sources.length) return <NoRows title={t('noSource')}>{t('noSourceDetail')}</NoRows>;
        function setup(): ActionSpec {
          return {
            title: t('title', { asset }),
            procedure: 'autoInvest.createDca',
            fields: [positiveMoney(spendAsset, 'amount', t('budget')), cadenceField, startsField],
            facts: [
              [t('buy'), asset],
              [t('from'), t('mainAsset', { asset: spendAsset })],
            ],
            notes: [t('executionNote'), t('refusalNote')],
            submit: t('create'),
            unit: spendAsset,
            input: (values) => ({
              spendAssetId: spendAsset,
              buyAssetId: asset,
              amount: values.amount,
              cadence: values.cadence,
              startsAt: iso(values.startsAt!),
            }),
            preflight: async (input) => {
              if (!spendAsset || spendAsset === asset) return refusal(t('contextChanged'));
              if (typeof input.startsAt !== 'string' || Date.parse(input.startsAt) <= Date.now()) return refusal(t('startExpired'));
              const [policy, fresh] = await Promise.all([
                api.query('bank', 'autoInvest.policy', undefined, bankReads['autoInvest.policy']),
                createMoneyClient(api).balances(),
              ]);
              if (!policy.ok) return readRefusal(t('policySubject'));
              if (!fresh.ok) return readRefusal(t('sourceSubject'));
              if (!policy.data.enabled || !policy.data.convertWired || !Object.hasOwn(fresh.data.balances, spendAsset))
                return refusal(t('contextChanged'));
              if (Date.parse(input.startsAt) <= Date.now()) return refusal(t('startExpired'));
              // Scheduling reserves nothing. A zero balance does not prevent future funding.
              return { ok: true, data: null };
            },
          };
        }
        return (
          <div className="money-repeat-setup">
            <label className="field">
              <span>{t('spendSource')}</span>
              <select value={spendAsset} onChange={(event) => setSelected(event.target.value)} aria-label={t('spendSource')}>
                <option value="">{t('choose')}</option>
                {sources.map(([id]) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
            {source && <p className="muted numeric">{t('available', { amount: funds(source[1].free, spendAsset) })}</p>}
            <p className="muted">{t('unreserved')}</p>
            <Button disabled={!source} onClick={() => open(setup())}>
              {t('setup')}
            </Button>
            {source && <p className="muted">{t('setupHint', { asset: spendAsset })}</p>}
          </div>
        );
      }}
    </ResourceView>
  );
}

function PersonalRepeatBuy({ asset, open }: { asset: string; open: (spec: ActionSpec) => void }) {
  const { resource, reload } = useBankRead('autoInvest.policy', undefined);
  return (
    <Page
      eyebrow={t('eyebrow')}
      title={t('title', { asset })}
      description={t('description')}
      actions={
        <a className="button button--secondary" href={`/portfolio/${encodeURIComponent(asset)}`}>
          {t('back', { asset })}
        </a>
      }
    >
      <div data-testid="money-repeat-lanes" className="money-repeat-lanes">
        <Section
          title={t('newTitle')}
          description={t('mainSource')}
          actions={
            <Button variant="ghost" onClick={reload}>
              {t('refresh')}
            </Button>
          }
        >
          <ResourceView resource={resource} reload={reload}>
            {(policy) =>
              policy.enabled && policy.convertWired ? (
                <SpendingSource asset={asset} open={open} />
              ) : (
                <NoRows title={policy.enabled ? t('disconnected') : t('disabled')}>{t('policyDetail')}</NoRows>
              )
            }
          </ResourceView>
        </Section>
        <AutoInvestRules asset={asset} open={open} />
      </div>
    </Page>
  );
}

export function RepeatBuy({ asset, open }: { asset: string; open: (spec: ActionSpec) => void }) {
  const { mode } = useSession();
  if (!validAsset(asset) || mode === 'Business')
    return (
      <Page title={t('invalidTitle')}>
        <NoRows title={t('invalidTitle')}>{mode === 'Business' ? t('personalOnly') : t('invalidAsset')}</NoRows>
      </Page>
    );
  return <PersonalRepeatBuy asset={asset} open={open} />;
}
