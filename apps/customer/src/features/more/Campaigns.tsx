// volt-room: /campaigns
// volt-room: /campaigns/mine
import { useState, type ReactNode } from 'react';
import { Button, Field, Tag, TextArea } from '@intafaced/ui/lit';
import { OverviewTemplate, RecordListTemplate, SectionTabs } from '@intafaced/ui/lit/templates';
import { useApi } from '../session';
import { CampaignCatalogue, MyCampaigns } from './campaign-catalogue';
import { MyVouchers } from './campaign-vouchers';
import { campaignsDepthCopy } from './campaigns-depth-copy';
import { COPY_MAX, HEADLINE_MAX, proposalRequest, type ProposalResult } from './campaign-proposal';
import type { ApiResult } from '../../shared/api';
import { AGENTS_GROWTH_PROPOSE } from '@intafaced/contracts/agents-growth-procedures';

type Tab = 'Catalogue' | 'Journey' | 'Mine' | 'Propose';
/** One step of how a campaign runs: whether it can run today and, if not, the blocker in words. */
type JourneyStep = { id: string; title: ReactNode; body: ReactNode; state: 'ready' | 'blocked'; stateLabel: ReactNode; reason?: ReactNode };
const TABS: readonly Tab[] = ['Catalogue', 'Journey', 'Mine', 'Propose'];
const STEPS = ['discover', 'join', 'tasks', 'reward'] as const;
/** Steps svc-campaigns serves today. Tasks and rewards wait for task campaigns and the reward saga. */
const OPEN_STEPS: ReadonlySet<string> = new Set(['discover', 'join']);

/** The campaign rooms on the overview template: /campaigns opens on the catalogue. */
export function CampaignsRoom({
  initial = 'Catalogue',
  title,
  description,
}: {
  initial?: 'Catalogue' | 'Mine';
  title: string;
  description: string;
}) {
  return (
    <OverviewTemplate
      title={title}
      description={description}
      state={{ kind: 'ready' }}
      hero={null}
      sections={<Campaigns initial={initial} />}
    />
  );
}

/** /campaigns/mine on the record-list template: my joined campaigns and my vouchers. */
export function CampaignsMineRoom({ title, description }: { title: string; description: string }) {
  return <RecordListTemplate title={title} description={description} state={{ kind: 'ready' }} list={<Campaigns initial="Mine" />} />;
}

/** Campaign rooms: the published catalogue, how a campaign runs, the campaigns I joined and my vouchers (/campaigns/mine), and a
 * draft-only proposal. Tasks and rewards state their blockers and show no invented progress or reward. */
export function Campaigns({ initial = 'Catalogue' }: { initial?: 'Catalogue' | 'Mine' }) {
  const [tab, setTab] = useState<Tab>(initial);
  const { t } = campaignsDepthCopy.useCopy();
  return (
    <div className="lt-stack">
      <SectionTabs items={TABS.map((value) => ({ value, label: t(`tab${value}`) }))} value={tab} onChange={setTab} label={t('sections')} />
      {tab === 'Catalogue' ? <CampaignCatalogue /> : tab === 'Journey' ? <HowItWorks /> : tab === 'Mine' ? <Mine /> : <Propose />}
    </div>
  );
}

function HowItWorks() {
  const { Copy, t } = campaignsDepthCopy.useCopy();
  const steps: JourneyStep[] = STEPS.map((id) => ({
    id,
    title: t(`step_${id}`),
    body: t(`step_${id}_body`),
    ...(OPEN_STEPS.has(id)
      ? { state: 'ready' as const, stateLabel: t('stateReady') }
      : { state: 'blocked' as const, stateLabel: t('stateBlocked'), reason: t(`step_${id as 'tasks' | 'reward'}_reason`) }),
  }));
  return (
    <section>
      <h2>{t('journeyTitle')}</h2>
      <ol className="lt-rows" aria-label={t('journeyLabel')}>
        {steps.map((step) => (
          <li key={step.id} data-step={step.state}>
            <h3>{step.title}</h3>
            <Tag tone={step.state === 'ready' ? 'up' : 'neutral'}>{step.stateLabel}</Tag>
            <p>{step.body}</p>
            {step.reason ? <p className="lt-hint">{step.reason}</p> : null}
          </li>
        ))}
      </ol>
      <p className="lt-hint">
        <Copy k="channelsNote" />
      </p>
    </section>
  );
}

function Mine() {
  const { Copy } = campaignsDepthCopy.useCopy();
  return (
    <>
      <MyCampaigns />
      <MyVouchers />
      <a className="lt-link" href="/campaigns/drops">
        <Copy k="dropRoomLink" />
      </a>
    </>
  );
}

function Propose() {
  const api = useApi();
  const { Copy, t } = campaignsDepthCopy.useCopy();
  const [headline, setHeadline] = useState('');
  const [copyText, setCopyText] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ApiResult<ProposalResult> | null>(null);
  const request = proposalRequest(headline, copyText);
  async function send() {
    if (!request) return;
    setBusy(true);
    const result = await api.call(AGENTS_GROWTH_PROPOSE, request);
    setOutcome(result);
    setBusy(false);
    setConfirming(false);
  }
  return (
    <section>
      <h2>{t('proposeTitle')}</h2>
      <p className="lt-hint">
        <Copy k="proposeIntro" />
      </p>
      <Field
        label={t('headline')}
        hint={t('max', { limit: HEADLINE_MAX })}
        value={headline}
        maxLength={HEADLINE_MAX}
        onChange={(event) => setHeadline(event.target.value)}
      />
      <TextArea label={t('copyField')} value={copyText} onChange={setCopyText} maxLength={COPY_MAX} rows={5} />
      {confirming ? (
        <div role="alertdialog" aria-label={t('confirmTitle')} className="lt-review">
          <strong>
            <Copy k="confirmTitle" />
          </strong>
          <p>
            <Copy k="confirmBody" />
          </p>
          <div className="lt-actions">
            <Button tone="primary" disabled={busy} onClick={() => void send()}>
              {busy ? <Copy k="sending" /> : <Copy k="send" />}
            </Button>
            <Button tone="quiet" disabled={busy} onClick={() => setConfirming(false)}>
              <Copy k="cancel" />
            </Button>
          </div>
        </div>
      ) : (
        <Button tone="primary" disabled={!request} onClick={() => setConfirming(true)}>
          <Copy k="review" />
        </Button>
      )}
      {outcome && !outcome.ok ? <p role="alert">{outcome.message}</p> : null}
      {outcome?.ok && outcome.data.status === 'proposal' ? (
        <div role="status">
          <h3>
            <Copy k="resultProposal" />
          </h3>
          <p>
            <Copy k="resultProposalBody" />
          </p>
          <p lang="und">{outcome.data.headline}</p>
          <p className="lt-hint">
            <Copy k="published" />: <Copy k="notPublished" />
          </p>
        </div>
      ) : null}
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
    </section>
  );
}
