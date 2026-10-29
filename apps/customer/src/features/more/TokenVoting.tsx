// hand-declared-ok: svc-token's governance outputs are declared in its router; packages/contracts has no token schemas yet
import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { decimalSchema, displayAmount } from '../../shared/money';
import type { ApiResult } from '../../shared/api';
import { usePreferences } from '../../shared/preferences';
import { Button, DataTable, EmptyState } from '../../shared/ui';
import { Details, Limit, Read } from './common';
import { tokenVotingCopy } from './token-voting-copy';

/**
 * MC-token-03 in the proposal pane: the voting power fixed when a proposal was created, its history, who may vote,
 * and the ballot for the voting types other than for/against/abstain. The signed-vote control stays visible with the
 * service's typed unavailable reply until a wallet link exists.
 */

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type T = ReturnType<typeof tokenVotingCopy.forLocale>['t'];

export const VOTING_TYPES = ['basic', 'single_choice', 'approval', 'weighted', 'quadratic', 'ranked_choice'] as const;
export type VotingType = (typeof VOTING_TYPES)[number];
/** The service caps a history page at 200 and refuses a blank page size. */
const HISTORY_PAGE = 20;
const HISTORY_CAP = 200;

const iso = z.string().datetime({ offset: true });
const powerSchema = z.object({
  proposalId: z.string().min(1).max(512),
  power: decimalSchema,
  reason: z.enum(['no_stake_at_creation', 'not_measured']).nullable(),
  takenAt: iso.nullable(),
  rule: z.object({ minPower: decimalSchema.nullable(), code: z.string().nullable() }),
  signing: z.object({ available: z.literal(false), code: z.literal('token.signed_vote_unavailable') }),
});
const historySchema = z.array(
  z.object({ proposalId: z.string().min(1).max(512), title: z.string().nullable(), takenAt: iso, power: decimalSchema }),
);
export const choiceTallySchema = z.object({
  totals: z.array(decimalSchema),
  abstainWeight: decimalSchema,
  participatingWeight: decimalSchema,
  voterCount: z.number().int().nonnegative(),
  ranking: z.array(z.number().int().nonnegative()),
  rounds: z.array(z.array(decimalSchema)).nullable(),
});
type ChoiceTally = z.infer<typeof choiceTallySchema>;
const ballotSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('abstain') }),
  z.object({ kind: z.literal('pick'), choices: z.array(z.number().int().nonnegative()) }),
  z.object({
    kind: z.literal('split'),
    parts: z.array(z.object({ choice: z.number().int().nonnegative(), bps: z.number().int().positive() })),
  }),
]);
type BallotWire = z.infer<typeof ballotSchema>;
const castSchema = z.object({
  id: z.string().guid(),
  proposalId: z.string().min(1).max(512),
  userId: z.string().guid(),
  weight: decimalSchema,
  choice: z.enum(['for', 'against', 'abstain']).nullable(),
  ballot: ballotSchema.nullable(),
  castAt: iso,
});

function useWords(): T {
  const { language } = usePreferences();
  return tokenVotingCopy.forLocale(language).t;
}

function utc(at: string) {
  return new Date(at).toISOString().replace('T', ' · ').replace('Z', ' UTC');
}

function ruleWords(rule: z.infer<typeof powerSchema>['rule'], t: T, hide: boolean): string {
  if (rule.minPower !== null) return t('ruleMin', { min: hide ? t('hidden') : displayAmount(rule.minPower) });
  return rule.code === 'token.vote_rule_unset' ? t('ruleUnset') : t('ruleUnreadable');
}

/** The signed account's power on one proposal, who may vote, and its stored power over time. */
export function VotingPower({ proposalId, version }: { proposalId: string; version: number }) {
  const api = useApi(),
    { userId } = useSession(),
    t = useWords(),
    { hideBalances } = usePreferences();
  const [limit, setLimit] = useState(HISTORY_PAGE);
  const power = useResource(
    (signal) => api.query('token', 'votingPower.ofProposal', { proposalId }, powerSchema, { signal }),
    `voting-power:${userId}:${proposalId}:${version}`,
  );
  const history = useResource(
    (signal) => api.query('token', 'votingPower.history', { limit }, historySchema, { signal }),
    `voting-power-history:${userId}:${limit}:${version}`,
  );
  return (
    <section className="token-proposal-section" aria-label={t('power')}>
      <h3>{t('power')}</h3>
      <Read resource={power.resource} retry={power.reload}>
        {(p) => (
          <>
            <Details
              items={[
                [t('powerValue'), hideBalances ? t('hidden') : displayAmount(p.power)],
                [t('rule'), ruleWords(p.rule, t, hideBalances)],
              ]}
            />
            <p role="note" data-testid="voting-power-basis">
              {p.reason === null && p.takenAt
                ? t('fixedOn', { at: utc(p.takenAt) })
                : p.reason === 'not_measured'
                  ? t('notMeasured')
                  : t('noStake')}
            </p>
          </>
        )}
      </Read>
      <h4>{t('history')}</h4>
      <Read resource={history.resource} retry={history.reload}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState title={t('historyEmpty')} />
          ) : (
            <>
              <p className="muted">{t('historyNote')}</p>
              <DataTable label={t('history')} headers={[t('hProposal'), t('hFixed'), t('hPower')]}>
                {rows.map((row) => (
                  <tr key={row.proposalId} data-proposal-id={row.proposalId}>
                    <td lang={row.title ? 'und' : undefined}>{row.title ?? t('untitled')}</td>
                    <td>
                      <time dateTime={row.takenAt} lang="zxx">
                        {utc(row.takenAt)}
                      </time>
                    </td>
                    <td>{hideBalances ? t('hidden') : displayAmount(row.power)}</td>
                  </tr>
                ))}
              </DataTable>
              <Limit count={rows.length} limit={limit} cap={HISTORY_CAP} onChange={setLimit} />
            </>
          )
        }
      </Read>
    </section>
  );
}

/** Whole percent with up to two decimals, as basis points. Anything else is not a weight. */
export function percentToBps(raw: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

function bpsText(bps: number): string {
  const whole = Math.floor(bps / 100),
    rest = bps % 100;
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(2, '0').replace(/0$/, '')}`;
}

/**
 * The ballot a reader fills in, as the wire form. A split keeps every filled weight, even one that does not add up to
 * 100: the service is the one that refuses it, with its typed code.
 */
function ballotOf(type: VotingType, choices: readonly string[], inputs: readonly string[], picked: ReadonlySet<number>): BallotWire | null {
  if (type === 'single_choice' || type === 'approval')
    return picked.size ? { kind: 'pick', choices: [...picked].sort((a, b) => a - b) } : null;
  if (type === 'ranked_choice') {
    const ranked = choices
      .map((_, index) => ({ index, rank: inputs[index]?.trim() ? Number(inputs[index]) : null }))
      .filter((entry): entry is { index: number; rank: number } => entry.rank !== null && Number.isFinite(entry.rank));
    return ranked.length
      ? { kind: 'pick', choices: ranked.sort((a, b) => a.rank - b.rank || a.index - b.index).map((entry) => entry.index) }
      : null;
  }
  const parts = choices.flatMap((_, index) => {
    const bps = percentToBps(inputs[index] ?? '');
    return bps ? [{ choice: index, bps }] : [];
  });
  return parts.length ? { kind: 'split', parts } : null;
}

function refusalWords(failure: Refusal, t: T): string {
  if (failure.reason === 'uncertain') return t('uncertain');
  switch (failure.code) {
    case 'token.ballot_invalid':
      return t('refusedBallot');
    case 'token.vote_rule_unset':
      return t('refusedRuleUnset');
    case 'token.vote_rule_not_met':
      return t('refusedRuleNotMet');
    case 'token.no_voting_weight':
      return t('refusedNoWeight');
    case 'token.already_voted':
      return t('refusedAlready');
    case 'token.signed_vote_unavailable':
      return t('refusedSigned');
    case 'token.proposal_not_open':
    case 'token.proposal_window':
      return t('refusedClosed');
    default:
      return t('refusedOther', { message: failure.message });
  }
}

/** The ballot of an approval, weighted, quadratic, ranked or single-choice proposal. */
export function ChoiceBallot({
  proposalId,
  votingType,
  choices,
  open,
  version,
  onCast,
}: {
  proposalId: string;
  votingType: Exclude<VotingType, 'basic'>;
  choices: readonly string[];
  open: boolean;
  version: number;
  onCast: () => void;
}) {
  const api = useApi(),
    { userId } = useSession(),
    t = useWords(),
    { hideBalances } = usePreferences();
  const [inputs, setInputs] = useState<string[]>(() => choices.map(() => ''));
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: true; weight: string } | { ok: false; failure: Refusal } | null>(null);
  const signing = useResource(
    (signal) => api.query('token', 'votingPower.ofProposal', { proposalId }, powerSchema, { signal }),
    `voting-signing:${userId}:${proposalId}:${version}`,
  );
  const split = votingType === 'weighted' || votingType === 'quadratic';
  const sum = split ? inputs.reduce((total, raw) => total + (percentToBps(raw) ?? 0), 0) : 0;
  const ballot = ballotOf(votingType, choices, inputs, picked);
  const message = JSON.stringify({ proposalId, ballot: ballot ?? null });

  async function cast(wire: BallotWire) {
    setBusy(true);
    setOutcome(null);
    const result = await api.mutate(
      'token',
      'castVote',
      { proposalId, ballot: wire },
      castSchema.refine((vote) => vote.proposalId === proposalId && vote.userId === userId),
    );
    setBusy(false);
    setOutcome(result.ok ? { ok: true, weight: result.data.weight } : { ok: false, failure: result });
    if (result.ok || result.reason === 'uncertain') onCast();
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (ballot) void cast(ballot);
  }
  const intro =
    votingType === 'single_choice'
      ? t('pickOne')
      : votingType === 'approval'
        ? t('pickAny')
        : votingType === 'ranked_choice'
          ? t('rankChoices')
          : votingType === 'quadratic'
            ? t('splitQuadratic')
            : t('splitWeights');
  return (
    <form aria-label={t('ballot')} onSubmit={submit} className="token-proposal-section">
      <h3>{t('ballot')}</h3>
      <p>
        {t('ballotIntro', { type: t(votingType) })} {intro}
      </p>
      <fieldset className="token-ballot-choices" disabled={!open || busy}>
        <legend>{t(votingType)}</legend>
        {choices.map((choice, index) =>
          votingType === 'single_choice' || votingType === 'approval' ? (
            <label key={index} className="token-ballot-choice">
              <input
                type={votingType === 'single_choice' ? 'radio' : 'checkbox'}
                name={`ballot-${proposalId}`}
                checked={picked.has(index)}
                onChange={(e) =>
                  setPicked((before) => {
                    const next = votingType === 'single_choice' ? new Set<number>() : new Set(before);
                    if (e.target.checked) next.add(index);
                    else next.delete(index);
                    return next;
                  })
                }
              />
              <span lang="und">{choice}</span>
            </label>
          ) : (
            <label key={index} className="token-ballot-choice">
              <span>{split ? t('weightOf', { choice }) : t('rankOf', { choice })}</span>
              <input
                type="number"
                inputMode="decimal"
                min={split ? 0 : 1}
                max={split ? 100 : choices.length}
                step={split ? 0.01 : 1}
                value={inputs[index] ?? ''}
                onChange={(e) => setInputs((before) => before.map((value, at) => (at === index ? e.target.value : value)))}
              />
            </label>
          ),
        )}
      </fieldset>
      {split && (
        <p role="status" data-testid="ballot-sum">
          {sum === 10_000 ? t('sum', { sum: bpsText(sum) }) : t('sumBad', { sum: bpsText(sum) })}
        </p>
      )}
      <section className="token-ballot-sign" aria-label={t('message')}>
        <h4>{t('message')}</h4>
        <pre lang="zxx">{message}</pre>
        <p className="muted">{t('messageNote')}</p>
        <Button variant="secondary" disabled>
          {t('sign')}
        </Button>
        <Read resource={signing.resource} retry={signing.reload}>
          {(p) => (
            <p role="note" data-testid="signed-vote-reply">
              {t('signUnavailable', { code: p.signing.code })}
            </p>
          )}
        </Read>
      </section>
      <div className="actions">
        <Button type="submit" disabled={!open || busy || !ballot}>
          {t('cast')}
        </Button>
        <Button variant="secondary" disabled={!open || busy} onClick={() => void cast({ kind: 'abstain' })}>
          {t('abstain')}
        </Button>
      </div>
      {outcome?.ok && <p role="status">{t('recorded', { weight: hideBalances ? t('hidden') : displayAmount(outcome.weight) })}</p>}
      {outcome && !outcome.ok && <p role="alert">{refusalWords(outcome.failure, t)}</p>}
    </form>
  );
}

/** Totals per choice, best first by the service's ranking. Quadratic totals are square roots of base units. */
export function ChoiceTallyView({
  choices,
  tally,
  closedRanked,
}: {
  choices: readonly string[];
  tally: ChoiceTally;
  closedRanked: boolean;
}) {
  const t = useWords();
  const rankOf = new Map(tally.ranking.map((choice, position) => [choice, position + 1]));
  return (
    <section className="token-proposal-section" aria-label={t('choiceTally')}>
      <h3>{t('choiceTally')}</h3>
      <DataTable label={t('choiceTally')} headers={[t('hChoice'), t('hTotal'), t('hRank')]}>
        {choices.map((choice, index) => (
          <tr key={index}>
            <td lang="und">{choice}</td>
            <td>{tally.totals[index] ?? '0'}</td>
            <td>{rankOf.get(index) ?? '–'}</td>
          </tr>
        ))}
      </DataTable>
      <Details
        items={[
          [t('abstainWeight'), tally.abstainWeight],
          [t('voters'), String(tally.voterCount)],
        ]}
      />
      {tally.rounds && <p className="muted">{t('rounds', { count: String(tally.rounds.length) })}</p>}
      {closedRanked && <p role="status">{t('closedRanked')}</p>}
    </section>
  );
}
