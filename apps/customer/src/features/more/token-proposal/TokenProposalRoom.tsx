// volt-room: /token/governance/:proposalId
import type { ReactNode } from 'react';
import type { ProcedureOutput } from '@intafaced/contracts/procedure';
import { TOKEN_GET_PROPOSAL } from '@intafaced/contracts/token-procedures';
import { KeyValue, ReadingTemplate } from '@intafaced/ui/lit/templates';
import { useResource } from '../../../shared/resource';
import { displayAmount } from '../../../shared/money';
import { useApi } from '../../session';
import { t as copyText } from '../copy';
import { moreRoomRoutesCopy } from '../more-room-routes-copy';
import { governanceCopy } from '../token-governance-copy';
import { preservePaperHref } from '../trade-context';
import { EmptyNote, KitRead, Section } from '../volt-parts';
import { tokenProposalCopy } from './token-proposal-copy';

type Proposal = ProcedureOutput<typeof TOKEN_GET_PROPOSAL>;

/** A service instant to the second, in UTC; the `datetime` attribute keeps the exact value. */
function When({ at }: { at: string }) {
  return (
    <time dateTime={at} lang="zxx">
      {`${new Date(at).toISOString().slice(0, 19).replace('T', ' ')} UTC`}
    </time>
  );
}

/** This room's own check over the answer: the proposal asked for, with every instant it shows a real one. */
function reads(proposalId: string) {
  return (p: Proposal) =>
    p.id === proposalId &&
    [p.createdAt, p.opensAt, p.closesAt, ...(p.cancel ? [p.cancel.at] : [])].every((at) => !Number.isNaN(Date.parse(at)));
}

/** The author's own title, or the stored terms' title, when either is written. */
function authoredTitle(p: Proposal): string | null {
  if (p.title?.trim()) return p.title;
  return typeof p.body.title === 'string' && p.body.title.trim() ? p.body.title : null;
}

/** A discussion link opens only on the web's own schemes; anything else is shown as the text it is. */
function webLink(link: string): string | null {
  try {
    const url = new URL(link);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * /token/governance/:proposalId, one governance proposal on the reading template: its title, kind, status and window,
 * its text and stored terms, and its tally, as svc-token's `getProposal` answers them. Nothing here votes or closes:
 * that stays with Token governance, which this page links to. An id the route refuses is answered before anything is
 * looked up, and an id the service does not know (`token.proposal_not_found`) is said as such.
 */
/** `proposalId` is null when the route refused the id in the address. */
export function TokenProposalRoom({ proposalId, paper }: { proposalId: string | null; paper: boolean }) {
  const routes = moreRoomRoutesCopy.useCopy();
  const more = copyText('moreroutes.exact.stake.records.access.and.governance');
  const { t } = tokenProposalCopy.useCopy();
  const governance = preservePaperHref('/token/governance', paper);
  if (proposalId === null)
    return (
      <div data-room="token-proposal">
        <ReadingTemplate
          title={routes.t('proposal')}
          description={more}
          state={{
            kind: 'empty',
            title: routes.t('badIdTitle'),
            body: routes.t('badIdBody'),
            action: { label: routes.t('open'), href: preservePaperHref('/token', paper) },
          }}
          body={null}
        />
      </div>
    );
  const back = (
    <p>
      <a className="lt-link" href={governance}>
        {t('openGovernance')}
      </a>
    </p>
  );
  return (
    <div data-room="token-proposal">
      <ReadingTemplate
        title={routes.t('proposal')}
        description={more}
        state={{ kind: 'ready' }}
        body={<ProposalRead proposalId={proposalId} back={back} />}
      />
    </div>
  );
}

function ProposalRead({ proposalId, back }: { proposalId: string; back: ReactNode }) {
  const api = useApi();
  const { t } = tokenProposalCopy.useCopy();
  const detail = useResource(
    (signal) => api.call(TOKEN_GET_PROPOSAL, { proposalId }, { signal, accept: reads(proposalId) }),
    `token-proposal:${proposalId}`,
  );
  if (detail.resource.status === 'failed' && detail.resource.failure.code === 'token.proposal_not_found')
    return (
      <EmptyNote title={t('notFoundTitle')} action={back}>
        {t('notFoundBody')} <code lang="zxx">token.proposal_not_found</code>
      </EmptyNote>
    );
  return (
    <>
      <KitRead resource={detail.resource} retry={detail.reload}>
        {(p) => <ProposalBody proposal={p} />}
      </KitRead>
      {back}
    </>
  );
}

function ProposalBody({ proposal: p }: { proposal: Proposal }) {
  const { t } = tokenProposalCopy.useCopy();
  const g = governanceCopy.useCopy();
  const title = authoredTitle(p);
  const discussion = p.discussionLink ? webLink(p.discussionLink) : null;
  return (
    <div className="lt-stack" data-proposal-status={p.status}>
      <Section title={title ? <span lang="und">{title}</span> : g.t(p.kind)}>
        <KeyValue
          label={t('details')}
          rows={[
            { label: copyText('token.kind'), value: g.t(p.kind) },
            { label: copyText('token.status'), value: g.t(p.status) },
            { label: t('votingType'), value: t(p.votingType) },
            { label: g.t('created'), value: <When at={p.createdAt} /> },
            { label: g.t('opens'), value: <When at={p.opensAt} /> },
            { label: g.t('closes'), value: <When at={p.closesAt} /> },
            { label: g.t('proposal'), value: <code lang="zxx">{p.id}</code>, ltr: true },
            ...(p.cancel
              ? [
                  { label: t('cancelled'), value: <When at={p.cancel.at} /> },
                  { label: t('cancelReason'), value: <span lang="und">{p.cancel.reason}</span> },
                ]
              : []),
            ...(p.discussionLink
              ? [
                  {
                    label: t('discussion'),
                    value: discussion ? (
                      <a className="lt-link" href={discussion} rel="noopener noreferrer nofollow" lang="zxx">
                        {p.discussionLink}
                      </a>
                    ) : (
                      <span lang="zxx">{p.discussionLink}</span>
                    ),
                    ltr: true,
                  },
                ]
              : []),
          ]}
        />
      </Section>
      {p.bodyMd?.trim() ? (
        <Section title={t('text')}>
          <pre lang="und">{p.bodyMd}</pre>
        </Section>
      ) : null}
      <Section title={t('terms')}>
        <pre lang="und">{JSON.stringify(p.body, null, 2)}</pre>
      </Section>
      {p.votingType === 'basic' ? (
        <Section title={g.t('tally')}>
          <KeyValue
            rows={[
              { label: g.t('for'), value: <span lang="zxx">{displayAmount(p.tally.forWeight)}</span> },
              { label: g.t('against'), value: <span lang="zxx">{displayAmount(p.tally.againstWeight)}</span> },
              { label: g.t('abstain'), value: <span lang="zxx">{displayAmount(p.tally.abstainWeight)}</span> },
              { label: g.t('total'), value: <span lang="zxx">{displayAmount(p.tally.totalWeight)}</span>, total: true },
              { label: g.t('voters'), value: <span lang="zxx">{p.tally.voterCount}</span> },
            ]}
          />
        </Section>
      ) : p.choices && p.choiceTally ? (
        <ChoiceTally choices={p.choices} tally={p.choiceTally} />
      ) : null}
      <p className="lt-hint">
        {g.t('unit')}
        {p.status === 'open' ? ` ${t('vote')}` : null}
      </p>
    </div>
  );
}

/** A multi-choice proposal's weight per choice, in the order the author wrote them. */
function ChoiceTally({ choices, tally }: { choices: readonly string[]; tally: NonNullable<Proposal['choiceTally']> }) {
  const { t } = tokenProposalCopy.useCopy();
  const g = governanceCopy.useCopy();
  const rankOf = new Map(tally.ranking.map((choice, position) => [choice, position + 1]));
  return (
    <Section title={t('choices')}>
      <KeyValue
        rows={[
          ...choices.map((choice, index) => ({
            label: `${index + 1}. ${choice}`,
            value: <span lang="zxx">{displayAmount(tally.totals[index])}</span>,
            note: rankOf.has(index) ? t('rank', { rank: rankOf.get(index)! }) : undefined,
          })),
          { label: g.t('abstain'), value: <span lang="zxx">{displayAmount(tally.abstainWeight)}</span> },
          { label: g.t('voters'), value: <span lang="zxx">{tally.voterCount}</span> },
        ]}
      />
      {tally.rounds ? <p className="lt-hint">{t('rounds', { count: tally.rounds.length })}</p> : null}
    </Section>
  );
}
