import {
  type QuantGateCheckResult,
  type QuantGateCriterion,
  type QuantLifecycle,
  type QuantStrategyDetail,
} from '@intafaced/contracts/quant-algo';
import { QUANT_LIFECYCLE_GET, QUANT_LIFECYCLE_PROMOTE } from '@intafaced/contracts/quant-strategy-settings-procedures';
import { useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { useApi } from '../session';
import { lifecycleCopy } from './lifecycle-copy';
import { Button } from '@intafaced/ui/lit';
import { SelectField } from '@intafaced/ui/lit/templates';
import { EmptyNote, FailureNote, Read, ScrollTable, Waiting } from './volt-parts';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
const utcText = (iso: string) => iso.slice(0, 16).replace('T', ' ');

/**
 * A version's lifecycle (AL-lifecycle-01): its stage, every gate check as it reads now, and Promote. Promote is keyed by
 * the number of decisions the page read, so a press after a lost reply reads the first answer instead of asking again.
 */
export function StrategyLifecycle({ strategy }: { strategy: QuantStrategyDetail }) {
  const { t } = lifecycleCopy.useCopy();
  const newest = Math.max(...strategy.versions.map((row) => row.version));
  const [version, setVersion] = useState(String(newest));
  return (
    <section aria-label={t('title')} data-testid="quant-lifecycle">
      <h3>{t('title')}</h3>
      <p>{t('intro')}</p>
      <SelectField
        label={t('version')}
        value={version}
        onChange={setVersion}
        options={[...strategy.versions]
          .sort((a, b) => b.version - a.version)
          .map((row) => ({ value: String(row.version), label: t('versionOf', { version: row.version }) }))}
      />
      <VersionLifecycle key={version} strategyId={strategy.id} version={Number(version)} />
    </section>
  );
}

function VersionLifecycle({ strategyId, version }: { strategyId: string; version: number }) {
  const api = useApi();
  const { t } = lifecycleCopy.useCopy();
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed | null>(null);
  const [outcome, setOutcome] = useState<'approved' | 'rejected' | null>(null);
  const read = useResource(
    (signal) => api.call(QUANT_LIFECYCLE_GET, { strategyId, strategyVersion: version }, { signal }),
    `quant-lifecycle:${strategyId}:${version}:${revision}`,
  );
  async function promote(seq: number) {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    setOutcome(null);
    const res = await api.call(QUANT_LIFECYCLE_PROMOTE, { strategyId, strategyVersion: version, seq });
    setBusy(false);
    if (!res.ok) return setFailure(res);
    setOutcome(res.data.decision.decision);
    setRevision((n) => n + 1);
  }
  return (
    <Read resource={read.resource} retry={read.reload}>
      {(data) => (
        <div data-testid="quant-lifecycle-version" data-version={version} data-stage={data.stage}>
          <p data-testid="quant-stage" data-stage={data.stage}>
            <strong>{t('stage', { stage: t(data.stage) })}</strong>
          </p>
          <h4>{t('checks')}</h4>
          <ScrollTable label={t('checks')} headers={[t('check'), t('status'), t('criterion'), t('observed')]}>
            {data.gate.checks.map((check) => (
              <CheckRow key={check.check} check={check} />
            ))}
          </ScrollTable>
          <Button tone="primary" onClick={() => void promote(data.decisions.length)} disabled={busy}>
            {t('promote', { version })}
          </Button>
          {busy && <Waiting label={t('promoting')} />}
          {outcome && (
            <p role="status" data-testid="quant-promote-decision" data-decision={outcome}>
              {t(outcome, { version })}
            </p>
          )}
          {failure && <PromoteRefusal failure={failure} lifecycle={data} />}
          <Decisions data={data} />
        </div>
      )}
    </Read>
  );
}

function CheckRow({ check }: { check: QuantGateCheckResult }) {
  const { t } = lifecycleCopy.useCopy();
  const criterion = check.criterion
    ? check.criterion.value === null
      ? t('notSet')
      : t(check.criterion.name, { value: check.criterion.value })
    : '';
  const observed =
    check.observed === null
      ? t('nothingRead')
      : check.check === 'outOfSample'
        ? t('verdictRead', { value: check.observed })
        : check.check === 'riskLimits'
          ? t('blankRisk', { value: check.observed })
          : check.check === 'paperDuration'
            ? t('minutesRead', { value: check.observed })
            : t('percentRead', { value: check.observed });
  return (
    <tr
      data-testid="quant-gate-check"
      data-check={check.check}
      data-status={check.status}
      data-criterion-value={check.criterion?.value ?? ''}
      data-run-id={check.runId ?? ''}
    >
      <td>{t(check.check)}</td>
      <td>{t(check.status)}</td>
      <td lang="zxx">{criterion}</td>
      <td lang="zxx">{observed}</td>
    </tr>
  );
}

const UNSET_NAME = { paperMinutes: 'unsetPaperMinutes', maxDrawdownPercent: 'unsetMaxDrawdownPercent' } as const;

/** A refusal in the gate's words: the criteria the owner left blank, or a version already past paper. */
function PromoteRefusal({ failure, lifecycle }: { failure: Failed; lifecycle: QuantLifecycle }) {
  const { t } = lifecycleCopy.useCopy();
  const text = failure.message ?? '';
  const unset = failure.code === 'quant.gate_criteria_unset' || text.startsWith('quant.gate_criteria_unset');
  const transition = failure.code === 'quant.stage_transition_invalid' || text.startsWith('quant.stage_transition_invalid');
  if (!unset && !transition) return <FailureNote result={failure} />;
  const named = (/quant\.gate_criteria_unset — ([a-zA-Z, ]+) — /.exec(text)?.[1] ?? lifecycle.gate.unset.join(', '))
    .split(',')
    .map((name) => name.trim())
    .filter((name): name is QuantGateCriterion => name in UNSET_NAME);
  return (
    <div
      data-testid="quant-promote-refusal"
      data-code={unset ? 'quant.gate_criteria_unset' : 'quant.stage_transition_invalid'}
      data-unset={named.join(',')}
      className="lt-refusal"
      role="status"
    >
      <h4 className="lt-refusal-title">{t('refusedTitle')}</h4>
      <p className="lt-refusal-body">
        {unset ? t('unset', { names: named.map((name) => t(UNSET_NAME[name])).join(', ') }) : t('transition')}
      </p>
    </div>
  );
}

function Decisions({ data }: { data: QuantLifecycle }) {
  const { t } = lifecycleCopy.useCopy();
  return (
    <section
      aria-label={t('history')}
      data-testid="quant-gate-decisions"
      data-count={data.decisions.length}
      data-stages={data.stages.length}
    >
      <h4>{t('history')}</h4>
      {data.decisions.length === 0 ? (
        <EmptyNote title={t('noHistory')} />
      ) : (
        <ScrollTable label={t('history')} headers={[t('decisionAt'), t('decision'), t('move')]}>
          {data.decisions.map((row) => {
            const move = data.stages.find((stage) => stage.at === row.at);
            return (
              <tr key={row.at} data-testid="quant-gate-decision" data-decision={row.decision} data-run-ids={row.runIds.join(',')}>
                <td lang="zxx">{utcText(row.at)}</td>
                <td>{row.decision === 'approved' ? t('approvedShort') : t('rejectedShort')}</td>
                <td>{move ? `${t(move.from)} → ${t(move.to)}` : t('noMove')}</td>
              </tr>
            );
          })}
        </ScrollTable>
      )}
    </section>
  );
}
