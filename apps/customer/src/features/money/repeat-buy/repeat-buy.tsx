import { useState, type ReactNode } from 'react';
import { z } from 'zod';
import { Button, EmptyState } from '@intafaced/ui/lit';
import { FlowTemplate, Skeleton } from '@intafaced/ui/lit/templates';
import type { Resource } from '../../../shared/resource';
import { useResource } from '../../../shared/resource';
import { parseAmount } from '../../../shared/money';
import type { ApiResult } from '../../../shared/api';
import { useFailureWords } from '../../../shared/failure-words';
import { useSession, useApi } from '../../session';
import { createMoneyClient } from '../client';
import { bankReads, ruleSchema } from '../contracts';
import { t } from '../repeat-buy-copy';
import { t as copyText } from '../copy';
import { funds, cadenceField, date, iso, positiveMoney, startsField, useBankRead, usePageLimit, type ActionSpec } from '../components';

type Rule = z.infer<typeof ruleSchema>;
const validAsset = (asset: string) => asset.trim().length > 0 && asset === asset.trim() && asset.length <= 16;
const refusal = (message: string): ApiResult<null> => ({ ok: false, reason: 'error', code: 'money.review_changed', message });
const readRefusal = (subject: string): ApiResult<null> => ({
  ok: false,
  reason: 'error',
  code: 'money.review_read_unavailable',
  message: t('readCheckFailed', { subject }),
});

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** A failed read, in the words the shared failure line gives, with its try-again. */
function FailureNote({ result, retry }: { result: Failed; retry?: () => void }) {
  const w = useFailureWords(result, Boolean(retry));
  return (
    <div data-testid="failure" role={w.alert ? 'alert' : 'status'}>
      <h3>{w.title}</h3>
      <p lang={w.bodyLang}>{w.body}</p>
      {w.action && (
        <a className="lt-link" href={w.action.href}>
          {w.action.label}
        </a>
      )}
      {w.reference && <small>{w.reference}</small>}
      {w.retry && retry && (
        <Button tone="secondary" onClick={retry}>
          {w.retry}
        </Button>
      )}
    </div>
  );
}

/** A read: the skeleton while it loads, the failure line if it failed, else what it read. */
function Read<T>({ resource, reload, children }: { resource: Resource<T>; reload: () => void; children: (data: T) => ReactNode }) {
  if (resource.status === 'loading') return <Skeleton shape="rows" count={3} />;
  if (resource.status === 'failed') return <FailureNote result={resource.failure} retry={reload} />;
  return <>{children(resource.data)}</>;
}

/** A titled part of the room with its own refresh. */
function Lane({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <header>
        <div>
          <h2>{title}</h2>
          {description && <p className="lt-hint">{description}</p>}
        </div>
        {actions && <div className="lt-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/** How many records a bounded read returned, and the way to ask for more. */
function More({ count, limit, onMore }: { count: number; limit: number; onMore: () => void }) {
  return (
    <div>
      <span>
        {count}
        {copyText('components.records.returned.requested.limit')}.{' '}
        {count >= limit
          ? limit < 200
            ? copyText('components.more.records.may.exist')
            : copyText('components.this.service.has.no.continuation.beyond.200')
          : copyText('components.this.list.has.no.total.count.or')}
      </span>
      {count >= limit && limit < 200 && (
        <Button tone="secondary" onClick={onMore}>
          {copyText('components.load.up.to')}
          {Math.min(200, limit + 50)}
        </Button>
      )}
    </div>
  );
}

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
    <Lane
      title={asset ? t('buyingRules', { asset }) : t('allRules')}
      description={asset ? t('buyingRulesDetail', { asset }) : t('allRulesDetail')}
      actions={
        <Button tone="quiet" onClick={reload}>
          {t('refresh')}
        </Button>
      }
    >
      <Read resource={resource} reload={reload}>
        {(all) => {
          const rows = asset ? all.filter((rule) => rule.kind === 'dca' && rule.buyAssetId === asset) : all;
          return (
            <>
              {rows.length ? (
                rows.map((rule) => (
                  <article key={rule.id}>
                    <header>
                      <div>
                        <h3>
                          {rule.kind === 'dca'
                            ? t('pair', { amount: funds(rule.amount, rule.assetId), asset: rule.buyAssetId ?? t('buyUnavailable') })
                            : rule.kind === 'threshold_sweep'
                              ? t('sweep')
                              : t('roundup')}
                        </h3>
                        <p data-status={rule.status}>
                          {rule.status} · {rule.cadence ?? t('eventDriven')}
                        </p>
                      </div>
                      {rule.kind === 'dca' ? (
                        <span className="lt-hint">{t('budget')}</span>
                      ) : (
                        <span className="lt-mono">{funds(rule.threshold ?? rule.amount, rule.assetId)}</span>
                      )}
                    </header>
                    <dl className="lt-kv">
                      <div>
                        <dt>{t('nextRun')}</dt>
                        <dd>{date(rule.nextRunAt)}</dd>
                      </div>
                      <div>
                        <dt>{t('reference')}</dt>
                        <dd>{rule.id}</dd>
                      </div>
                    </dl>
                    {rule.status === 'paused' && <p className="lt-hint">{t('pausedNote')}</p>}
                    {rule.status !== 'cancelled' && (
                      <div className="lt-actions">
                        <Button tone="secondary" onClick={() => open(lifecycle(rule, rule.status === 'paused' ? 'resume' : 'pause'))}>
                          {t(rule.status === 'paused' ? 'resume' : 'pause')}
                        </Button>
                        <Button tone="quiet" onClick={() => open(lifecycle(rule, 'cancel'))}>
                          {t('cancel')}
                        </Button>
                      </div>
                    )}
                  </article>
                ))
              ) : (
                <EmptyState title={asset ? t('noRules', { asset }) : t('noAutomation')} body={t('noRulesDetail')} />
              )}
              {asset && <p className="lt-hint">{t('matching', { count: String(rows.length), total: String(all.length) })}</p>}
              <More count={all.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
              <p className="lt-hint">{t('historyMissing')}</p>
              {asset && (
                <a className="lt-link" href="/bank/earn">
                  {t('otherAutomation')}
                </a>
              )}
            </>
          );
        }}
      </Read>
    </Lane>
  );
}

function SpendingSource({ asset, open }: { asset: string; open: (spec: ActionSpec) => void }) {
  const { api, userId } = useSession();
  const [selected, setSelected] = useState('');
  const { resource, reload } = useResource(async (signal) => createMoneyClient(api).balances(signal), `${userId}:repeat-buy-main-balances`);
  return (
    <Read resource={resource} reload={reload}>
      {(balances) => {
        const sources = Object.entries(balances.balances).filter(([id]) => validAsset(id) && id !== asset);
        const spendAsset = sources.some(([id]) => id === selected) ? selected : sources.length === 1 ? sources[0]![0] : '';
        const source = sources.find(([id]) => id === spendAsset);
        if (!sources.length) return <EmptyState title={t('noSource')} body={t('noSourceDetail')} />;
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
          <div>
            <label className="lt-field">
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
            {source && <p className="lt-hint lt-mono">{t('available', { amount: funds(source[1].free, spendAsset) })}</p>}
            <p className="lt-hint">{t('unreserved')}</p>
            <Button tone="primary" disabled={!source} onClick={() => open(setup())}>
              {t('setup')}
            </Button>
            {source && <p className="lt-hint">{t('setupHint', { asset: spendAsset })}</p>}
          </div>
        );
      }}
    </Read>
  );
}

function PersonalRepeatBuy({ asset, open }: { asset: string; open: (spec: ActionSpec) => void }) {
  const { resource, reload } = useBankRead('autoInvest.policy', undefined);
  return (
    <FlowTemplate
      title={t('title', { asset })}
      description={t('description')}
      roomAction={
        <a className="lt-link" href={`/portfolio/${encodeURIComponent(asset)}`}>
          {t('back', { asset })}
        </a>
      }
      state={{ kind: 'ready' }}
      step={
        <div>
          <p className="lt-hint">{t('eyebrow')}</p>
          <Lane
            title={t('newTitle')}
            description={t('mainSource')}
            actions={
              <Button tone="quiet" onClick={reload}>
                {t('refresh')}
              </Button>
            }
          >
            <Read resource={resource} reload={reload}>
              {(policy) =>
                policy.enabled && policy.convertWired ? (
                  <SpendingSource asset={asset} open={open} />
                ) : (
                  <EmptyState title={policy.enabled ? t('disconnected') : t('disabled')} body={t('policyDetail')} />
                )
              }
            </Read>
          </Lane>
        </div>
      }
      summary={<AutoInvestRules asset={asset} open={open} />}
    />
  );
}

export function RepeatBuy({ asset, open }: { asset: string; open: (spec: ActionSpec) => void }) {
  const { mode } = useSession();
  if (!validAsset(asset) || mode === 'Business')
    return (
      <FlowTemplate
        title={t('invalidTitle')}
        state={{ kind: 'empty', title: t('invalidTitle'), body: mode === 'Business' ? t('personalOnly') : t('invalidAsset') }}
        step={null}
      />
    );
  return <PersonalRepeatBuy asset={asset} open={open} />;
}
