import { useState } from 'react';
import { useApi } from '../session/session';
import { Button, DataTable, EmptyState, Field, Panel } from '../../shared/ui';
import { Select } from './common';
import { DisabledAction, Journey, StatRow, StatusPill, type JourneyStep } from './depth-kit';
import { launchDepthCopy } from './launch-depth-copy';
import {
  assessResult,
  draftIssues,
  EMPTY_DRAFT,
  LAUNCH_STEPS,
  normaliseSymbol,
  type AssessResult,
  type LaunchDraft,
} from './launch-journey';
import type { ApiResult } from '../../shared/api';

export function LaunchJourney({ onTab }: { onTab: (tab: 'Check') => void }) {
  const { Copy, t } = launchDepthCopy.useCopy();
  const [draft, setDraft] = useState<LaunchDraft>(EMPTY_DRAFT);
  const [open, setOpen] = useState(false);
  const issues = draftIssues(draft);
  const set = (field: keyof LaunchDraft) => (value: string) => setDraft((current) => ({ ...current, [field]: value }));
  const steps: JourneyStep[] = LAUNCH_STEPS.map((step) => {
    const state = step.mode === 'ready' ? 'ready' : step.mode === 'draft' ? 'paper' : 'blocked';
    const label = step.mode === 'ready' ? t('modeReady') : step.mode === 'draft' ? t('modeDraft') : t('modeBlocked');
    return {
      id: step.id,
      title: t(`step_${step.id}`),
      body: t(`step_${step.id}_body`),
      state,
      stateLabel: label,
      ...(step.mode === 'blocked' ? { reason: t(`step_${step.id}_reason` as 'step_issuance_reason') } : {}),
      action:
        step.id === 'check' ? (
          <Button variant="secondary" onClick={() => onTab('Check')}>
            <Copy k="runCheck" />
          </Button>
        ) : step.id === 'details' ? (
          <Button variant="secondary" aria-expanded={open} onClick={() => setOpen(!open)}>
            <Copy k="detailsOpen" />
          </Button>
        ) : undefined,
    };
  });
  return (
    <div className="more-grid">
      <Panel title={t('journeyTitle')}>
        <p className="muted">
          <Copy k="journeyIntro" />
        </p>
        <Journey steps={steps} label={t('journeyLabel')} />
      </Panel>
      {open ? (
        <Panel title={t('detailsTitle')}>
          <p className="muted">
            <Copy k="detailsNote" />
          </p>
          <div className="depth-filters">
            <Field label={t('fieldName')} value={draft.name} maxLength={64} onChange={(e) => set('name')(e.target.value)} />
            <Field
              label={t('fieldSymbol')}
              hint={t('fieldSymbolHint')}
              value={draft.symbol}
              onChange={(e) => set('symbol')(normaliseSymbol(e.target.value))}
            />
            <Field
              label={t('fieldSupply')}
              inputMode="decimal"
              value={draft.supply}
              onChange={(e) => set('supply')(e.target.value.trim())}
            />
            <Field
              label={t('fieldDecimals')}
              inputMode="numeric"
              value={draft.decimals}
              onChange={(e) => set('decimals')(e.target.value.trim())}
            />
            <Field
              label={t('fieldSaleShare')}
              inputMode="numeric"
              value={draft.saleShare}
              onChange={(e) => set('saleShare')(e.target.value.trim())}
            />
          </div>
          {issues.length && JSON.stringify(draft) !== JSON.stringify(EMPTY_DRAFT) ? (
            <div role="status">
              <strong>
                <Copy k="draftInvalid" />
              </strong>
              <ul>
                {issues.map((issue) => (
                  <li key={issue}>
                    <Copy k={`issue_${issue}`} />
                  </li>
                ))}
              </ul>
            </div>
          ) : !issues.length ? (
            <p role="status">
              <Copy k="draftValid" />
            </p>
          ) : null}
          <DisabledAction label={t('submitAction')} reason={t('submitReason')} />
          <Button variant="ghost" onClick={() => setDraft(EMPTY_DRAFT)}>
            <Copy k="clearDraft" />
          </Button>
        </Panel>
      ) : null}
    </div>
  );
}

export function LaunchCheck() {
  const api = useApi();
  const { Copy, t } = launchDepthCopy.useCopy();
  const [deployer, setDeployer] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ApiResult<AssessResult> | null>(null);
  async function run() {
    setBusy(true);
    const result = await api.query('agents', 'launch.assess', { deployer: deployer.trim() || undefined }, assessResult);
    setOutcome(result);
    setBusy(false);
  }
  return (
    <Panel title={t('checkTitle')}>
      <p className="muted">
        <Copy k="checkIntro" />
      </p>
      <form
        className="depth-filters"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <Field label={t('deployer')} value={deployer} maxLength={128} onChange={(e) => setDeployer(e.target.value)} />
        <Button type="submit" disabled={busy || !deployer.trim()}>
          {busy ? <Copy k="checking" /> : <Copy k="runCheck" />}
        </Button>
      </form>
      {outcome && !outcome.ok ? <p role="alert">{outcome.message}</p> : null}
      {outcome?.ok && outcome.data.status === 'refuse' ? (
        <div role="status">
          <h3>
            <Copy k="resultRefuse" />
          </h3>
          <p>
            <Copy k={`refuse_${outcome.data.reason}`} />
          </p>
        </div>
      ) : null}
      {outcome?.ok && outcome.data.status === 'annotation' ? (
        <div role="status">
          <h3>
            <Copy k="resultAnnotation" />
          </h3>
          <StatRow
            items={[
              { label: t('lpLocks'), value: outcome.data.lpLocks },
              { label: t('vestings'), value: outcome.data.vestings },
            ]}
          />
          <h3>
            <Copy k="flags" />
          </h3>
          {outcome.data.patternFlags.length ? (
            <ul>
              {outcome.data.patternFlags.map((flag) => (
                <li key={flag.code}>
                  <Copy k={`flag_${flag.code}`} />
                </li>
              ))}
            </ul>
          ) : (
            <p>
              <Copy k="noFlags" />
            </p>
          )}
        </div>
      ) : null}
    </Panel>
  );
}

export function LaunchParticipation() {
  const { Copy, t } = launchDepthCopy.useCopy();
  return (
    <Panel title={t('participationTitle')}>
      <p className="muted">
        <Copy k="participationBody" />
      </p>
      <div className="depth-filters">
        <Select label={t('filterRound')} value="" onChange={() => undefined} options={[{ value: '', label: t('filterAny') }]} />
        <Select label={t('filterStatus')} value="" onChange={() => undefined} options={[{ value: '', label: t('filterAny') }]} />
      </div>
      <EmptyState title={<Copy k="participationUnavailable" />}>
        <StatusPill state="blocked">
          <Copy k="modeBlocked" />
        </StatusPill>{' '}
        <Copy k="participationBlocker" />
      </EmptyState>
      <DataTable headers={[t('colRound'), t('colSubscribed'), t('colAllocated'), t('colStatus')]} label={t('participationTitle')}>
        <tr>
          <td colSpan={4}>
            <Copy k="participationUnavailable" />
          </td>
        </tr>
      </DataTable>
    </Panel>
  );
}
