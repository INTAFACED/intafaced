import { useState } from 'react';
import { useApi } from '../session/session';
import { Button, Panel, Tabs } from '../../shared/ui';
import { TextArea } from './common';
import { Field } from '../../shared/ui';
import { Journey, type JourneyStep } from './depth-kit';
import { CampaignCatalogue, MyCampaigns } from './campaign-catalogue';
import { MyVouchers } from './campaign-vouchers';
import { campaignsDepthCopy } from './campaigns-depth-copy';
import { COPY_MAX, HEADLINE_MAX, proposalRequest, proposalResult, type ProposalResult } from './campaign-proposal';
import type { ApiResult } from '../../shared/api';

type Tab = 'Catalogue' | 'Journey' | 'Mine' | 'Propose';
const TABS: readonly Tab[] = ['Catalogue', 'Journey', 'Mine', 'Propose'];
const STEPS = ['discover', 'join', 'tasks', 'reward'] as const;
/** Steps svc-campaigns serves today. Tasks and rewards wait for task campaigns and the reward saga. */
const OPEN_STEPS: ReadonlySet<string> = new Set(['discover', 'join']);

/** Campaign rooms: the published catalogue, how a campaign runs, the campaigns I joined and my vouchers (/campaigns/mine), and a
 * draft-only proposal. Tasks and rewards state their blockers and show no invented progress or reward. */
export function Campaigns({ initial = 'Catalogue' }: { initial?: 'Catalogue' | 'Mine' }) {
  const [tab, setTab] = useState<Tab>(initial);
  const { t } = campaignsDepthCopy.useCopy();
  return (
    <div className="more-grid">
      <Tabs
        items={TABS}
        value={tab}
        onChange={(value) => setTab(value as Tab)}
        label={t('sections')}
        labels={{ Catalogue: t('tabCatalogue'), Journey: t('tabJourney'), Mine: t('tabMine'), Propose: t('tabPropose') }}
      />
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
    <Panel title={t('journeyTitle')}>
      <Journey steps={steps} label={t('journeyLabel')} />
      <p className="muted">
        <Copy k="channelsNote" />
      </p>
    </Panel>
  );
}

function Mine() {
  const { Copy } = campaignsDepthCopy.useCopy();
  return (
    <>
      <MyCampaigns />
      <MyVouchers />
      <a className="text-link" href="/campaigns/drops">
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
    const result = await api.mutate('agents', 'growth.propose', request, proposalResult);
    setOutcome(result);
    setBusy(false);
    setConfirming(false);
  }
  return (
    <Panel title={t('proposeTitle')}>
      <p className="muted">
        <Copy k="proposeIntro" />
      </p>
      <Field
        label={t('headline')}
        hint={t('max', { limit: HEADLINE_MAX })}
        value={headline}
        maxLength={HEADLINE_MAX}
        onChange={(event) => setHeadline(event.target.value)}
      />
      <TextArea label={t('copyField')} value={copyText} onChange={setCopyText} maxLength={COPY_MAX} />
      {confirming ? (
        <div role="alertdialog" aria-label={t('confirmTitle')} className="depth-memory">
          <strong>
            <Copy k="confirmTitle" />
          </strong>
          <p>
            <Copy k="confirmBody" />
          </p>
          <div className="depth-card-actions">
            <Button disabled={busy} onClick={() => void send()}>
              {busy ? <Copy k="sending" /> : <Copy k="send" />}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
              <Copy k="cancel" />
            </Button>
          </div>
        </div>
      ) : (
        <Button disabled={!request} onClick={() => setConfirming(true)}>
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
          <p className="muted">
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
    </Panel>
  );
}
