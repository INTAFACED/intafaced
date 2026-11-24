// volt-room: /launch/new
import { useState } from 'react';
import { Button, Field, Tag } from '@intafaced/ui/lit';
import { FlowTemplate, Tabs } from '@intafaced/ui/lit/templates';
import { navigate } from '../../../app/location';
import { useSession } from '../../session';
import { launchCatalogueCopy } from '../launch-catalogue-copy';
import { launchCopy } from '../launch-copy';
import { launchDepthCopy } from '../launch-depth-copy';
import { draftIssues, EMPTY_DRAFT, LAUNCH_STEPS, normaliseSymbol, type LaunchDraft } from '../launch-journey';
import { moreRoomRoutesCopy } from '../more-room-routes-copy';
import { SessionRetryNote, SignInNote } from '../sign-in-note';
import { preservePaperHref } from '../trade-context';
import { Section } from '../volt-parts';

/** The Launch room's sections, each at its own address (MoreRoutes' SECTION_TABS). */
const SECTIONS = [
  { href: '/launch', key: 'catalogue' },
  { href: '/launch/new', key: 'tabJourney' },
  { href: '/launch/check', key: 'tabCheck' },
  { href: '/launch/requirements', key: 'tabRequirements' },
  { href: '/launch/mine', key: 'tabParticipation' },
] as const;

const MODE_TONE = { ready: 'up', draft: 'accent', blocked: 'neutral' } as const;

/**
 * `/launch/new` on the flow template: the issuer journey's seven steps, the local token-details draft and its honest
 * submission blocker. Private to a signed-in account: signed out shows the shared sign-in panel returning here.
 */
export function LaunchNewRoom({ paper }: { paper: boolean }) {
  const { t: scopeT } = launchCopy.useCopy();
  const { Copy, t } = launchDepthCopy.useCopy();
  const catalogue = launchCatalogueCopy.useCopy();
  const routes = moreRoomRoutesCopy.useCopy();
  const { userId, restoreFailed, retryRestore } = useSession();
  const [draft, setDraft] = useState<LaunchDraft>(EMPTY_DRAFT);
  const [open, setOpen] = useState(false);
  const issues = draftIssues(draft);
  const set = (field: keyof LaunchDraft) => (value: string) => setDraft((current) => ({ ...current, [field]: value }));

  return (
    <FlowTemplate
      title={routes.t('newLaunch')}
      description={scopeT('scope')}
      state={{ kind: 'ready' }}
      step={
        <div className="lt-stack">
          <Tabs
            label={t('sections')}
            current={preservePaperHref('/launch/new', paper)}
            items={SECTIONS.map((s) => ({
              href: preservePaperHref(s.href, paper),
              label: s.key === 'catalogue' ? catalogue.t('tabCatalogue') : t(s.key),
            }))}
          />
          {!userId ? (
            restoreFailed ? (
              <SessionRetryNote retry={retryRestore} />
            ) : (
              <SignInNote returnTo="/launch/new" />
            )
          ) : (
            <>
              <Section title={t('journeyTitle')} className="lt-stack">
                <p className="lt-muted">
                  <Copy k="journeyIntro" />
                </p>
                <ol className="lt-stack" aria-label={t('journeyLabel')}>
                  {LAUNCH_STEPS.map((step, index) => {
                    const label = step.mode === 'ready' ? t('modeReady') : step.mode === 'draft' ? t('modeDraft') : t('modeBlocked');
                    return (
                      <li key={step.id} className="lt-stack">
                        <div className="lt-toolbar">
                          <h3>
                            {index + 1}. {t(`step_${step.id}`)}
                          </h3>
                          <Tag tone={MODE_TONE[step.mode]}>{label}</Tag>
                        </div>
                        <p>{t(`step_${step.id}_body`)}</p>
                        {step.mode === 'blocked' ? (
                          <p className="lt-muted">{t(`step_${step.id}_reason` as 'step_issuance_reason')}</p>
                        ) : null}
                        {step.id === 'check' ? (
                          <div className="lt-actions">
                            <Button tone="secondary" onClick={() => navigate(preservePaperHref('/launch/check', paper))}>
                              <Copy k="runCheck" />
                            </Button>
                          </div>
                        ) : step.id === 'details' ? (
                          <div className="lt-actions">
                            <Button tone="secondary" aria-expanded={open} onClick={() => setOpen(!open)}>
                              <Copy k="detailsOpen" />
                            </Button>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              </Section>
              {open ? (
                <Section title={t('detailsTitle')} className="lt-stack">
                  <p className="lt-muted">
                    <Copy k="detailsNote" />
                  </p>
                  <div className="lt-stack">
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
                  <div className="lt-stack">
                    <div className="lt-actions">
                      <Button tone="primary" disabled aria-disabled="true">
                        {t('submitAction')}
                      </Button>
                      <Button tone="quiet" onClick={() => setDraft(EMPTY_DRAFT)}>
                        <Copy k="clearDraft" />
                      </Button>
                    </div>
                    <p className="lt-muted" role="note">
                      {t('submitReason')}
                    </p>
                  </div>
                </Section>
              ) : null}
            </>
          )}
        </div>
      }
    />
  );
}
