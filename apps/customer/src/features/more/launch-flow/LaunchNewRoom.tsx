import { useState } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import { launchDepthCopy } from '../launch-depth-copy';
import { draftIssues, EMPTY_DRAFT, LAUNCH_STEPS, normaliseSymbol, type LaunchDraft } from '../launch-journey';
import { moreRoomRoutesCopy } from '../more-room-routes-copy';
import { LaunchTabs, StepMark, useLaunchGate, useLaunchScope } from './launch-flow-parts';

/**
 * `/launch/new`: the issuer journey, on the flow template. Seven steps from an idea to a sale, each saying whether it
 * can run today and, when it cannot, naming what is missing. The check step opens the pre-listing check at its own
 * address; the asset terms are a draft that stays on this page and is sent nowhere.
 */
export function LaunchNewRoom() {
  const { Copy, t } = launchDepthCopy.useCopy();
  const routes = moreRoomRoutesCopy.useCopy();
  const description = useLaunchScope();
  const gate = useLaunchGate('/launch/new');
  const [draft, setDraft] = useState<LaunchDraft>(EMPTY_DRAFT);
  const [open, setOpen] = useState(false);
  const issues = draftIssues(draft);
  const set = (field: keyof LaunchDraft) => (value: string) => setDraft((current) => ({ ...current, [field]: value }));
  return (
    <FlowTemplate
      title={routes.t('newLaunch')}
      description={description}
      state={gate.state ?? { kind: 'ready' }}
      roomAction={gate.retry}
      step={
        <>
          <LaunchTabs current="/launch/new" />
          <section aria-labelledby="launch-journey-title">
            <h2 id="launch-journey-title">{t('journeyTitle')}</h2>
            <p>
              <Copy k="journeyIntro" />
            </p>
            <ol aria-label={t('journeyLabel')}>
              {LAUNCH_STEPS.map((step, index) => {
                const state = step.mode === 'ready' ? 'ready' : step.mode === 'draft' ? 'paper' : 'blocked';
                return (
                  <li key={step.id} data-step={step.id} data-step-state={state}>
                    <span aria-hidden="true">{index + 1}</span>
                    <h3>{t(`step_${step.id}`)}</h3>
                    <StepMark state={state}>
                      {step.mode === 'ready' ? t('modeReady') : step.mode === 'draft' ? t('modeDraft') : t('modeBlocked')}
                    </StepMark>
                    <p>{t(`step_${step.id}_body`)}</p>
                    {step.mode === 'blocked' ? <p>{t(`step_${step.id}_reason` as 'step_issuance_reason')}</p> : null}
                    {step.id === 'check' ? (
                      <a className="lt-button lt-button-secondary" href="/launch/check">
                        <Copy k="runCheck" />
                      </a>
                    ) : step.id === 'details' ? (
                      <Button aria-expanded={open} onClick={() => setOpen(!open)}>
                        <Copy k="detailsOpen" />
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </section>
          {open ? (
            <section aria-labelledby="launch-details-title">
              <h2 id="launch-details-title">{t('detailsTitle')}</h2>
              <p>
                <Copy k="detailsNote" />
              </p>
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
            </section>
          ) : null}
        </>
      }
      actions={
        open ? (
          <>
            <Button tone="primary" disabled aria-disabled="true">
              {t('submitAction')}
            </Button>
            <p role="note">{t('submitReason')}</p>
            <Button tone="quiet" onClick={() => setDraft(EMPTY_DRAFT)}>
              <Copy k="clearDraft" />
            </Button>
          </>
        ) : undefined
      }
    />
  );
}
