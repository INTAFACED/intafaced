import {
  quantLiveCheckSchema,
  quantStrategyDetailSchema,
  type QuantLiveCheck,
  type QuantLiveOrderType,
} from '@intafaced/contracts/quant-algo';
import { useState } from 'react';
import { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, DataTable, EmptyState, Failure, Field, Loading, Page } from '../../shared/ui';
import { Read, Select } from '../more/common';
import { useApi } from '../session/session';
import { liveDeployCopy } from './live-deploy-copy';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

const REFUSALS = {
  'quant.live_disabled': 'liveDisabled',
  'quant.live_plan_unsupported': 'planUnsupported',
  'trade.order_type_unsupported': 'typeUnsupported',
  'quant.live_deploy_unavailable': 'unavailable',
} as const;
type RefusalCode = keyof typeof REFUSALS;

function refusalOf(failure: Failed): RefusalCode | null {
  for (const code of Object.keys(REFUSALS) as RefusalCode[]) {
    if (failure.code === code || (failure.message ?? '').startsWith(`${code} — `)) return code;
  }
  return null;
}

/**
 * The deploy wizard, opened from the Bots room at `/trade/bots/new?from=<strategyId>` (AL-live-02; J-algo-dev-06 #6 #7).
 * The compile check names each order the live runner can't place; the TEST funding line states the one move the
 * person's own wallet would sign; Deploy asks svc-quant, which refuses while the platform's live switch is off and
 * writes nothing. Nothing here moves money or asks the wallet to sign.
 */
export function LiveDeployWizard({ path }: { path: string }) {
  const { t } = liveDeployCopy.useCopy();
  const from = new URL(path, 'http://x').searchParams.get('from')?.trim() ?? '';
  return (
    <Page
      title={t('title')}
      description={t('intro')}
      actions={
        <a className="button button--secondary" href="/trade/bots?tab=paper">
          {t('back')}
        </a>
      }
    >
      <div data-testid="quant-live-deploy">{from ? <Wizard strategyId={from} /> : <EmptyState title={t('noStrategy')} />}</div>
    </Page>
  );
}

function Wizard({ strategyId }: { strategyId: string }) {
  const api = useApi();
  const { t } = liveDeployCopy.useCopy();
  const read = useResource(
    (signal) => api.query('quant', 'studio.get', { id: strategyId }, quantStrategyDetailSchema, { signal }),
    `quant-live-deploy:${strategyId}`,
  );
  const [version, setVersion] = useState<string | null>(null);
  return (
    <Read resource={read.resource} retry={read.reload}>
      {(strategy) => {
        const newest = Math.max(...strategy.versions.map((row) => row.version));
        const chosen = version ?? String(newest);
        return (
          <>
            <p data-testid="quant-live-strategy" data-id={strategy.id}>
              <strong>{t('strategy', { name: strategy.name })}</strong>
            </p>
            <Select
              label={t('version')}
              value={chosen}
              onChange={setVersion}
              options={[...strategy.versions]
                .sort((a, b) => b.version - a.version)
                .map((row) => ({ value: String(row.version), label: t('versionOf', { version: row.version }) }))}
            />
            <VersionDeploy key={chosen} strategyId={strategy.id} version={Number(chosen)} />
          </>
        );
      }}
    </Read>
  );
}

function VersionDeploy({ strategyId, version }: { strategyId: string; version: number }) {
  const api = useApi();
  const { t } = liveDeployCopy.useCopy();
  const [check, setCheck] = useState<QuantLiveCheck | null>(null);
  const [checkFailure, setCheckFailure] = useState<Failed | null>(null);
  const [checking, setChecking] = useState(false);
  const [amount, setAmount] = useState('');
  const [deploying, setDeploying] = useState(false);
  const [refusal, setRefusal] = useState<Failed | null>(null);
  // The live switch as the service reads it now, before any check is run.
  const status = useResource(
    (signal) => api.query('quant', 'live.check', { strategyId, strategyVersion: version }, quantLiveCheckSchema, { signal }),
    `quant-live-status:${strategyId}:${version}`,
  );
  async function runCheck() {
    setChecking(true);
    setCheckFailure(null);
    const res = await api.query('quant', 'live.check', { strategyId, strategyVersion: version }, quantLiveCheckSchema);
    setChecking(false);
    if (res.ok) setCheck(res.data);
    else setCheckFailure(res);
  }
  async function deploy() {
    if (deploying) return;
    setDeploying(true);
    setRefusal(null);
    const res = await api.mutate('quant', 'live.deploy', { strategyId, strategyVersion: version, amount: amount.trim() }, z.never());
    setDeploying(false);
    if (!res.ok) setRefusal(res);
  }
  const live = status.resource.status === 'ready' ? status.resource.data.liveEnabled : null;
  const shown = amount.trim();
  return (
    <section aria-label={t('checkTitle')}>
      {live !== null && (
        <p role="status" data-testid="quant-live-switch" data-live={live ? 'on' : 'off'}>
          {live ? t('liveOn') : t('liveOff')}
        </p>
      )}
      <Button variant="secondary" onClick={() => void runCheck()} disabled={checking} data-testid="quant-live-check-run">
        {t('check')}
      </Button>
      {checking && <Loading label={t('checking')} />}
      {checkFailure && <Failure result={checkFailure} retry={() => void runCheck()} />}
      {check && <CheckResult check={check} />}
      <Field label={t('amount')} value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} />
      <p data-testid="quant-live-funding" data-amount={shown}>
        {shown ? t('funding', { amount: shown }) : t('fundingBlank')}
      </p>
      <Button onClick={() => void deploy()} disabled={deploying} data-testid="quant-live-deploy-run">
        {t('deploy', { version })}
      </Button>
      {deploying && <Loading label={t('deploying')} />}
      {refusal && <DeployRefusal failure={refusal} />}
    </section>
  );
}

function partOf(row: QuantLiveOrderType, t: ReturnType<typeof liveDeployCopy.useCopy>['t']) {
  if (row.source === 'block') return t('block', { n: row.block ?? 0 });
  if (row.source === 'signal_entry') return t('signal_entry');
  return t(row.source, { percent: row.percent ?? '' });
}

function typeOf(row: QuantLiveOrderType, t: ReturnType<typeof liveDeployCopy.useCopy>['t']) {
  return row.type === 'take_profit' ? t('takeProfitType') : t(row.type);
}

function CheckResult({ check }: { check: QuantLiveCheck }) {
  const { t } = liveDeployCopy.useCopy();
  const refused = check.orderTypes.filter((row) => !row.supported).length;
  return (
    <div data-testid="quant-live-compile" data-compiles={String(check.compiles)} data-plan={check.plan}>
      <h3>{t('checkTitle')}</h3>
      {check.orderTypes.length === 0 ? (
        <EmptyState title={t('nothing')} />
      ) : (
        <DataTable label={t('checkTitle')} headers={[t('part'), t('orderType'), t('verdict')]}>
          {check.orderTypes.map((row, i) => (
            <tr
              key={`${row.source}:${row.block ?? i}`}
              data-testid="quant-live-order-type"
              data-source={row.source}
              data-type={row.type}
              data-supported={String(row.supported)}
              data-code={row.code ?? ''}
            >
              <td>{partOf(row, t)}</td>
              <td>{typeOf(row, t)}</td>
              <td>
                {row.supported
                  ? t('supported')
                  : row.code === 'quant.live_plan_unsupported'
                    ? t('refusedPlan')
                    : t('refusedType', { type: typeOf(row, t).toLowerCase() })}
              </td>
            </tr>
          ))}
        </DataTable>
      )}
      <p role="status">
        {check.compiles
          ? t('compiles', { version: check.strategyVersion })
          : check.orderTypes.length > 0
            ? t('notCompiles', { version: check.strategyVersion, count: refused })
            : null}
      </p>
    </div>
  );
}

function DeployRefusal({ failure }: { failure: Failed }) {
  const { t } = liveDeployCopy.useCopy();
  const code = refusalOf(failure);
  if (!code) return <Failure result={failure} />;
  return (
    <div data-testid="quant-deploy-refusal" data-code={code} className="failure" role="status">
      <h4>{t('refusedTitle')}</h4>
      <p>{t(REFUSALS[code])}</p>
    </div>
  );
}
