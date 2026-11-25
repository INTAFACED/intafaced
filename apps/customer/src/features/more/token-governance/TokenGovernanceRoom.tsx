// volt-room: /token/governance
import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { RecordListTemplate, SectionTabs } from '@intafaced/ui/lit/templates';
import { navigate } from '../../../app/location';
import { displayAmount } from '../../../shared/money';
import { usePreferences } from '../../../shared/preferences';
import { useSession } from '../../session';
import { buybackRunsCopy } from '../buyback-runs-copy';
import { Details } from '../catalogue-parts';
import { t as copyText, Text } from '../copy';
import { GovernanceDelegation, GovernanceProposals, GovernanceSpace, GovernanceTreasury } from '../GovernanceRoom';
import { moreRoomRoutesCopy } from '../more-room-routes-copy';
import {
  activeWindow,
  proposalTitle,
  timeValue,
  titleLanguage,
  useOriginalProposal,
  useProposalPane,
  useSavedBallot,
  type TokenTab,
} from '../Token';
import { choiceSchema, type SavedBallot } from '../token-ballot';
import { governanceCopy as G } from '../token-governance-copy';
import { ChoiceBallot, ChoiceTallyView, VotingPower } from '../TokenVoting';
import { preservePaperHref } from '../trade-context';
import { useKitAction, type KitAction } from '../volt-action';
import { EmptyNote, KitRead, Section } from '../volt-parts';

/** Each section's own address; /token itself is staking. */
const SECTION_PATHS: Readonly<Record<TokenTab, string>> = {
  Staking: '/token',
  Governance: '/token/governance',
  Economy: '/token/economy',
  Burn: '/token/burn',
};

/**
 * `/token/governance` on the record-list template (J-more-catalogue-09, J-more-catalogue-10): the IFC governance space,
 * proposal list with filters and compose/edit/cancel, selected proposal inspection and signed voting, delegation and
 * treasury readouts.
 */
export function TokenGovernanceRoom({ paper }: { paper: boolean }) {
  const routes = moreRoomRoutesCopy.useCopy();
  const { userId } = useSession();
  const action = useKitAction('token');
  const selection = useOriginalProposal(userId);
  const ballot = useSavedBallot(userId);

  return (
    <RecordListTemplate
      title={routes.t('governance')}
      description={copyText('moreroutes.exact.stake.records.access.and.governance')}
      state={{ kind: 'ready' }}
      filters={
        <SectionTabs<TokenTab>
          items={[
            { value: 'Staking', label: copyText('token.staking') },
            { value: 'Governance', label: copyText('token.governance') },
            { value: 'Economy', label: copyText('token.economy') },
            { value: 'Burn', label: buybackRunsCopy.t('tab') },
          ]}
          value="Governance"
          onChange={(tab) => {
            if (tab !== 'Governance') navigate(preservePaperHref(SECTION_PATHS[tab], paper));
          }}
          label={copyText('token.token.sections')}
        />
      }
      list={
        <div className="lt-stack">
          <BallotContext saved={ballot} choose={selection.choose} />
          {action.feedback}
          <GovernanceSpace />
          <GovernanceProposals selectedId={selection.id} onInspect={selection.choose} inspectLabel={(id) => G.t('inspect', { id })} />
          <GovernanceDelegation />
          <GovernanceTreasury />
          {action.dialog}
        </div>
      }
      detail={
        <div id="token-selected-proposal" className="lt-stack">
          {!selection.saved && <p role="status">{G.t('selectionStorage')}</p>}
          {selection.id ? (
            <ProposalPane key={`${userId}:${selection.id}:${selection.revision}`} id={selection.id} action={action} ballot={ballot} />
          ) : (
            <Section title={G.t('selected')}>
              <EmptyNote title={G.t('choose')} />
            </Section>
          )}
        </div>
      }
    />
  );
}

function BallotContext({ saved, choose }: { saved: SavedBallot; choose: (id: string) => void }) {
  const { hideBalances } = usePreferences();
  if (saved.status === 'empty') return null;
  if (saved.status === 'unreadable') return <p role="alert">{G.t('unreadable')}</p>;
  const b = saved.data;
  return (
    <Section title={b.status === 'recorded' ? G.t('receipt') : G.t('request')} className="lt-stack">
      <p role="status">{G.t(b.status === 'recorded' ? 'recorded' : b.status)}</p>
      <Details
        items={[
          [G.t('proposal'), <code lang="zxx">{b.proposalId}</code>],
          [G.t('actor'), <code lang="zxx">{b.actor}</code>],
          [G.t(b.status === 'recorded' ? 'recordedChoice' : 'requestedChoice'), G.t(b.choice)],
          ...(b.receipt
            ? ([
                [G.t('voteId'), <code lang="zxx">{b.receipt.id}</code>],
                [G.t('weight'), hideBalances ? G.t('hidden') : displayAmount(b.receipt.weight)],
                [
                  G.t('castAt'),
                  <time dateTime={b.receipt.castAt} lang="zxx">
                    {timeValue(b.receipt.castAt)}
                  </time>,
                ],
              ] as [string, ReactNode][])
            : []),
        ]}
      />
      <p className="lt-muted">{G.t(b.status === 'unknown' ? 'lookup' : b.status === 'recorded' ? 'saved' : 'refusedBoundary')}</p>
      <div className="lt-actions">
        <Button tone="secondary" onClick={() => choose(b.proposalId)}>
          {G.t('readOriginal')}
        </Button>
        {b.status === 'unknown' && (
          <a className="lt-button lt-button-secondary" href="/support">
            {G.t('support')}
          </a>
        )}
      </div>
    </Section>
  );
}

function ProposalPane({ id, action, ballot }: { id: string; action: KitAction; ballot: SavedBallot }) {
  const { now, version, ballotOutcome, setBallotOutcome, power, detailView, powerView, blocked, canWeigh, refresh, stageVote, stageClose } =
    useProposalPane(id, action, ballot);
  return (
    <Section title={G.t('selected')} className="lt-stack">
      <div className="lt-toolbar">
        <code className="lt-mono" lang="zxx">
          {id}
        </code>
        <Button tone="quiet" onClick={refresh}>
          {G.t('refresh')}
        </Button>
      </div>
      <KitRead resource={detailView} retry={refresh}>
        {(p) => (
          <>
            <h3 lang={titleLanguage(p)}>{proposalTitle(p)}</h3>
            <Details
              items={[
                [copyText('token.kind'), G.t(p.kind)],
                [copyText('token.status'), G.t(p.status)],
                [
                  G.t('created'),
                  <time lang="zxx" dateTime={p.createdAt}>
                    {timeValue(p.createdAt)}
                  </time>,
                ],
                [
                  G.t('opens'),
                  <time lang="zxx" dateTime={p.opensAt}>
                    {timeValue(p.opensAt)}
                  </time>,
                ],
                [
                  G.t('closes'),
                  <time lang="zxx" dateTime={p.closesAt}>
                    {timeValue(p.closesAt)}
                  </time>,
                ],
              ]}
            />
            <section className="lt-stack">
              <h3>{G.t('body')}</h3>
              <pre className="lt-wrap" lang="und">
                {JSON.stringify(p.body, null, 2)}
              </pre>
            </section>
            <VotingPower power={power} version={version} />
            {p.votingType !== 'basic' && p.choices && p.choiceTally && (
              <ChoiceTallyView choices={p.choices} tally={p.choiceTally} closedRanked={p.status === 'closed_ranked'} />
            )}
            <section className="lt-stack" hidden={p.votingType !== 'basic'}>
              <h3>{G.t('tally')}</h3>
              <dl className="lt-kv">
                {[
                  ['for', p.tally.forWeight],
                  ['against', p.tally.againstWeight],
                  ['abstain', p.tally.abstainWeight],
                  ['total', p.tally.totalWeight],
                  ['voters', String(p.tally.voterCount)],
                ].map(([key, value]) => (
                  <div key={key}>
                    <dt>{G.t(key as 'for' | 'against' | 'abstain' | 'total' | 'voters')}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="lt-muted">{G.t('aggregate')}</p>
            </section>
            <section className="lt-stack">
              <p className="lt-muted">
                {G.t('unit')} {G.t('weightBoundary')}
              </p>
              {!activeWindow(p, now) && (
                <p role="status" className="lt-muted">
                  {G.t('inactive')}
                </p>
              )}
              {powerView.status === 'ready' && !canWeigh && (
                <p role="status" className="lt-muted">
                  {G.t('noWeight')}
                </p>
              )}
              {p.votingType !== 'basic' && p.choices && (
                <ChoiceBallot
                  key={`${id}:${p.votingType}`}
                  proposalId={id}
                  votingType={p.votingType}
                  choices={p.choices}
                  open={activeWindow(p, now) && !action.disabled && !blocked && canWeigh}
                  power={power}
                  outcome={ballotOutcome}
                  onOutcome={setBallotOutcome}
                  onCast={refresh}
                />
              )}
              <div className="lt-actions">
                {(p.votingType === 'basic' ? choiceSchema.options : []).map((choice) => (
                  <Button
                    key={choice}
                    tone="secondary"
                    disabled={action.disabled || blocked || !activeWindow(p, now) || !canWeigh}
                    onClick={() => stageVote(p, choice)}
                  >
                    {G.t(choice === 'for' ? 'reviewFor' : choice === 'against' ? 'reviewAgainst' : 'reviewAbstain')}
                  </Button>
                ))}
                <Button
                  tone="secondary"
                  disabled={action.disabled || p.status !== 'open' || Date.parse(p.closesAt) > Date.now()}
                  onClick={stageClose}
                >
                  <Text k="token.close.voting" />
                </Button>
              </div>
            </section>
          </>
        )}
      </KitRead>
    </Section>
  );
}
