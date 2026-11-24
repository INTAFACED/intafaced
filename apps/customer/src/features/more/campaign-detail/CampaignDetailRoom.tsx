// volt-room: /campaigns/:campaignId
import { useState } from 'react';
import type { CampaignEligibility, CampaignView } from '@intafaced/contracts/campaigns-catalogue';
import type { ApiResult } from '../../../shared/api';
import { CAMPAIGNS_PARTICIPATION_JOIN, CAMPAIGNS_PARTICIPATION_REQUEST_REVIEW } from '@intafaced/contracts/campaigns-procedures';
import { Button } from '@intafaced/ui/lit';
import { CatalogueTemplate, KeyValue } from '@intafaced/ui/lit/templates';
import { useApi } from '../../session';
import { useCampaignView, useWeekdays, useWhen, useWho } from '../campaign-catalogue';
import { campaignCatalogueCopy } from '../campaign-catalogue-copy';
import { CampaignCompetition } from '../campaign-competition';
import { CampaignDraw } from '../campaign-draw';
import { CampaignPool } from '../campaign-pool';
import { CampaignTasks } from '../campaign-tasks';
import { EmptyNote, FailureNote, Section, Waiting } from '../volt-parts';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** Refusals these rooms put into their own words; any other failure goes to the shared Failure. */
const JOIN_CODES = [
  'campaign.unknown',
  'campaign.not_active',
  'campaign.outside_window',
  'campaigns.timezone_unset',
  'campaigns.not_eligible',
  'campaigns.region_blocked',
  'campaigns.participant_unread',
  'campaigns.review_not_needed',
  'campaigns.seats_full',
] as const;
type JoinCode = (typeof JOIN_CODES)[number];
const joinCode = (code: string | undefined): JoinCode | null =>
  (JOIN_CODES as readonly string[]).find((c) => c === code) as JoinCode | null;

/** The typed reason for an answer that is not `eligible`. */
const ELIGIBILITY_CODE = {
  not_eligible: 'campaigns.not_eligible',
  region_blocked: 'campaigns.region_blocked',
  unread: 'campaigns.participant_unread',
} as const satisfies Record<Exclude<CampaignEligibility['state'], 'eligible'>, JoinCode>;

/** /campaigns/:campaignId. After any join answer, or none, the page reads the stored campaign again. */
export function CampaignDetail({ campaignId }: { campaignId: string }) {
  const { Copy, t } = campaignCatalogueCopy.useCopy();
  const campaign = useCampaignView(campaignId);
  const [refusal, setRefusal] = useState<Failed | null>(null);
  return (
    <CatalogueTemplate
      title={t('detailTitle')}
      state={{ kind: 'ready' }}
      items={null}
      item={
        <div data-testid="campaign-detail">
          {campaign.resource.status === 'loading' ? (
            <Section title={t('detailTitle')}>
              <Waiting label={t('detailLoading')} />
            </Section>
          ) : campaign.resource.status === 'failed' ? (
            <Section title={t('detailTitle')}>
              {campaign.resource.failure.code === 'campaign.unknown' ? (
                <EmptyNote title={<Copy k="campaign.unknown" />} />
              ) : (
                <FailureNote result={campaign.resource.failure} retry={campaign.reload} />
              )}
            </Section>
          ) : (
            <CampaignBody
              campaign={campaign.resource.data}
              refusal={refusal}
              settle={(failure) => {
                setRefusal(failure);
                campaign.reload();
              }}
            />
          )}
          <a className="lt-link" href="/campaigns">
            <Copy k="backToCatalogue" />
          </a>
        </div>
      }
    />
  );
}

function CampaignBody({
  campaign: c,
  refusal,
  settle,
}: {
  campaign: CampaignView;
  refusal: Failed | null;
  settle: (failure: Failed | null) => void;
}) {
  const api = useApi();
  const { t } = campaignCatalogueCopy.useCopy();
  const when = useWhen();
  const weekdays = useWeekdays();
  const who = useWho();
  const [busy, setBusy] = useState(false);
  const join = async () => {
    setBusy(true);
    const result = await api.call(CAMPAIGNS_PARTICIPATION_JOIN, { campaignId: c.id });
    setBusy(false);
    settle(result.ok ? null : result);
  };
  const askReview = async () => {
    setBusy(true);
    const result = await api.call(CAMPAIGNS_PARTICIPATION_REQUEST_REVIEW, { campaignId: c.id });
    setBusy(false);
    settle(result.ok ? null : result);
  };
  const code = refusal && !c.mine ? joinCode(refusal.code) : null;
  // The rules leave this account out: the reason replaces the Join button, and a refused account may ask once for a review.
  const left =
    !c.mine && c.eligibility && c.eligibility.state !== 'eligible'
      ? { state: c.eligibility.state, code: ELIGIBILITY_CODE[c.eligibility.state], review: c.eligibility.review }
      : null;
  return (
    <>
      <Section title={c.name}>
        <KeyValue
          rows={[
            { label: t('colType'), value: <span data-testid="campaign-type-name">{t(`type_${c.type}`)}</span> },
            { label: t('colState'), value: <span data-testid="campaign-state">{t(`state_${c.state}`)}</span> },
            {
              label: t('timeFrame'),
              value: <span data-testid="campaign-window">{t('windowValue', { start: when(c.startsAt), end: when(c.endsAt) })}</span>,
            },
            { label: t('colWho'), value: <span data-testid="campaign-who">{who(c.participation)}</span> },
          ]}
        />
        <KeyValue
          rows={[
            {
              label: t('days'),
              value: <span data-testid="campaign-days">{c.windows.weekdays ? weekdays(c.windows.weekdays) : t('daysEvery')}</span>,
            },
            {
              label: t('hours'),
              value: (
                <span data-testid="campaign-hours">
                  {c.windows.hours
                    ? t('hoursValue', { from: c.windows.hours.from, to: c.windows.hours.to, zone: c.timeZone })
                    : t('hoursAll')}
                </span>
              ),
            },
            // Budget left only when the owner set a cap: a campaign that pays nothing has no budget line.
            ...(c.budget
              ? [
                  {
                    label: t('budgetLeft'),
                    value: (
                      <span data-testid="campaign-budget-left">
                        {t('budgetLeftValue', { left: c.budget.left, limit: c.budget.limit, asset: c.budget.asset })}
                      </span>
                    ),
                  },
                ]
              : []),
            {
              label: t('reward'),
              value: (
                <span data-testid="campaign-reward">
                  {c.reward ? t('rewardValue', { amount: c.reward.amount, asset: c.reward.asset }) : t('rewardUnset')}
                </span>
              ),
            },
          ]}
        />
      </Section>
      <Section title={t('rulesTitle')}>
        <p data-testid="campaign-rules" lang="und">
          {c.rules || t('rulesNone')}
        </p>
      </Section>
      <Section title={t('joinShort')}>
        {c.type === 'welcome' ? (
          <p data-testid="campaign-welcome">
            <a className="lt-link" href="/uc/promotion">
              {t('welcomeLink')}
            </a>
          </p>
        ) : c.mine ? (
          <p role="status" data-testid="campaign-joined">
            {t('joinedAt', { when: when(c.mine.joinedAt) })}
          </p>
        ) : left ? (
          <div data-testid="campaign-eligibility-panel">
            <p data-testid="campaign-eligibility" data-code={left.code}>
              <strong>{t('eligibilityTitle')}</strong>: {t(`eligibility.${left.state}`)}
            </p>
            {left.review ? (
              <p role="status" data-testid="campaign-review">
                {t('reviewRequested', { when: when(left.review.requestedAt) })}
              </p>
            ) : left.state !== 'unread' ? (
              <>
                <Button tone="primary" onClick={() => void askReview()} disabled={busy} aria-label={t('askReview')}>
                  {busy ? t('askingReview') : t('askReview')}
                </Button>
                <p className="lt-hint">{t('reviewNote')}</p>
              </>
            ) : (
              <Button tone="primary" onClick={() => settle(null)} disabled={busy}>
                {t('checkAgain')}
              </Button>
            )}
          </div>
        ) : (
          <Button tone="primary" onClick={() => void join()} disabled={busy} aria-label={t('join', { name: c.name })}>
            {busy ? t('joining') : t('joinShort')}
          </Button>
        )}
        {refusal && !c.mine ? (
          code ? (
            <p role="status" className="lt-hint" data-testid="campaign-refusal" data-code={code}>
              {t(code)}
            </p>
          ) : (
            <FailureNote result={refusal} />
          )
        ) : null}
        <p className="lt-hint">{t('joinNote')}</p>
      </Section>
      {c.tasks && c.type !== 'welcome' ? <CampaignTasks campaign={c} /> : null}
      {c.type === 'competition' ? <CampaignCompetition campaign={c} version={c.mine?.participationKey ?? 'none'} /> : null}
      {c.type === 'draw' ? <CampaignDraw campaign={c} version={c.mine?.participationKey ?? 'none'} /> : null}
      {c.type === 'pool' ? <CampaignPool campaign={c} version={c.mine?.participationKey ?? 'none'} /> : null}
    </>
  );
}
