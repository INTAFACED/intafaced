// hand-declared-ok: svc-token's governance outputs are declared in its router; packages/contracts has no token schemas yet
import { useRef, useState, type FormEvent, type MutableRefObject, type ReactNode } from 'react';
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { decimalSchema, parseAmount } from '../../shared/money';
import type { ApiResult } from '../../shared/api';
import { usePreferences } from '../../shared/preferences';
import { Button, DataTable, EmptyState, Field, Panel } from '../../shared/ui';
import { Details, Limit, Read, Select, TextArea } from './common';
import { governanceRoomCopy } from './governance-room-copy';
import { VOTING_TYPES } from './TokenVoting';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type T = ReturnType<typeof governanceRoomCopy.forLocale>['t'];

const KINDS = ['listing', 'fee_param', 'curriculum', 'grant'] as const;
const STATUSES = ['draft', 'open', 'passed', 'rejected', 'executed', 'cancelled', 'closed_ranked'] as const;
/** The first page of the newest proposals, and the most a reader may widen it to. The service refuses a blank page size. */
const PAGE = 50;
const PAGE_CAP = 200;

const iso = z.string().datetime({ offset: true });
const proposalSchema = z.object({
  id: z.string().min(1).max(512),
  kind: z.enum(KINDS),
  status: z.enum(STATUSES),
  opensAt: iso,
  closesAt: iso,
  createdAt: iso,
  title: z.string().nullable(),
  bodyMd: z.string().nullable(),
  authorId: z.string().nullable(),
  /** Set when a governance moderator, admin or controller cancelled it. Its votes stay. */
  cancel: z.object({ reason: z.string(), at: iso }).nullable(),
  counts: z.object({
    votes: z.number().int().nonnegative(),
    for: z.number().int().nonnegative(),
    against: z.number().int().nonnegative(),
    abstain: z.number().int().nonnegative(),
  }),
});
type Proposal = z.infer<typeof proposalSchema>;
const accessCode = z.enum([
  'token.proposer_rule_unset',
  'token.proposal_limit_unset',
  'token.proposal_not_allowed',
  'token.proposal_limit_reached',
]);
const homeSchema = z.object({
  spaceId: z.string(),
  following: z.boolean(),
  proposal: z.object({ code: accessCode.nullable(), minStake: decimalSchema.nullable() }),
});
type Home = z.infer<typeof homeSchema>;
const followSchema = z.object({ spaceId: z.string(), following: z.boolean() });
const delegationSchema = z.object({ delegateeUserId: z.null(), blocker: z.literal('no_chain_service') });
const treasurySchema = z.object({
  minted: decimalSchema.nullable(),
  burned: decimalSchema,
  bought: decimalSchema.nullable(),
  toRewards: decimalSchema.nullable(),
  distributed: decimalSchema.nullable(),
  lastBuyback: z.object({ bought: decimalSchema, burned: decimalSchema, toRewards: decimalSchema, executedAt: iso }).nullable(),
});

/** A UTC minute for a service timestamp; the `datetime` attribute keeps the exact value. */
function When({ at }: { at: string }) {
  return <time dateTime={at}>{`${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`}</time>;
}
/** A `datetime-local` value as the instant it names in this browser, or undefined when blank. */
const instant = (local: string) => (local ? new Date(local).toISOString() : undefined);
/** An ISO instant as a `datetime-local` value in this browser. */
function localValue(at: string) {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Plain words for a refused proposal or delegation. The service's typed code picks the sentence; prose is a fallback. */
function refusalWords(failure: Refusal, t: T, editing = false): string {
  if (failure.reason === 'uncertain') return t('uncertain');
  switch (failure.code) {
    case 'token.proposal_not_allowed':
      // On an edit the same code means the account is not the proposal's author.
      return editing ? t('refusedNotAuthor') : t('refusedBelowRule');
    case 'token.proposer_rule_unset':
      return t('refusedRuleUnset');
    case 'token.proposal_limit_unset':
      return t('refusedLimitUnset');
    case 'token.proposal_limit_reached':
      return t('refusedLimitReached');
    case 'token.proposal_not_editable':
      return t('refusedNotEditable');
    case 'token.delegation_unavailable':
      return t('refusedDelegation');
    case 'token.delegation_delegatee_unset':
      return t('refusedDelegateeUnset');
    case 'token.delegation_delegatee_invalid':
      return t('refusedDelegateeInvalid');
    case 'token.ballot_invalid':
      return t('refusedBallot');
    case 'token.voting_type_unsupported':
      return t('refusedVotingType');
    case 'token.proposal_window_unset':
      return t('refusedWindowUnset');
    case 'token.permission_denied':
      return t('refusedPermission');
    case 'token.cancel_reason_invalid':
      return t('refusedCancelReason');
    case 'token.proposal_not_cancellable':
      return t('refusedNotCancellable');
    default:
      return t('refusedOther', { message: failure.message });
  }
}

/** What the proposer rule says about this account, before anything is submitted. */
function accessNote(access: Home['proposal'], t: T): string {
  switch (access.code) {
    case null:
      return t('canPropose');
    case 'token.proposal_not_allowed':
      return access.minStake ? t('belowRule', { minStake: access.minStake }) : t('notListed');
    case 'token.proposer_rule_unset':
      return t('ruleUnset');
    case 'token.proposal_limit_unset':
      return t('limitUnset');
    case 'token.proposal_limit_reached':
      return t('limitReached');
  }
}

/** This room's words in the reader's language. */
function useWords(): T {
  const { language } = usePreferences();
  return governanceRoomCopy.forLocale(language).t;
}

/**
 * Token governance (MC-token-01, MC-token-04), drawn inside the Token room's Governance tab: the IFC space with follow,
 * the proposal list with status, kind and text search, the proposer rule before submit, drafts with a future opening
 * time and their edit, delegation with its Protocol blocker, and the treasury figures exactly as svc-token reports them.
 * Nothing here moves value. Reading and voting on one proposal stays with the tab's selected-proposal pane.
 */
export function GovernanceSpace() {
  const t = useWords();
  const api = useApi();
  const { userId } = useSession();
  const home = useResource((signal) => api.query('token', 'governanceHome', undefined, homeSchema, { signal }), `gov-home:${userId}`);
  return (
    <Panel title={t('space')} aria-label={t('space')}>
      <Read resource={home.resource} retry={home.reload}>
        {(h) => <SpaceCard home={h} t={t} onChanged={home.reload} />}
      </Read>
    </Panel>
  );
}

/** The proposal list. `onInspect` opens a row in the tab's selected-proposal pane, under `inspectLabel`'s name. */
export function GovernanceProposals({
  selectedId,
  onInspect,
  inspectLabel,
}: {
  selectedId: string | null;
  onInspect: (id: string) => void;
  inspectLabel: (id: string) => string;
}) {
  const t = useWords();
  const api = useApi();
  const { userId } = useSession();
  const [status, setStatus] = useState('all');
  const [kind, setKind] = useState('all');
  const [q, setQ] = useState('');
  const [composing, setComposing] = useState(false);
  const [editing, setEditing] = useState<Proposal | null>(null);
  const [cancelling, setCancelling] = useState<Proposal | null>(null);
  const [limit, setLimit] = useState(PAGE);
  // The create request's retry handle lives here, not in the form, so closing and reopening the form after no answer
  // still resends under the same handle. Changed content is a new request with a new handle.
  const attempt = useRef<{ request: string; handle: string } | null>(null);
  const home = useResource((signal) => api.query('token', 'governanceHome', undefined, homeSchema, { signal }), `gov-home:${userId}`);
  const list = useResource(
    (signal) =>
      api.query(
        'token',
        'listProposals',
        { limit, ...(status !== 'all' ? { status } : {}), ...(kind !== 'all' ? { kind } : {}), ...(q.trim() ? { q: q.trim() } : {}) },
        z.array(proposalSchema).max(limit),
        { signal },
      ),
    `gov-list:${userId}:${status}:${kind}:${q.trim()}:${limit}`,
  );
  const filtered = status !== 'all' || kind !== 'all' || q.trim() !== '';
  return (
    <Panel
      title={t('proposals')}
      actions={
        <Button variant="secondary" onClick={() => setComposing((open) => !open)} aria-expanded={composing}>
          {t('newProposal')}
        </Button>
      }
    >
      {composing && (
        <ProposalForm
          t={t}
          access={home.resource.status === 'ready' ? home.resource.data.proposal : null}
          attempt={attempt}
          onDone={() => {
            list.reload();
            home.reload();
          }}
          onClose={() => setComposing(false)}
        />
      )}
      {editing && (
        <ProposalForm key={editing.id} t={t} editing={editing} access={null} onDone={list.reload} onClose={() => setEditing(null)} />
      )}
      {cancelling && (
        <CancelForm key={cancelling.id} t={t} proposal={cancelling} onDone={list.reload} onClose={() => setCancelling(null)} />
      )}
      <div className="more-toolbar">
        <Select
          label={t('status')}
          value={status}
          onChange={setStatus}
          options={[{ value: 'all', label: t('all') }, ...STATUSES.map((s) => ({ value: s, label: t(s) }))]}
        />
        <Select
          label={t('kind')}
          value={kind}
          onChange={setKind}
          options={[{ value: 'all', label: t('all') }, ...KINDS.map((k) => ({ value: k, label: t(k) }))]}
        />
        <Field label={t('search')} type="search" value={q} onChange={(e) => setQ(e.target.value)} maxLength={200} />
      </div>
      <Read resource={list.resource} retry={list.reload}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState title={filtered ? t('emptyFiltered') : t('emptyAll')} />
          ) : (
            <>
              <p data-testid="proposals-count">{t('count', { count: String(rows.length), limit: String(limit) })}</p>
              <DataTable label={t('proposals')} headers={[t('hTitle'), t('hKind'), t('hStatus'), t('hVoting'), t('hVotes'), t('hActions')]}>
                {rows.map((row) => (
                  <tr key={row.id} data-proposal-id={row.id}>
                    <td>{row.title ?? t('untitled')}</td>
                    <td>{t(row.kind)}</td>
                    <td>
                      {t(row.status)}
                      {row.cancel ? (
                        <>
                          <br />
                          <small data-testid="proposal-cancel-reason">{t('cancelled_reason', { reason: row.cancel.reason })}</small>
                        </>
                      ) : null}
                    </td>
                    <td data-testid="proposal-voting-dates">
                      <When at={row.opensAt} /> – <When at={row.closesAt} />
                    </td>
                    <td data-testid="proposal-votes">
                      {t('votes', {
                        votes: String(row.counts.votes),
                        for: String(row.counts.for),
                        against: String(row.counts.against),
                        abstain: String(row.counts.abstain),
                      })}
                    </td>
                    <td>
                      <div className="more-inline">
                        <Button
                          variant="ghost"
                          aria-label={inspectLabel(row.id)}
                          aria-pressed={selectedId === row.id}
                          aria-controls="token-selected-proposal"
                          onClick={() => onInspect(row.id)}
                        >
                          {t('inspect')}
                        </Button>
                        {row.status === 'draft' && row.authorId === userId ? (
                          <Button variant="ghost" onClick={() => setEditing(row)}>
                            {t('edit')}
                          </Button>
                        ) : null}
                        {row.status === 'draft' || row.status === 'open' ? (
                          <Button
                            variant="ghost"
                            aria-label={t('cancelFor', { title: row.title ?? t('untitled') })}
                            onClick={() => setCancelling(row)}
                          >
                            {t('cancel')}
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </DataTable>
              <Limit count={rows.length} limit={limit} cap={PAGE_CAP} onChange={setLimit} />
            </>
          )
        }
      </Read>
    </Panel>
  );
}

function SpaceCard({ home, t, onChanged }: { home: Home; t: T; onChanged: () => void }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Refusal | null>(null);
  // A follow press always asks to follow: pressing it again (or from a page that was out of date) changes nothing.
  async function follow() {
    setBusy(true);
    setFailure(null);
    const result = await api.mutate('token', 'followSpace', { following: true }, followSchema);
    setBusy(false);
    if (!result.ok) setFailure(result);
    onChanged();
  }
  return (
    <>
      <Details items={[[t('space'), t('spaceName')]]} />
      <p>{t('spaceBody')}</p>
      <Button
        variant={home.following ? 'secondary' : 'primary'}
        aria-pressed={home.following}
        disabled={busy}
        onClick={() => void follow()}
      >
        {home.following ? t('following') : t('follow')}
      </Button>
      <p>
        <small>{t('followHint')}</small>
      </p>
      {failure && <p role="alert">{refusalWords(failure, t)}</p>}
    </>
  );
}

function ProposalForm({
  t,
  access,
  attempt,
  editing,
  onDone,
  onClose,
}: {
  t: T;
  access: Home['proposal'] | null;
  attempt?: MutableRefObject<{ request: string; handle: string } | null>;
  editing?: Proposal;
  onDone: () => void;
  onClose: () => void;
}) {
  const api = useApi();
  const [kind, setKind] = useState<string>(editing?.kind ?? '');
  const [votingType, setVotingType] = useState<string>('basic');
  const [choices, setChoices] = useState('');
  const [title, setTitle] = useState(editing?.title ?? '');
  const [body, setBody] = useState(editing?.bodyMd ?? '');
  const [discussion, setDiscussion] = useState('');
  const [opens, setOpens] = useState(editing ? localValue(editing.opensAt) : '');
  const [closes, setCloses] = useState(editing ? localValue(editing.closesAt) : '');
  const { userId } = useSession();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: true } | { ok: false; failure: Refusal } | null>(null);
  const name = editing ? t('editProposal') : t('newProposal');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setOutcome(null);
    if (editing) {
      // Only a window field the author changed is sent: the fields show the minute, the stored window may hold seconds.
      const window = {
        opensAt: opens !== localValue(editing.opensAt) ? instant(opens) : undefined,
        closesAt: closes !== localValue(editing.closesAt) ? instant(closes) : undefined,
      };
      const result = await api.mutate('token', 'editProposal', { proposalId: editing.id, title, bodyMd: body, ...window }, proposalSchema);
      setBusy(false);
      setOutcome(result.ok ? { ok: true } : { ok: false, failure: result });
      if (result.ok || result.reason === 'uncertain') onDone();
      return;
    }
    const window = { opensAt: instant(opens), closesAt: instant(closes) };
    // One retry handle per request: a resend after no answer returns the stored proposal instead of a second one.
    const choiceList = votingType === 'basic' ? undefined : choices.split('\n').filter((line) => line.trim() !== '');
    const request = JSON.stringify([
      kind,
      votingType,
      choiceList ?? null,
      title,
      body,
      discussion,
      window.opensAt ?? null,
      window.closesAt ?? null,
    ]);
    if (attempt && attempt.current?.request !== request) attempt.current = { request, handle: `proposal-form:${userId}:${Date.now()}` };
    const handle = attempt?.current?.handle ?? `proposal-form:${userId}:${Date.now()}`;
    const result = await api.mutate(
      'token',
      'createProposal',
      {
        kind,
        body: {},
        handle,
        title,
        bodyMd: body,
        ...(votingType !== 'basic' ? { votingType, choices: choiceList } : {}),
        ...(discussion ? { discussionLink: discussion } : {}),
        ...window,
      },
      proposalSchema,
    );
    setBusy(false);
    setOutcome(result.ok ? { ok: true } : { ok: false, failure: result });
    if (result.ok && attempt?.current?.handle === handle) attempt.current = null;
    if (result.ok || result.reason === 'uncertain') onDone();
  }
  return (
    <form aria-label={name} onSubmit={(e) => void submit(e)} className="more-grid">
      <h3>{name}</h3>
      {access && <p role="note">{accessNote(access, t)}</p>}
      {!editing && (
        <label className="field">
          <span>{t('kind')}</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)} required>
            <option value="">{t('chooseKind')}</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(k)}
              </option>
            ))}
          </select>
        </label>
      )}
      {!editing && (
        <label className="field">
          <span>{t('votingType')}</span>
          <select value={votingType} onChange={(e) => setVotingType(e.target.value)}>
            {VOTING_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(type)}
              </option>
            ))}
          </select>
        </label>
      )}
      {!editing && votingType !== 'basic' && (
        <>
          <TextArea label={t('choices')} value={choices} onChange={setChoices} />
          <p className="muted">{t('choicesHint')}</p>
        </>
      )}
      <Field label={t('title')} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required />
      <TextArea label={t('body')} value={body} onChange={setBody} />
      {!editing && <Field label={t('discussion')} type="url" value={discussion} onChange={(e) => setDiscussion(e.target.value)} />}
      <div className="more-inline">
        <Field label={t('opens')} type="datetime-local" value={opens} onChange={(e) => setOpens(e.target.value)} hint={t('windowHint')} />
        <Field label={t('closes')} type="datetime-local" value={closes} onChange={(e) => setCloses(e.target.value)} />
      </div>
      <div className="more-toolbar">
        <Button type="submit" disabled={busy}>
          {editing ? t('save') : t('submit')}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t('close')}
        </Button>
      </div>
      {outcome?.ok && <p role="status">{editing ? t('saved') : t('created')}</p>}
      {outcome && !outcome.ok && <p role="alert">{refusalWords(outcome.failure, t, Boolean(editing))}</p>}
    </form>
  );
}

/**
 * Cancel one draft or open proposal with a reason (MC-token-02). Every signed-in member sees it; svc-token decides who may
 * (a governance moderator, admin or controller) and refuses anyone else with a typed code. Its votes stay.
 */
function CancelForm({ t, proposal, onDone, onClose }: { t: T; proposal: Proposal; onDone: () => void; onClose: () => void }) {
  const api = useApi();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: true } | { ok: false; failure: Refusal } | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setOutcome(null);
    const result = await api.mutate('token', 'governance.cancel', { proposalId: proposal.id, reason }, proposalSchema);
    setBusy(false);
    setOutcome(result.ok ? { ok: true } : { ok: false, failure: result });
    if (result.ok || result.reason === 'uncertain') onDone();
  }
  const name = t('cancelFor', { title: proposal.title ?? t('untitled') });
  return (
    <form aria-label={name} onSubmit={(e) => void submit(e)} className="more-grid">
      <h3>{name}</h3>
      <p role="note">{t('cancelNote')}</p>
      <TextArea label={t('cancelReason')} value={reason} onChange={setReason} />
      <p className="muted">{t('cancelReasonHint')}</p>
      <div className="more-toolbar">
        <Button type="submit" variant="danger" disabled={busy}>
          {t('cancelSubmit')}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t('close')}
        </Button>
      </div>
      {outcome?.ok && <p role="status">{t('cancelDone')}</p>}
      {outcome && !outcome.ok && <p role="alert">{refusalWords(outcome.failure, t)}</p>}
    </form>
  );
}

export function GovernanceDelegation() {
  const t = useWords();
  const api = useApi();
  const { userId } = useSession();
  const read = useResource(
    (signal) => api.query('token', 'delegation', undefined, delegationSchema, { signal }),
    `gov-delegation:${userId}`,
  );
  const [delegatee, setDelegatee] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Refusal | null>(null);
  async function delegate() {
    setBusy(true);
    setFailure(null);
    const result = await api.mutate('token', 'delegate', { delegateeUserId: delegatee.trim() || null }, z.unknown());
    setBusy(false);
    if (!result.ok) setFailure(result);
    read.reload();
  }
  return (
    <Panel title={t('delegation')} aria-label={t('delegation')}>
      <Read resource={read.resource} retry={read.reload}>
        {() => (
          <p data-testid="delegation-state">
            {t('delegationNone')} {t('delegationBlocked')}
          </p>
        )}
      </Read>
      <div className="more-inline">
        <Field label={t('delegatee')} value={delegatee} onChange={(e) => setDelegatee(e.target.value)} maxLength={128} />
        <Button variant="secondary" disabled={busy} onClick={() => void delegate()}>
          {t('delegate')}
        </Button>
      </div>
      {failure && <p role="alert">{refusalWords(failure, t)}</p>}
    </Panel>
  );
}

export function GovernanceTreasury() {
  const t = useWords();
  const api = useApi();
  const { userId } = useSession();
  const read = useResource((signal) => api.query('token', 'treasury', undefined, treasurySchema, { signal }), `gov-treasury:${userId}`);
  const figure = (value: string | null): ReactNode => value ?? t('notReported');
  return (
    <Panel title={t('treasury')} aria-label={t('treasury')}>
      <p>{t('treasuryBody')}</p>
      <Read resource={read.resource} retry={read.reload}>
        {(view) => (
          <dl className="more-details">
            {(
              [
                ['treasury-minted', t('minted'), figure(view.minted)],
                // A burn total of zero means no burn is recorded: it is never shown as a measured 0.
                ['treasury-burns', t('burned'), parseAmount(view.burned) === 0n ? t('noneRecorded') : view.burned],
                ['treasury-bought', t('bought'), figure(view.bought)],
                ['treasury-to-rewards', t('toRewards'), figure(view.toRewards)],
                ['treasury-distributed', t('distributed'), figure(view.distributed)],
                [
                  'treasury-last-buyback',
                  t('lastBuyback'),
                  view.lastBuyback
                    ? t('lastBuybackLine', {
                        bought: view.lastBuyback.bought,
                        burned: view.lastBuyback.burned,
                        toRewards: view.lastBuyback.toRewards,
                        at: view.lastBuyback.executedAt,
                      })
                    : t('notReported'),
                ],
              ] as const
            ).map(([id, label, value]) => (
              <div key={id}>
                <dt>{label}</dt>
                <dd data-testid={id}>{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </Read>
    </Panel>
  );
}
