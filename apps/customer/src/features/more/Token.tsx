import { t as copyText, Text } from './copy';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { useResource, type Resource } from '../../shared/resource';
import { decimalSchema, displayAmount, parseAmount } from '../../shared/money';
import type { ApiResult } from '../../shared/api';
import { currentPreferences, usePreferences } from '../../shared/preferences';
import { Button, DataTable, EmptyState, Field, Panel, Tabs } from '../../shared/ui';
import { EmissionEpoch, TokenHoldings } from './TokenHoldings';
import { Details, Limit, Read, Select, TextArea, presentActionFailure, useAction } from './common';
import { governanceCopy as G } from './token-governance-copy';
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
  status: z.enum(['draft', 'open', 'passed', 'rejected', 'executed', 'cancelled']),
  opensAt: z.string(),
  closesAt: z.string(),
  createdAt: z.string(),
  title: z.string().nullable().optional(),
  authorId: z.string().nullable().optional(),
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
type RefusalKey = 'changed' | 'inactive' | 'noWeight' | 'storage' | 'receiptStorage';
function governanceRefusal(reason: Extract<ApiResult<never>, { ok: false }>['reason'], key: RefusalKey) {
  return presentActionFailure({ ok: false as const, reason, message: G.t(key) }, (locale) => ({
    message: G.forLocale(locale).t(key),
    language: G.forLocale(locale).languageFor(key),
  }));
}
function proposalDetailSchema(id: string) {
  return governanceProposal.extend({ tally }).refine((p) => {
    try {
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
export type TokenTab = 'Staking' | 'Governance' | 'Economy';
/** `tab`: the section an address such as /token/economy opens on. */
export function Token({ tab: first }: { tab?: TokenTab } = {}) {
  const { hideBalances } = usePreferences();
  const api = useApi(),
    { userId } = useSession(),
    action = useAction('token');
  const selection = useOriginalProposal(userId);
  const ballot = useSavedBallot(userId);
  const [tab, setTab] = useState<TokenTab>(() => first ?? (selectedFor(userId) ? 'Governance' : 'Staking')),
    [status, setStatus] = useState('all'),
    [limit, setLimit] = useState(50),
    [proposalStatus, setProposalStatus] = useState('all'),
    [proposalKind, setProposalKind] = useState('all'),
    [proposalLimit, setProposalLimit] = useState(50),
    [kind, setKind] = useState('curriculum'),
    [proposalBody, setProposalBody] = useState(''),
    [opens, setOpens] = useState(''),
    [closes, setCloses] = useState(''),
    [validation, setValidation] = useState('');
  // The same create request keeps its handle until the service confirms it, so submitting it again after an unknown
  // outcome returns the stored proposal instead of opening a second one. Changed content is a new request.
  const createAttempt = useRef<{ request: string; handle: string } | null>(null);
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
    proposals = useResource(
      (signal) =>
        api.query(
          'token',
          'listProposals',
          {
            limit: proposalLimit,
            ...(proposalStatus !== 'all' ? { status: proposalStatus } : {}),
            ...(proposalKind !== 'all' ? { kind: proposalKind } : {}),
          },
          z
            .array(governanceProposal)
            .refine(
              (rows) =>
                rows.length <= proposalLimit &&
                new Set(rows.map((row) => row.id)).size === rows.length &&
                rows.every(
                  (row) =>
                    Date.parse(row.closesAt) > Date.parse(row.opensAt) &&
                    (proposalStatus === 'all' || row.status === proposalStatus) &&
                    (proposalKind === 'all' || row.kind === proposalKind),
                ),
            ),
          { signal },
        ),
      `token-proposals:${userId}:${proposalStatus}:${proposalKind}:${proposalLimit}`,
    ),
    burned = useResource(
      (signal) => api.query('token', 'burnedSupply', undefined, z.object({ burned: decimalSchema }), { signal }),
      `token-burn:${userId}`,
    );
  return (
    <div className="more-grid">
      <Tabs
        items={['Staking', 'Governance', 'Economy']}
        labels={{ Staking: copyText('token.staking'), Governance: copyText('token.governance'), Economy: copyText('token.economy') }}
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
        <div data-testid="token-governance" className="token-governance">
          <BallotContext saved={ballot} choose={selection.choose} />
          {action.feedback}
          <div className="token-governance-layout">
            <Panel title={G.t('proposals')}>
              <div className="token-governance-heading">
                <p className="muted">{G.t('intro')}</p>
                <Button variant="ghost" onClick={proposals.reload}>
                  {G.t('refreshList')}
                </Button>
              </div>
              <div className="token-governance-filters">
                <Select
                  label={G.t('statusFilter')}
                  value={proposalStatus}
                  onChange={setProposalStatus}
                  options={[
                    { value: 'all', label: G.t('allStatus') },
                    ...proposalSchema.shape.status.options.map((value) => ({ value, label: G.t(value) })),
                  ]}
                />
                <Select
                  label={G.t('kindFilter')}
                  value={proposalKind}
                  onChange={setProposalKind}
                  options={[
                    { value: 'all', label: G.t('allKinds') },
                    ...proposalSchema.shape.kind.options.map((value) => ({ value, label: G.t(value) })),
                  ]}
                />
              </div>
              <Read resource={proposals.resource} retry={proposals.reload} empty={G.t('empty')}>
                {(rows) => (
                  <>
                    <div className="token-proposal-list" aria-label={copyText('token.governance.proposals')}>
                      {rows.map((p) => (
                        <Button
                          key={p.id}
                          variant="ghost"
                          data-testid="token-proposal-row"
                          className="token-proposal-row"
                          aria-label={G.t('inspect', { id: p.id })}
                          aria-pressed={selection.id === p.id}
                          aria-controls="token-selected-proposal"
                          onClick={() => selection.choose(p.id)}
                        >
                          <span>
                            <strong lang={titleLanguage(p)}>{proposalTitle(p)}</strong>
                            <small>{G.t(p.kind)}</small>
                            <code lang="zxx">{p.id}</code>
                          </span>
                          <span>{G.t(p.status)}</span>
                        </Button>
                      ))}
                    </div>
                    <Limit count={rows.length} limit={proposalLimit} cap={200} onChange={setProposalLimit} />
                  </>
                )}
              </Read>
              <p className="muted">{G.t('coverage')}</p>
              <p className="muted">{G.t('original')}</p>
            </Panel>
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
          <details data-testid="token-create" className="token-create">
            <summary>{copyText('token.create.a.proposal')}</summary>
            <Panel title={copyText('token.create.a.proposal')}>
              <p className="muted">
                <Text k="token.the.service.decides.which.proposal.kinds.your" />
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setValidation('');
                  let body: unknown;
                  try {
                    body = JSON.parse(proposalBody);
                  } catch {
                    setValidation(copyText('token.enter.a.valid.json.object.for.the'));
                    return;
                  }
                  if (!z.record(z.string(), z.unknown()).safeParse(body).success) {
                    setValidation(copyText('token.enter.a.valid.json.object.for.the'));
                    return;
                  }
                  if ((opens && !Number.isFinite(Date.parse(opens))) || (closes && !Number.isFinite(Date.parse(closes)))) {
                    setValidation(copyText('token.enter.valid.opening.and.closing.dates'));
                    return;
                  }
                  if (opens && closes && Date.parse(closes) <= Date.parse(opens)) {
                    setValidation(copyText('token.the.closing.date.must.be.after.the'));
                    return;
                  }
                  const author = userId;
                  const opensAt = opens ? new Date(opens).toISOString() : undefined,
                    closesAt = closes ? new Date(closes).toISOString() : undefined;
                  const terms = proposalTerms(body);
                  const request = JSON.stringify([author, kind, terms, opensAt ?? null, closesAt ?? null]);
                  if (createAttempt.current?.request !== request) createAttempt.current = { request, handle: crypto.randomUUID() };
                  const handle = createAttempt.current.handle;
                  action.stage({
                    title: copyText('token.review.proposal'),
                    confirm: copyText('token.submit.proposal'),
                    success: copyText('token.proposal.created'),
                    reference: handle,
                    content: (
                      <Details
                        items={[
                          [copyText('token.kind'), kind],
                          [copyText('token.body'), proposalBody],
                          [copyText('token.opens'), opens || copyText('token.service.policy')],
                          [copyText('token.closes'), closes || copyText('token.service.policy')],
                        ]}
                      />
                    ),
                    run: () =>
                      api.mutate(
                        'token',
                        'createProposal',
                        {
                          kind,
                          body,
                          handle,
                          ...(opensAt ? { opensAt } : {}),
                          ...(closesAt ? { closesAt } : {}),
                        },
                        proposalSchema.refine(
                          (proposal) =>
                            proposal.kind === kind &&
                            proposal.authorId === author &&
                            proposalTerms(proposal.body) === terms &&
                            (!opensAt || Date.parse(proposal.opensAt) === Date.parse(opensAt)) &&
                            (!closesAt || Date.parse(proposal.closesAt) === Date.parse(closesAt)),
                        ),
                      ),
                    done: () => {
                      if (createAttempt.current?.handle === handle) createAttempt.current = null;
                      proposals.reload();
                    },
                  });
                }}
              >
                <Select
                  label={copyText('token.proposal.kind')}
                  value={kind}
                  onChange={setKind}
                  options={['curriculum', 'fee_param', 'listing', 'grant']}
                />
                <TextArea label={copyText('token.proposal.body.as.json.object')} value={proposalBody} onChange={setProposalBody} />
                <Field
                  label={copyText('token.opens.at.optional')}
                  type="datetime-local"
                  value={opens}
                  onChange={(e) => setOpens(e.target.value)}
                />
                <Field
                  label={copyText('token.closes.at.optional')}
                  type="datetime-local"
                  value={closes}
                  onChange={(e) => setCloses(e.target.value)}
                />
                {validation && <p role="alert">{validation}</p>}
                <Button type="submit" disabled={action.disabled || !proposalBody.trim()}>
                  <Text k="token.review.proposal" />
                </Button>
              </form>
            </Panel>
          </details>
        </div>
      ) : (
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
          <EmissionEpoch />
          <Panel title={copyText('token.economy.boundaries')}>
            <p>
              <Text k="token.emission.buyback.and.revenue.distribution.windows.are" />
            </p>
            <p>
              <Text k="token.the.customer.api.publishes.no.personal.yield" />
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
    <div data-testid="token-ballot-context" className="token-ballot-context">
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
  const { hideBalances } = usePreferences();
  const [now, setNow] = useState(Date.now);
  const [preflight, setPreflight] = useState<{
    detail: Resource<z.infer<ReturnType<typeof proposalDetailSchema>>>;
    stake: Resource<{ staked: string }>;
  } | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const detail = useResource(
    (signal) => api.query('token', 'getProposal', { proposalId: id }, proposalDetailSchema(id), { signal }),
    `proposal:${userId}:${id}`,
  );
  const stake = useResource(
    (signal) => api.query('token', 'stakeOf', undefined, z.object({ staked: decimalSchema }), { signal }),
    `vote-stake:${userId}:${id}`,
  );
  const blocked = ballot.status === 'unreadable' || (ballot.status === 'ready' && ballot.data.status === 'unknown');
  const detailView = preflight?.detail ?? detail.resource,
    stakeView = preflight?.stake ?? stake.resource;
  function refresh() {
    setPreflight(null);
    detail.reload();
    stake.reload();
  }
  function stageVote(p: z.infer<ReturnType<typeof proposalDetailSchema>>, choice: VoteChoice) {
    if (
      !userId ||
      action.disabled ||
      blocked ||
      !activeWindow(p, Date.now()) ||
      stakeView.status !== 'ready' ||
      parseAmount(stakeView.data.staked) <= 0n
    )
      return;
    const actor = userId,
      estimate = stakeView.data.staked;
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
              [G.t('stakeEstimate'), currentPreferences().hideBalances ? G.t('hidden') : displayAmount(estimate)],
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
        setPreflight({ detail: { status: 'loading' }, stake: { status: 'loading' } });
        const [fresh, currentStake] = await Promise.all([
          api.query('token', 'getProposal', { proposalId: id }, proposalDetailSchema(id)),
          api.query('token', 'stakeOf', undefined, z.object({ staked: decimalSchema })),
        ]);
        if (!canDispatch() || !api.canWrite()) return refuseBeforeDispatch(governanceRefusal('aborted', 'changed'));
        setPreflight({
          detail: fresh.ok ? { status: 'ready', data: fresh.data } : { status: 'failed', failure: fresh },
          stake: currentStake.ok ? { status: 'ready', data: currentStake.data } : { status: 'failed', failure: currentStake },
        });
        if (!fresh.ok) return refuseBeforeDispatch(fresh);
        if (!currentStake.ok) return refuseBeforeDispatch(currentStake);
        if (!activeWindow(fresh.data, Date.now())) return refuseBeforeDispatch(governanceRefusal('error', 'inactive'));
        if (reviewedProposal(fresh.data) !== reviewed) return refuseBeforeDispatch(governanceRefusal('error', 'changed'));
        if (parseAmount(currentStake.data.staked) <= 0n) return refuseBeforeDispatch(governanceRefusal('forbidden', 'noWeight'));
        // No await separates the final identity guard and dispatch.
        const result = await api.mutate(
          'token',
          'castVote',
          { proposalId: id, choice },
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
              <pre data-testid="token-proposal-body" className="token-proposal-body" lang="und">
                {JSON.stringify(p.body, null, 2)}
              </pre>
            </section>
            <section className="token-proposal-section">
              <h3>{G.t('tally')}</h3>
              <dl data-testid="token-tally" className="token-tally">
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
              <Read resource={stakeView} retry={refresh}>
                {(s) => (
                  <>
                    <Details items={[[G.t('stakeEstimate'), hideBalances ? G.t('hidden') : displayAmount(s.staked)]]} />
                    <p className="muted">
                      {G.t('unit')} {G.t('weightBoundary')}
                    </p>
                  </>
                )}
              </Read>
              {!activeWindow(p, now) && (
                <p role="status" className="muted">
                  {G.t('inactive')}
                </p>
              )}
              {stakeView.status === 'ready' && parseAmount(stakeView.data.staked) === 0n && (
                <p role="status" className="muted">
                  {G.t('noWeight')}
                </p>
              )}
              <div className="actions">
                {choiceSchema.options.map((choice) => (
                  <Button
                    key={choice}
                    variant="secondary"
                    disabled={
                      action.disabled ||
                      blocked ||
                      !activeWindow(p, now) ||
                      stakeView.status !== 'ready' ||
                      parseAmount(stakeView.data.staked) <= 0n
                    }
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
