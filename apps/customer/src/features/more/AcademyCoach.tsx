import { useId, useState } from 'react';
import { z } from 'zod';
import { formatNumberToParts } from '@intafaced/i18n';
import { Figure, type FigurePart } from '@intafaced/ui/lit';
import { RefusalBox, type Refusal } from '@intafaced/ui/lit/templates';
import { useApi, useSession } from '../session/session';
import { usePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import { Button } from '../../shared/ui';
import { academyCoachCopy as copy } from './academy-coach-copy';

/** The Coach's routing task (svc-agents `COACH_TASK`): its published price is the cost line shown before asking. */
const COACH_TASK = 'coach.answer';

// hand-declared-ok: svc-agents has no browser-safe schema in packages/contracts; these mirror coach.runSession and routes.list
const lessonRef = z.object({ slug: z.string().min(1), title: z.string().min(1) });
const engine = z.enum(['sandbox', 'live', 'unknown']);
const coachResult = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('answered'),
    answer: z.string(),
    citations: z.array(lessonRef).min(1),
    nextLesson: lessonRef.nullable(),
    engine,
    sessionId: z.string(),
    runKey: z.string(),
    assetId: z.string().min(1),
    charge: z.discriminatedUnion('state', [
      z.object({ state: z.literal('settled'), billedAmount: z.string() }),
      z.object({ state: z.literal('unpaid'), code: z.string() }),
    ]),
    replayed: z.boolean(),
  }),
  z.object({ status: z.literal('not_covered'), citations: z.array(z.never()).length(0) }),
  z.object({ status: z.literal('refused'), code: z.string().min(1) }),
]);
type CoachResult = z.infer<typeof coachResult>;
const routeList = z.array(
  z.object({
    task: z.string(),
    maxOutputTokens: z.number().int().positive().safe(),
    inputPerMillion: z.string().nullable(),
    outputPerMillion: z.string().nullable(),
    assetId: z.string().min(1),
    engine,
  }),
);

type CopyKey =
  | 'advice'
  | 'adviceBody'
  | 'positions'
  | 'positionsBody'
  | 'curriculumEmpty'
  | 'engineUnavailable'
  | 'priceUnset'
  | 'spendLimit'
  | 'fundsInsufficient'
  | 'replay'
  | 'scopeUnset'
  | 'personOnly'
  | 'unknownRefusal';
/** Every typed refusal the Coach run can answer with, in words. An unknown code still shows itself as the reference. */
const REFUSALS: Readonly<Record<string, { title: CopyKey; body?: CopyKey }>> = {
  'agents.advice_forbidden': { title: 'advice', body: 'adviceBody' },
  'agents.positions_not_decided': { title: 'positions', body: 'positionsBody' },
  'agents.coach_curriculum_empty': { title: 'curriculumEmpty' },
  'agents.coach_engine_unavailable': { title: 'engineUnavailable' },
  'agents.price_unset': { title: 'priceUnset' },
  'agents.spend_limit': { title: 'spendLimit' },
  'agents.funds_insufficient': { title: 'fundsInsufficient' },
  'agents.request_id_replay': { title: 'replay' },
  'agents.execute_scope_unset': { title: 'scopeUnset' },
  'agents.execute_person_only': { title: 'personOnly' },
};

/**
 * The request id is the person's business key for this exact question on this lesson: asking the same thing again,
 * or re-checking after a lost reply, looks up the stored answer instead of running and billing a second time.
 */
async function requestIdFor(lessonSlug: string | undefined, question: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${lessonSlug ?? ''}\n${question.trim()}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `coach:${Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

type Asked =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; result: CoachResult }
  | { kind: 'uncertain'; question: string }
  | { kind: 'error'; code?: string };

/**
 * The Academy Coach (J-agents-17): answers from curriculum lessons only, cites them as lesson links, and says "not
 * covered" with no citation when no lesson matches. Its cost line shows before sending; an engine that is not live
 * marks every figure TEST.
 */
export function AcademyCoach({ lessonSlug }: { lessonSlug?: string }) {
  const api = useApi();
  const { userId } = useSession();
  const { language } = usePreferences();
  const { t, Copy } = copy.useCopy();
  const fieldId = useId();
  const [question, setQuestion] = useState('');
  const [asked, setAsked] = useState<Asked>({ kind: 'idle' });
  const routes = useResource((signal) => api.query('agents', 'routes.list', undefined, routeList, { signal }), `coach-routes:${userId}`);
  const route = routes.resource.status === 'ready' ? (routes.resource.data.find((r) => r.task === COACH_TASK) ?? null) : undefined;
  const parts = (value: string, asset: string): readonly FigurePart[] => [
    ...formatNumberToParts(value, language),
    { type: 'literal', value: ' ' },
    { type: 'currency', value: asset },
  ];

  async function send(text: string) {
    setAsked({ kind: 'loading' });
    const requestId = await requestIdFor(lessonSlug, text);
    const res = await api.mutate(
      'agents',
      'coach.runSession',
      { question: text, requestId, ...(lessonSlug ? { lessonSlug } : {}) },
      coachResult,
    );
    if (res.ok) setAsked({ kind: 'done', result: res.data });
    else if (res.reason === 'uncertain' || res.reason === 'aborted') setAsked({ kind: 'uncertain', question: text });
    else if (res.reason === 'forbidden') setAsked({ kind: 'done', result: { status: 'refused', code: res.code ?? res.message } });
    else setAsked({ kind: 'error', ...(res.code ? { code: res.code } : {}) });
  }

  const refusalOf = (code: string): Refusal => {
    const words = REFUSALS[code] ?? { title: 'unknownRefusal' as const };
    return { variant: 'refused', title: t(words.title), body: words.body ? t(words.body) : t('refusedTitle'), reference: code };
  };

  return (
    <section className="academy-lms-stack" aria-labelledby={`${fieldId}-title`}>
      <h3 id={`${fieldId}-title`}>
        <Copy k="title" />
      </h3>
      <p className="muted">
        <Copy k="intro" />
      </p>
      <div aria-label={t('costTitle')} role="group">
        {route === undefined ? (
          routes.resource.status === 'loading' ? null : (
            <p className="muted">
              <Copy k="costUnread" />
            </p>
          )
        ) : route === null ? (
          <p className="muted">
            <Copy k="costMissing" />
          </p>
        ) : route.inputPerMillion === null || route.outputPerMillion === null ? (
          <p className="muted">
            <Copy k="costUnset" />
          </p>
        ) : (
          <dl data-testid="coach-cost">
            <dt>
              <Copy k="costInput" />
            </dt>
            <dd>
              <Figure size="body" parts={parts(route.inputPerMillion, route.assetId)} test={route.engine !== 'live'} />
            </dd>
            <dt>
              <Copy k="costOutput" />
            </dt>
            <dd>
              <Figure size="body" parts={parts(route.outputPerMillion, route.assetId)} test={route.engine !== 'live'} />
            </dd>
            <dd className="muted">
              <Copy k="costTokens" params={{ tokens: route.maxOutputTokens }} />
            </dd>
          </dl>
        )}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const text = question.trim();
          if (text && asked.kind !== 'loading') void send(text);
        }}
      >
        <label htmlFor={fieldId}>{t(lessonSlug ? 'question' : 'questionHub')}</label>
        <textarea id={fieldId} rows={3} maxLength={2000} value={question} onChange={(e) => setQuestion(e.target.value)} />
        <Button type="submit" disabled={!question.trim() || asked.kind === 'loading'}>
          <Copy k="ask" />
        </Button>
      </form>
      {asked.kind === 'loading' && (
        <p role="status">
          <Copy k="asking" />
        </p>
      )}
      {asked.kind === 'uncertain' && (
        <div role="alert">
          <RefusalBox refusal={{ variant: 'unreachable', title: t('uncertainTitle'), body: t('uncertainBody') }} />
          <Button variant="secondary" onClick={() => void send(asked.question)}>
            <Copy k="checkAgain" />
          </Button>
        </div>
      )}
      {asked.kind === 'error' && (
        <div role="alert">
          <RefusalBox
            refusal={{
              variant: 'unreachable',
              title: t('errorTitle'),
              body: t('uncertainBody'),
              ...(asked.code ? { reference: asked.code } : {}),
            }}
          />
        </div>
      )}
      {asked.kind === 'done' && asked.result.status === 'refused' && (
        <div role="alert" data-refusal-code={asked.result.code}>
          <RefusalBox refusal={refusalOf(asked.result.code)} />
        </div>
      )}
      {asked.kind === 'done' && asked.result.status === 'not_covered' && (
        <section aria-label={t('answerTitle')} data-coach="not-covered">
          <RefusalBox refusal={{ variant: 'parked', title: t('notCovered'), body: t('notCoveredBody') }} />
        </section>
      )}
      {asked.kind === 'done' && asked.result.status === 'answered' && <CoachAnswer result={asked.result} parts={parts} />}
    </section>
  );
}

function CoachAnswer({
  result,
  parts,
}: {
  result: Extract<CoachResult, { status: 'answered' }>;
  parts: (value: string, asset: string) => readonly FigurePart[];
}) {
  const { t, Copy } = copy.useCopy();
  const test = result.engine !== 'live';
  return (
    <section aria-label={t('answerTitle')} data-coach="answered" data-engine={result.engine}>
      <h4>
        <Copy k="answerTitle" />
      </h4>
      {result.replayed && (
        <p className="muted">
          <Copy k="answerReplayed" />
        </p>
      )}
      <p lang="und" data-coach-answer="">
        {result.answer}
      </p>
      <h5>
        <Copy k="citationsTitle" />
      </h5>
      <ul aria-label={t('citationsTitle')}>
        {result.citations.map((c) => (
          <li key={c.slug}>
            <a className="text-link" href={`/academy/${encodeURIComponent(c.slug)}`} lang="und">
              {c.title}
            </a>
          </li>
        ))}
      </ul>
      {result.nextLesson && (
        <p>
          <Copy k="nextLesson" />:{' '}
          <a className="text-link" href={`/academy/${encodeURIComponent(result.nextLesson.slug)}`} lang="und" rel="next">
            {result.nextLesson.title}
          </a>
        </p>
      )}
      {result.charge.state === 'settled' ? (
        <p data-testid="coach-billed">
          <Copy k="billed" />: <Figure size="body" parts={parts(result.charge.billedAmount, result.assetId)} test={test} />
        </p>
      ) : (
        <RefusalBox refusal={{ variant: 'account-hold', title: t('billed'), body: t('unpaid'), reference: result.charge.code }} />
      )}
    </section>
  );
}
