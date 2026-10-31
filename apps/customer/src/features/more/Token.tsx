import { t as copyText, Text } from './copy';
import { useEffect, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { useResource, type Resource } from '../../shared/resource';
import { decimalSchema, displayAmount, parseAmount } from '../../shared/money';
import type { ApiResult } from '../../shared/api';
import { currentPreferences, usePreferences } from '../../shared/preferences';
import { Button, DataTable, EmptyState, Panel, Tabs } from '../../shared/ui';
import { TokenHoldings } from './TokenHoldings';
import { Details, Limit, Read, Select, presentActionFailure, useAction } from './common';
import { governanceCopy as G } from './token-governance-copy';
import { GovernanceDelegation, GovernanceProposals, GovernanceSpace, GovernanceTreasury } from './GovernanceRoom';
import { BuybackRuns } from './BuybackRuns';
import { buybackRunsCopy } from './buyback-runs-copy';
import { TokenEconomyPanels } from './TokenEconomy';
import {
  ChoiceBallot,
  ChoiceTallyView,
  VOTING_TYPES,
  VotingPower,
  choiceTallySchema,
  powerSchema,
  signVote,
  type BallotOutcome,
  type ProposalPower,
} from './TokenVoting';
import './token-governance.css';
const uuid = z.string().guid();
/** The service stores `gov:proposal:<space>:<author>:<n>`; older rows keep their uuid. */
const proposalIdSchema = z.union([
  uuid,
  z
    .string()
    .max(512)
    .regex(/^gov:proposal:[^:\s]+:[^:\s]+:[1-9]\d*$/),
]);
const stakeSchema = z.object({
  id: uuid,
  userId: uuid,
  amount: decimalSchema,
  tier: z.enum(['flex', 'm3', 'm12']),
  startedAt: z.string(),
  unlocksAt: z.string().nullable(),
  status: z.enum(['pending', 'active', 'unstaking', 'closed']),
});
const proposalSchema = z.object({
  id: proposalIdSchema,
  kind: z.enum(['listing', 'fee_param', 'curriculum', 'grant']),
  body: z.record(z.string(), z.unknown()),
  status: z.enum(['draft', 'open', 'passed', 'rejected', 'executed', 'cancelled', 'closed_ranked']),
  opensAt: z.string(),
  closesAt: z.string(),
  createdAt: z.string(),
  title: z.string().nullable().optional(),
  authorId: z.string().nullable().optional(),
  votingType: z.enum(VOTING_TYPES).default('basic'),
  choices: z.array(z.string()).nullable().default(null),
});
const tally = z.object({
  forWeight: decimalSchema,
  againstWeight: decimalSchema,
  abstainWeight: decimalSchema,
  totalWeight: decimalSchema,
  voterCount: z.number().int().nonnegative(),
});
const iso = z
  .string()
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)));
const governanceProposal = proposalSchema.extend({ opensAt: iso, closesAt: iso, createdAt: iso });
const choiceSchema = z.enum(['for', 'against', 'abstain']);
type VoteChoice = z.infer<typeof choiceSchema>;
const voteSchema = z.object({
  id: uuid,
  proposalId: proposalIdSchema,
  userId: uuid,
  weight: decimalSchema.refine((value) => {
    try {
      return parseAmount(value) > 0n;
    } catch {
      return false;
    }
  }),
  choice: choiceSchema,
  castAt: iso,
});
const ballotSchema = z
  .object({
    markerId: uuid,
    actor: uuid,
    proposalId: proposalIdSchema,
    choice: choiceSchema,
    status: z.enum(['unknown', 'recorded', 'refused']),
    receipt: voteSchema.optional(),
  })
  .refine((b) =>
    b.status === 'recorded'
      ? Boolean(b.receipt && b.receipt.proposalId === b.proposalId && b.receipt.userId === b.actor && b.receipt.choice === b.choice)
      : b.receipt === undefined,
  );
type Ballot = z.infer<typeof ballotSchema>;
type SavedBallot = { status: 'empty' } | { status: 'unreadable' } | { status: 'ready'; data: Ballot };
/** A tier arrives as a short code ("m3"); people read "3 months". An unknown tier is shown as sent. */
const tierLabel = (tier: string): string => (tier === 'flex' || tier === 'm3' || tier === 'm12' ? copyText(`token.tier.${tier}`) : tier);
const ballotKey = (actor: string) => `intafaced:token:ballot:${actor}`;
const selectionKey = (actor: string) => `intafaced:token:proposal:${actor}`;
function selectedFor(actor: string | null) {
  if (!actor) return '';
  try {
    const value = localStorage.getItem(selectionKey(actor));
    return proposalIdSchema.safeParse(value).success ? value! : '';
  } catch {
    return '';
  }
}
function ballotFor(actor: string | null): SavedBallot {
  if (!actor) return { status: 'empty' };
  try {
    const raw = localStorage.getItem(ballotKey(actor));
    if (!raw) return { status: 'empty' };
    const parsed = ballotSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.actor === actor ? { status: 'ready', data: parsed.data } : { status: 'unreadable' };
  } catch {
    return { status: 'unreadable' };
  }
}
function useSavedBallot(actor: string | null) {
  const [, update] = useState(0);
  useEffect(() => {
    const storage = (event: StorageEvent) => {
      if (actor && (event.key === ballotKey(actor) || event.key === `intafaced:more:pending:${actor}:token` || event.key === null))
        update((revision) => revision + 1);
    };
    const changed = (event: Event) => {
      if (actor && (event as CustomEvent<string>).detail === actor) update((revision) => revision + 1);
    };
    window.addEventListener('storage', storage);
    window.addEventListener('intafaced:token:ballot-updated', changed);
    return () => {
      window.removeEventListener('storage', storage);
      window.removeEventListener('intafaced:token:ballot-updated', changed);
    };
  }, [actor]);
  return ballotFor(actor);
}
function saveBallot(ballot: Ballot) {
  localStorage.setItem(ballotKey(ballot.actor), JSON.stringify(ballotSchema.parse(ballot)));
  // Notify after the shared action has handled its journal, including after a route remount.
  setTimeout(() => window.dispatchEvent(new CustomEvent('intafaced:token:ballot-updated', { detail: ballot.actor })), 0);
}
function useOriginalProposal(actor: string | null) {
  const [state, setState] = useState(() => ({ actor, id: selectedFor(actor), saved: true, revision: 0 }));
  useEffect(() => {
    setState({ actor, id: selectedFor(actor), saved: true, revision: 0 });
    const changed = (event: StorageEvent) => {
      if (actor && event.key === selectionKey(actor))
        setState((current) => ({ actor, id: selectedFor(actor), saved: true, revision: current.revision + 1 }));
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [actor]);
  return {
    id: state.actor === actor ? state.id : '',
    saved: state.actor !== actor || state.saved,
    revision: state.actor === actor ? state.revision : 0,
    choose(id: string) {
      if (!actor || !proposalIdSchema.safeParse(id).success) return;
      let saved = true;
      try {
        localStorage.setItem(selectionKey(actor), id);
      } catch {
        saved = false;
      }
      setState((current) => ({ actor, id, saved, revision: current.revision + 1 }));
    },
  };
}
function authoredTitle(p: z.infer<typeof proposalSchema>) {
  if (p.title?.trim()) return p.title;
  return typeof p.body.title === 'string' && p.body.title.trim() ? p.body.title : null;
}
function proposalTitle(p: z.infer<typeof proposalSchema>) {
  return authoredTitle(p) ?? G.t(p.kind);
}
function titleLanguage(p: z.infer<typeof proposalSchema>) {
  return authoredTitle(p) ? 'und' : currentPreferences().language;
}
function activeWindow(p: z.infer<typeof governanceProposal>, now: number) {
  return p.status === 'open' && Date.parse(p.opensAt) <= now && now < Date.parse(p.closesAt);
}
// Object-key order is not a proposal term. Opaque scalar values and array order are preserved.
function proposalTerms(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(proposalTerms).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => JSON.stringify(key) + ':' + proposalTerms(entry))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}
function reviewedProposal(p: z.infer<typeof governanceProposal>) {
  return JSON.stringify([p.id, p.kind, proposalTerms(p.body), Date.parse(p.opensAt), Date.parse(p.closesAt)]);
}
type RefusalKey = 'changed' | 'inactive' | 'noWeight' | 'storage' | 'receiptStorage' | 'walletNone' | 'walletRejected' | 'walletFailed';
function governanceRefusal(reason: Extract<ApiResult<never>, { ok: false }>['reason'], key: RefusalKey) {
  return presentActionFailure({ ok: false as const, reason, message: G.t(key) }, (locale) => ({
    message: G.forLocale(locale).t(key),
    language: G.forLocale(locale).languageFor(key),
  }));
}
function proposalDetailSchema(id: string) {
  return governanceProposal.extend({ tally, choiceTally: choiceTallySchema.nullable().default(null) }).refine((p) => {
    try {
      // A multi-choice proposal has no for/against: its weight is in the choice tally.
      if (p.votingType !== 'basic')
        return p.id === id && Date.parse(p.closesAt) > Date.parse(p.opensAt) && p.choices !== null && p.choiceTally !== null;
      return (
        p.id === id &&
        Date.parse(p.closesAt) > Date.parse(p.opensAt) &&
        parseAmount(p.tally.totalWeight) ===
          parseAmount(p.tally.forWeight) + parseAmount(p.tally.againstWeight) + parseAmount(p.tally.abstainWeight)
      );
    } catch {
      return false;
    }
  });
}
export type TokenTab = 'Staking' | 'Governance' | 'Economy' | 'Burn';
/** `tab`: the section an address such as /token/economy or /token/burn opens on. */
export function Token({ tab: first }: { tab?: TokenTab } = {}) {
  const { hideBalances } = usePreferences();
  const api = useApi(),
    { userId } = useSession(),
    action = useAction('token');
  const selection = useOriginalProposal(userId);
  const ballot = useSavedBallot(userId);
  const [tab, setTab] = useState<TokenTab>(() => first ?? (selectedFor(userId) ? 'Governance' : 'Staking')),
    [status, setStatus] = useState('all'),
    [limit, setLimit] = useState(50);
  const access = useResource(
      (signal) =>
        api.query('token', 'accessOf', undefined, z.object({ staked: decimalSchema, tier: z.string(), feeDiscountBps: z.number().int() }), {
          signal,
        }),
      `token-access:${userId}`,
    ),
    stakes = useResource(
      (signal) =>
        api.query(
          'token',
          'listStakes',
          { status, limit },
          z
            .array(stakeSchema)
            .refine((rows) => rows.every((row) => row.userId === userId), copyText('token.stake.ownership.does.not.match.this.account')),
          { signal },
        ),
      `token-stakes:${userId}:${status}:${limit}`,
    ),
    burned = useResource(
      (signal) => api.query('token', 'burnedSupply', undefined, z.object({ burned: decimalSchema }), { signal }),
      `token-burn:${userId}`,
    );
  return (
    <div className="more-grid">
      <Tabs
        items={['Staking', 'Governance', 'Economy', 'Burn']}
        labels={{
          Staking: copyText('token.staking'),
          Governance: copyText('token.governance'),
          Economy: copyText('token.economy'),
          Burn: buybackRunsCopy.t('tab'),
        }}
        value={tab}
        onChange={(value) => setTab(value as TokenTab)}
        label={copyText('token.token.sections')}
      />
      {tab === 'Staking' ? (
        <div className="more-columns">
          <div>
            <Panel title={copyText('token.your.token.access')}>
              <Read resource={access.resource} retry={access.reload}>
                {(a) => (
                  <Details
                    items={[
                      [
                        copyText('token.staked.amount'),
                        hideBalances
                          ? copyText('token.hidden.asset.identity.unavailable')
                          : copyText('token.asset.identity.unavailable.2', { amount: displayAmount(a.staked) }),
                      ],
                      [copyText('token.access.tier'), tierLabel(a.tier)],
                      [copyText('token.fee.discount'), copyText('token.basis.points', { bps: a.feeDiscountBps })],
                    ]}
                  />
                )}
              </Read>
            </Panel>
            <Panel title={copyText('token.your.stakes')}>
              <Select
                label={copyText('token.stake.status')}
                value={status}
                onChange={setStatus}
                options={[
                  { value: 'all', label: copyText('token.filter.all') },
                  { value: 'active', label: copyText('token.status.active') },
                  { value: 'pending', label: copyText('token.status.pending') },
                  { value: 'closed', label: copyText('token.status.closed') },
                ]}
              />
              <Read resource={stakes.resource} retry={stakes.reload} empty={copyText('token.you.have.no.stakes')}>
                {(rows) => (
                  <>
                    <DataTable
                      headers={[
                        copyText('token.amount'),
                        copyText('token.term'),
                        copyText('token.status'),
                        copyText('token.unlock'),
                        copyText('token.action'),
                      ]}
                      label={copyText('token.your.token.stakes')}
                    >
                      {rows.map((row) => (
                        <tr key={row.id}>
                          <td>
                            {hideBalances ? '••••' : displayAmount(row.amount)}
                            <Text k="token.asset.identity.unavailable" />
                          </td>
                          <td>{copyText(`token.tier.${row.tier}`)}</td>
                          <td>{copyText(`token.status.${row.status}`)}</td>
                          <td>{row.unlocksAt ?? copyText('token.flexible')}</td>
                          <td>
                            <span className="muted">
                              <Text k="token.unstake.unavailable.asset.identity.missing" />
                            </span>
                          </td>
                        </tr>
                      ))}
                    </DataTable>
                    <Limit count={rows.length} limit={limit} cap={200} onChange={setLimit} />
                  </>
                )}
              </Read>
            </Panel>
            <TokenHoldings />
          </div>
          <Panel title={copyText('token.staking.asset.identity')}>
            <p role="status">
              <Text k="token.staking.and.unstaking.are.unavailable.until.the" />
            </p>
            <p className="muted">
              <Text k="token.the.token.asset.is.deployment.configurable.stake" />
            </p>
            <p className="muted">
              <Text k="token.your.existing.stake.records.remain.readable.a" />
            </p>
            {action.feedback}
          </Panel>
        </div>
      ) : tab === 'Governance' ? (
        <div className="token-governance">
          <BallotContext saved={ballot} choose={selection.choose} />
          {action.feedback}
          <GovernanceSpace />
          <div className="token-governance-layout">
            <GovernanceProposals selectedId={selection.id} onInspect={selection.choose} inspectLabel={(id) => G.t('inspect', { id })} />
            <div id="token-selected-proposal">
              {!selection.saved && <p role="status">{G.t('selectionStorage')}</p>}
              {selection.id ? (
                <Proposal key={`${userId}:${selection.id}:${selection.revision}`} id={selection.id} action={action} ballot={ballot} />
              ) : (
                <Panel title={G.t('selected')}>
                  <EmptyState title={G.t('choose')} />
                </Panel>
              )}
            </div>
          </div>
          <GovernanceDelegation />
          <GovernanceTreasury />
        </div>
      ) : tab === 'Burn' ? (
        <div className="more-columns">
          <Panel title={copyText('token.recorded.burn')}>
            <Read resource={burned.resource} retry={burned.reload}>
              {(b) => (
                <Details
                  items={[
                    [copyText('token.burned.supply'), copyText('token.asset.identity.unavailable.2', { amount: displayAmount(b.burned) })],
                  ]}
                />
              )}
            </Read>
          </Panel>
          <BuybackRuns />
        </div>
      ) : (
        <div className="more-columns">
          <TokenEconomyPanels />
          <Panel title={copyText('token.economy.boundaries')}>
            <p>
              <Text k="token.emission.buyback.and.revenue.distribution.windows.are" />
            </p>
            <p>
              <Text k="token.no.upcoming.distribution.is.quoted" />
            </p>
            <p>
              <Text k="token.governance.closure.depends.on.published.quorum.and" />
            </p>
          </Panel>
        </div>
      )}
      {tab !== 'Staking' && tab !== 'Governance' && action.feedback}
      {action.dialog}
    </div>
  );
}
function timeValue(value: string) {
  return new Date(value).toISOString().replace('T', ' · ').replace('Z', ' UTC');
}
function BallotContext({ saved, choose }: { saved: SavedBallot; choose: (id: string) => void }) {
  const { hideBalances } = usePreferences();
  if (saved.status === 'empty') return null;
  if (saved.status === 'unreadable') return <p role="alert">{G.t('unreadable')}</p>;
  const b = saved.data;
  return (
    <div className="token-ballot-context">
      <Panel title={b.status === 'recorded' ? G.t('receipt') : G.t('request')}>
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
        <p className="muted">{G.t(b.status === 'unknown' ? 'lookup' : b.status === 'recorded' ? 'saved' : 'refusedBoundary')}</p>
        <div className="actions">
          <Button variant="secondary" onClick={() => choose(b.proposalId)}>
            {G.t('readOriginal')}
          </Button>
          {b.status === 'unknown' && (
            <a className="button button--secondary" href="/support">
              {G.t('support')}
            </a>
          )}
        </div>
      </Panel>
    </div>
  );
}
function Proposal({ id, action, ballot }: { id: string; action: ReturnType<typeof useAction>; ballot: SavedBallot }) {
  const api = useApi(),
    { userId } = useSession();
  const [now, setNow] = useState(Date.now);
  const [version, setVersion] = useState(0);
  const [ballotOutcome, setBallotOutcome] = useState<BallotOutcome>(null);
  const [preflight, setPreflight] = useState<{
    detail: Resource<z.infer<ReturnType<typeof proposalDetailSchema>>>;
    power: Resource<ProposalPower>;
  } | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const detail = useResource(
    (signal) => api.query('token', 'getProposal', { proposalId: id }, proposalDetailSchema(id), { signal }),
    `proposal:${userId}:${id}`,
  );
  // Votes weigh the power fixed at creation, never today's stake.
  const power = useResource(
    (signal) => api.query('token', 'votingPower.ofProposal', { proposalId: id }, powerSchema, { signal }),
    `voting-power:${userId}:${id}`,
  );
  const blocked = ballot.status === 'unreadable' || (ballot.status === 'ready' && ballot.data.status === 'unknown');
  const detailView = preflight?.detail ?? detail.resource,
    powerView = preflight?.power ?? power.resource;
  const canWeigh = powerView.status === 'ready' && parseAmount(powerView.data.power) > 0n;
  function refresh() {
    setPreflight(null);
    setVersion((n) => n + 1);
    detail.reload();
    power.reload();
  }
  function stageVote(p: z.infer<ReturnType<typeof proposalDetailSchema>>, choice: VoteChoice) {
    if (
      !userId ||
      action.disabled ||
      blocked ||
      !activeWindow(p, Date.now()) ||
      powerView.status !== 'ready' ||
      parseAmount(powerView.data.power) <= 0n
    )
      return;
    const actor = userId,
      weight = powerView.data.power;
    const body = JSON.stringify(p.body, null, 2);
    const reviewed = reviewedProposal(p);
    action.stage({
      title: () => G.t('review'),
      confirm: () => G.t('cast'),
      success: () => G.t('recorded'),
      reference: id,
      content: () => (
        <div className="token-ballot-review">
          <strong lang={titleLanguage(p)}>{proposalTitle(p)}</strong>
          <Details
            items={[
              [G.t('proposal'), <code lang="zxx">{id}</code>],
              [G.t('requestedChoice'), G.t(choice)],
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
              [G.t('stakeEstimate'), currentPreferences().hideBalances ? G.t('hidden') : displayAmount(weight)],
            ]}
          />
          <p className="muted">
            {G.t('unit')} {G.t('weightBoundary')}
          </p>
          <details>
            <summary>{G.t('body')}</summary>
            <pre lang="und">{body}</pre>
          </details>
          <p className="muted">{G.t('preflight')}</p>
        </div>
      ),
      run: async (canDispatch) => {
        if (!canDispatch() || !api.canWrite()) return governanceRefusal('aborted', 'changed');
        let context: Ballot;
        try {
          const pending = z
            .object({ id: uuid, reference: z.literal(id) })
            .parse(JSON.parse(localStorage.getItem(`intafaced:more:pending:${actor}:token`) ?? 'null'));
          const previous = ballotFor(actor);
          if (previous.status === 'unreadable' || (previous.status === 'ready' && previous.data.status === 'unknown'))
            return governanceRefusal('aborted', 'changed');
          context = { markerId: pending.id, actor, proposalId: id, choice, status: 'unknown' };
          saveBallot(context);
        } catch {
          return governanceRefusal('error', 'storage');
        }
        const refuseBeforeDispatch = (result: Extract<ApiResult<unknown>, { ok: false }>) => {
          try {
            saveBallot({ ...context, status: 'refused' });
          } catch {
            return governanceRefusal('uncertain', 'storage');
          }
          return result;
        };
        setPreflight({ detail: { status: 'loading' }, power: { status: 'loading' } });
        const [fresh, currentPower] = await Promise.all([
          api.query('token', 'getProposal', { proposalId: id }, proposalDetailSchema(id)),
          api.query('token', 'votingPower.ofProposal', { proposalId: id }, powerSchema),
        ]);
        if (!canDispatch() || !api.canWrite()) return refuseBeforeDispatch(governanceRefusal('aborted', 'changed'));
        setPreflight({
          detail: fresh.ok ? { status: 'ready', data: fresh.data } : { status: 'failed', failure: fresh },
          power: currentPower.ok ? { status: 'ready', data: currentPower.data } : { status: 'failed', failure: currentPower },
        });
        if (!fresh.ok) return refuseBeforeDispatch(fresh);
        if (!currentPower.ok) return refuseBeforeDispatch(currentPower);
        if (!activeWindow(fresh.data, Date.now())) return refuseBeforeDispatch(governanceRefusal('error', 'inactive'));
        if (reviewedProposal(fresh.data) !== reviewed) return refuseBeforeDispatch(governanceRefusal('error', 'changed'));
        if (parseAmount(currentPower.data.power) <= 0n) return refuseBeforeDispatch(governanceRefusal('forbidden', 'noWeight'));
        // Every vote carries a linked wallet's signature over the service's own message for it.
        const signed = await signVote(api, { proposalId: id, choice });
        if (!signed.ok) {
          if ('failure' in signed) return refuseBeforeDispatch(signed.failure);
          const key = signed.wallet === 'none' ? 'walletNone' : signed.wallet === 'rejected' ? 'walletRejected' : 'walletFailed';
          return refuseBeforeDispatch(governanceRefusal('error', key));
        }
        if (!canDispatch() || !api.canWrite()) return refuseBeforeDispatch(governanceRefusal('aborted', 'changed'));
        // No await separates the final identity guard and dispatch.
        const result = await api.mutate(
          'token',
          'castVote',
          { proposalId: id, choice, signature: signed.signature },
          voteSchema.refine((vote) => vote.proposalId === id && vote.userId === actor && vote.choice === choice),
        );
        try {
          if (result.ok) saveBallot({ ...context, status: 'recorded', receipt: result.data });
          else if (result.reason !== 'uncertain') saveBallot({ ...context, status: 'refused' });
        } catch {
          return governanceRefusal('uncertain', 'receiptStorage');
        }
        return result;
      },
      done: refresh,
    });
  }
  return (
    <Panel title={G.t('selected')}>
      <div className="token-governance-heading">
        <code lang="zxx">{id}</code>
        <Button variant="ghost" onClick={refresh}>
          {G.t('refresh')}
        </Button>
      </div>
      <Read resource={detailView} retry={refresh}>
        {(p) => (
          <>
            <h3 className="token-proposal-title" lang={titleLanguage(p)}>
              {proposalTitle(p)}
            </h3>
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
            <section className="token-proposal-section">
              <h3>{G.t('body')}</h3>
              <pre className="token-proposal-body" lang="und">
                {JSON.stringify(p.body, null, 2)}
              </pre>
            </section>
            <VotingPower power={power} version={version} />
            {p.votingType !== 'basic' && p.choices && p.choiceTally && (
              <ChoiceTallyView choices={p.choices} tally={p.choiceTally} closedRanked={p.status === 'closed_ranked'} />
            )}
            <section className="token-proposal-section" hidden={p.votingType !== 'basic'}>
              <h3>{G.t('tally')}</h3>
              <dl className="token-tally">
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
              <p className="muted">{G.t('aggregate')}</p>
            </section>
            <section className="token-proposal-section">
              <p className="muted">
                {G.t('unit')} {G.t('weightBoundary')}
              </p>
              {!activeWindow(p, now) && (
                <p role="status" className="muted">
                  {G.t('inactive')}
                </p>
              )}
              {powerView.status === 'ready' && !canWeigh && (
                <p role="status" className="muted">
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
              <div className="actions">
                {(p.votingType === 'basic' ? choiceSchema.options : []).map((choice) => (
                  <Button
                    key={choice}
                    variant="secondary"
                    disabled={action.disabled || blocked || !activeWindow(p, now) || !canWeigh}
                    onClick={() => stageVote(p, choice)}
                  >
                    {G.t(choice === 'for' ? 'reviewFor' : choice === 'against' ? 'reviewAgainst' : 'reviewAbstain')}
                  </Button>
                ))}
                <Button
                  variant="secondary"
                  disabled={action.disabled || p.status !== 'open' || Date.parse(p.closesAt) > Date.now()}
                  onClick={() =>
                    action.stage({
                      title: copyText('token.close.proposal.after.voting'),
                      confirm: copyText('token.close.proposal'),
                      success: copyText('token.proposal.closure.received'),
                      reference: id,
                      content: (
                        <p>
                          <Text k="token.the.service.applies.its.published.quorum.and" />
                        </p>
                      ),
                      run: () =>
                        api.mutate(
                          'token',
                          'closeProposal',
                          { proposalId: id },
                          proposalSchema
                            .extend({ tally, execute: z.literal('token.governance_execute_unwired').nullable() })
                            .refine((closed) => closed.id === id),
                        ),
                      done: refresh,
                    })
                  }
                >
                  <Text k="token.close.voting" />
                </Button>
              </div>
            </section>
          </>
        )}
      </Read>
    </Panel>
  );
}
