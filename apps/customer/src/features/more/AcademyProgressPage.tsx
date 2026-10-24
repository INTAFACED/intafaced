import { useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import {
  academyGoalReminderSchema,
  academyGoalSchema,
  academyPlannerSchema,
  academyPlannerTodoSchema,
  academyProgressPageSchema,
  type AcademyPlanner,
  type AcademyProgressPage,
} from '@intafaced/contracts/academy-catalogue';
import type { ApiResult } from '../../shared/api';
import { usePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import { ServiceOffNotice } from '../../shared/service-off';
import { Button, EmptyState, Loading, Panel } from '../../shared/ui';
import { useApi, useSession } from '../session/session';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { formatDay } from './academy-lms';
import { AcademyRefusal, GuardedButton, ProgressBar, pathLabel } from './AcademyLmsParts';

type Failure = Extract<ApiResult<never>, { ok: false }>;

/** A decimal-string percentage with one decimal place, in the reader's number format (33,3 in French). */
export const localPercent = (value: string, language: string) =>
  new Intl.NumberFormat(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Number(value));
/** The same percentage with no trailing ".0": 80 rather than 80.0. */
const shortPercent = (value: string, language: string) =>
  new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(Number(value));

/**
 * The grades table of each authored course (AC-progress-02): one row per assignment in outline order. A grade reads
 * "8 / 10"; one never handed in reads "Not attempted", never a zero, and counts toward no average. Pure.
 */
export function CourseGradesView({ courses }: { courses: AcademyProgressPage['courseGrades'] }) {
  const { t } = copy.useCopy();
  const { language } = usePreferences();
  if (courses.length === 0) return <EmptyState title={t('cgEmpty')} />;
  return (
    <div className="academy-lms-stack">
      {courses.map((course) => (
        <div key={course.slug} className="academy-lms-card" data-course-grades={course.slug}>
          <table>
            <caption lang="und">{course.title}</caption>
            <thead>
              <tr>
                <th scope="col">{t('cgItem')}</th>
                <th scope="col">{t('cgGrade')}</th>
              </tr>
            </thead>
            <tbody>
              {course.rows.map((row) => (
                <tr key={row.itemId} data-grade-state={row.state}>
                  <td lang="und">{row.title}</td>
                  <td>
                    {row.state === 'graded'
                      ? t('cgScore', { score: row.score, possible: row.possible })
                      : row.state === 'handed_in'
                        ? t('cgHandedIn')
                        : t('cgNotAttempted')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {course.averages.length === 0 ? (
            <p className="muted">{t('cgNoAverage')}</p>
          ) : (
            course.averages.map((average) => (
              <p key={average.type} data-testid={`type-average-${average.type}`}>
                {t('cgAverage', { percent: shortPercent(average.percent, language), count: average.count })}
              </p>
            ))
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * The key that names one to-do add: the planner revision it was typed against and a hash of its text. Two devices on the
 * same revision adding different text get different keys; the same text sent again is the same add.
 */
export function todoKey(revision: number, text: string): string {
  let hash = 0x811c9dc5;
  for (const char of text.trim()) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `todo:${revision}:${hash.toString(16).padStart(8, '0')}`;
}

/**
 * `/academy/progress` (AC-progress-02): percent complete per enrolled course with a check mark per item, and the grades
 * with a chart of each quiz's best result. Both come from one read of the learner's own rows. Nothing is drawn from
 * nothing: with no attempt the grades say so in words, never as a zero chart.
 */
export function AcademyCourseProgress() {
  const api = useApi();
  const { userId } = useSession();
  const { t } = copy.useCopy();
  const progress = useResource(
    (signal) => api.query('academy', 'myProgress', undefined, academyProgressPageSchema, { signal }),
    `progress:${userId}`,
  );
  if (progress.resource.status !== 'ready')
    return (
      <Panel title={t('progressPageTitle')}>
        {progress.resource.status === 'loading' ? (
          <Loading />
        ) : (
          <AcademyRefusal failure={progress.resource.failure} retry={progress.reload} />
        )}
      </Panel>
    );
  return <ProgressPageView page={progress.resource.data} />;
}

export function ProgressPageView({ page }: { page: AcademyProgressPage }) {
  const { t } = copy.useCopy();
  const { language } = usePreferences();
  const pending = page.grades.rows.filter((row) => row.pending);
  return (
    <>
      <Panel title={t('progressPageTitle')}>
        {page.courses.length === 0 ? (
          <EmptyState title={t('progressNoCourses')} />
        ) : (
          <ul className="academy-lms-stack" data-course-progress-list="true">
            {page.courses.map((course) => (
              <li key={course.slug} className="academy-lms-card" data-course-progress={course.slug} data-percent={course.percent}>
                <strong>{pathLabel(t, course.slug)}</strong>
                <p>
                  {t('progressPercent', {
                    percent: localPercent(course.percent, language),
                    completed: course.completed,
                    visible: course.visible,
                  })}
                </p>
                <ProgressBar percent={Number(course.percent)} label={t('progressCourseLabel', { course: pathLabel(t, course.slug) })} />
                <ul className="academy-lms-rows">
                  {course.items.map((item) => (
                    <li key={item.slug} data-progress-item={item.slug} data-completed={item.completedAt !== null}>
                      <span aria-hidden="true">{item.completedAt ? '✓' : '○'}</span>
                      <span lang="und">{item.title}</span>
                      <span className="muted">
                        {item.completedAt ? (
                          <>
                            {t('progressItemDone')} <time dateTime={item.completedAt}>{formatDay(item.completedAt, language)}</time>
                          </>
                        ) : (
                          t('progressItemOpen')
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title={t('cgTitle')}>
        <CourseGradesView courses={page.courseGrades} />
      </Panel>
      <Panel title={t('gradesTitle')}>
        {page.grades.rows.length === 0 ? (
          <EmptyState title={t('gradesEmpty')} />
        ) : (
          <div className="academy-lms-stack">
            {pending.length > 0 && (
              <p className="academy-lms-result" role="status" data-grades-pending={pending.length}>
                {pending.length === 1 ? t('gradesPendingOne') : t('gradesPending', { count: pending.length })}
              </p>
            )}
            {page.grades.averages.map((average) => (
              <p key={average.type} data-grade-average={average.type}>
                {average.count === 1
                  ? t('gradesAverageQuizOne', { percent: localPercent(average.percent, language) })
                  : t('gradesAverageQuiz', { percent: localPercent(average.percent, language), count: average.count })}
              </p>
            ))}
            <ul className="academy-lms-rows" data-grade-chart="true" aria-label={t('gradesChartLabel')}>
              {page.grades.rows.map((row) => (
                <li key={row.slug} data-grade-row={row.slug} data-grade-state={row.pending ? 'pending' : row.passed ? 'passed' : 'failed'}>
                  <span lang="und">{row.title}</span>
                  {row.pending ? (
                    <span className="muted">
                      {t('gradesRowPending')} <time dateTime={row.hiddenUntil}>{formatDay(row.hiddenUntil, language)}</time>
                    </span>
                  ) : (
                    <>
                      <ProgressBar percent={Number(row.percent)} label={t('gradesBarLabel', { title: row.title })} />
                      <span>
                        {t('gradesRowScore', { score: row.score, possible: row.possible, percent: localPercent(row.percent, language) })}
                      </span>
                      <span className="academy-lms-chip" data-status={row.passed ? 'passed' : 'failed'}>
                        {row.passed ? t('resultPassed') : t('resultNotPassed')}
                      </span>
                    </>
                  )}
                  <span className="muted">{row.attempts === 1 ? t('attemptsCountOne') : t('attemptsCount', { count: row.attempts })}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>
    </>
  );
}

export type PlannerViewProps = {
  planner: AcademyPlanner;
  draft: string;
  onDraft: (text: string) => void;
  onAdd: () => void;
  onDone: (todoId: string, done: boolean) => void;
  onRemove: (todoId: string) => void;
  goalDraft: { itemsPerWeek: string; reminder: boolean };
  onGoalDraft: (draft: { itemsPerWeek: string; reminder: boolean }) => void;
  onSaveGoal: () => void;
  onSendReminder: () => void;
  busy: boolean;
  problem: Failure | null;
  goalSaved: boolean;
  reminderAnswered: boolean;
};

/** The planner (AC-progress-02), pure: to-do items and a weekly goal. Every control says why when it is off. */
export function PlannerView(props: PlannerViewProps) {
  const { t } = copy.useCopy();
  const id = useId();
  const { planner } = props;
  const addReason =
    planner.todoLimit === null
      ? t('plannerLimitUnset')
      : planner.todos.length >= planner.todoLimit
        ? t('plannerFull', { limit: planner.todoLimit })
        : props.draft.trim() === ''
          ? t('plannerNeedsText')
          : props.busy
            ? t('plannerBusy')
            : null;
  const goalNumber = Number(props.goalDraft.itemsPerWeek);
  const goalReason =
    !Number.isInteger(goalNumber) || goalNumber < 1 || goalNumber > 100 ? t('goalRange') : props.busy ? t('plannerBusy') : null;
  const reminderReason = !planner.goal?.reminder ? t('goalReminderOff') : props.busy ? t('plannerBusy') : null;
  return (
    <div className="academy-lms-stack" data-planner="true">
      <section className="academy-lms-stack" aria-label={t('plannerTodoTitle')}>
        <h4>{t('plannerTodoTitle')}</h4>
        {planner.todos.length === 0 ? (
          <p className="muted">{t('plannerTodoEmpty')}</p>
        ) : (
          <ul className="academy-lms-rows" data-todo-list="true">
            {planner.todos.map((todo) => (
              <li key={todo.id} data-todo={todo.id} data-todo-done={todo.doneAt !== null}>
                <label className="academy-lms-choice">
                  <input
                    type="checkbox"
                    checked={todo.doneAt !== null}
                    disabled={props.busy}
                    onChange={(event) => props.onDone(todo.id, event.target.checked)}
                  />
                  <span lang="und">{todo.text}</span>
                </label>
                <Button type="button" variant="secondary" disabled={props.busy} onClick={() => props.onRemove(todo.id)}>
                  {t('plannerRemove')}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="academy-lms-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (addReason === null) props.onAdd();
          }}
        >
          <label htmlFor={`${id}-todo`}>{t('plannerTodoLabel')}</label>
          <input id={`${id}-todo`} maxLength={200} value={props.draft} onChange={(event) => props.onDraft(event.target.value)} />
          <GuardedButton type="submit" reason={addReason} reasonId={`${id}-add-reason`}>
            {t('plannerAdd')}
          </GuardedButton>
        </form>
      </section>
      <section className="academy-lms-stack" aria-label={t('goalTitle')}>
        <h4>{t('goalTitle')}</h4>
        {planner.goal ? (
          <p data-goal={planner.goal.itemsPerWeek}>
            {t('goalCurrent', { items: planner.goal.itemsPerWeek, done: planner.goal.doneThisWeek })}{' '}
            {planner.goal.reminder ? t('goalReminderOn') : t('goalReminderNone')}
          </p>
        ) : (
          <p className="muted">{t('goalNone')}</p>
        )}
        <form
          className="academy-lms-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (goalReason === null) props.onSaveGoal();
          }}
        >
          <label htmlFor={`${id}-goal`}>{t('goalItemsLabel')}</label>
          <input
            id={`${id}-goal`}
            type="number"
            min={1}
            max={100}
            step={1}
            value={props.goalDraft.itemsPerWeek}
            onChange={(event) => props.onGoalDraft({ ...props.goalDraft, itemsPerWeek: event.target.value })}
          />
          <label className="academy-lms-choice">
            <input
              type="checkbox"
              checked={props.goalDraft.reminder}
              onChange={(event) => props.onGoalDraft({ ...props.goalDraft, reminder: event.target.checked })}
            />
            <span>{t('goalReminderLabel')}</span>
          </label>
          <GuardedButton type="submit" reason={goalReason} reasonId={`${id}-goal-reason`}>
            {t('goalSave')}
          </GuardedButton>
        </form>
        {props.goalSaved && (
          <p role="status" data-goal-saved="true">
            {t('goalSaved')}
          </p>
        )}
        <GuardedButton
          type="button"
          variant="secondary"
          reason={reminderReason}
          reasonId={`${id}-reminder-reason`}
          onClick={props.onSendReminder}
        >
          {t('goalSendReminder')}
        </GuardedButton>
        {props.reminderAnswered && <ServiceOffNotice code={planner.reminderMail} action={t('goalReminderMail')} role="status" />}
      </section>
      {props.problem && <AcademyRefusal failure={props.problem} />}
    </div>
  );
}

/**
 * The planner's state. Every write is followed by a read of the stored planner, so a lost reply settles by reading what
 * Academy holds; an add is named `todo:<revision>` from the last read, so sending it again returns the same item.
 */
export function AcademyPlanner() {
  const api = useApi();
  const { userId } = useSession();
  const { t } = copy.useCopy();
  const planner = useResource(
    (signal) => api.query('academy', 'planner.get', undefined, academyPlannerSchema, { signal }),
    `planner:${userId}`,
  );
  const [draft, setDraft] = useState('');
  const [goalDraft, setGoalDraft] = useState<{ itemsPerWeek: string; reminder: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Failure | null>(null);
  const [goalSaved, setGoalSaved] = useState(false);
  const [reminderAnswered, setReminderAnswered] = useState(false);
  const inFlight = useRef(false);
  // While the planner is read again after a write, the last stored planner stays on screen (no flash of Loading), the
  // controls stay off, and a ticked box shows as ticked until Academy's copy arrives.
  const last = useRef<AcademyPlanner | null>(null);
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  if (planner.resource.status === 'ready') last.current = planner.resource.data;
  useEffect(() => {
    if (planner.resource.status === 'ready') setTicked({});
  }, [planner.resource]);

  // An add whose reply was lost: sending the same text again reuses its key, so Academy returns the stored item.
  const unsent = useRef<{ text: string; key: string } | null>(null);

  const run = async (request: () => Promise<ApiResult<unknown>>, after?: () => void, refused?: () => void) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    try {
      const result = await request();
      if (result.ok) after?.();
      // A refusal is shown; an unknown outcome is settled by the read below, never by sending again with a new key.
      else if (result.reason !== 'uncertain') {
        setProblem(result);
        refused?.();
      }
      planner.reload();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const stored = planner.resource.status === 'ready' ? planner.resource.data : last.current;
  if (!stored || planner.resource.status === 'failed')
    return (
      <Panel title={t('plannerTitle')}>
        {planner.resource.status === 'failed' ? <AcademyRefusal failure={planner.resource.failure} retry={planner.reload} /> : <Loading />}
      </Panel>
    );
  const data: AcademyPlanner = {
    ...stored,
    todos: stored.todos.map((todo) =>
      todo.id in ticked ? { ...todo, doneAt: ticked[todo.id] ? (todo.doneAt ?? new Date().toISOString()) : null } : todo,
    ),
  };
  const refreshing = planner.resource.status === 'loading';
  const goal = goalDraft ?? { itemsPerWeek: data.goal ? String(data.goal.itemsPerWeek) : '', reminder: data.goal?.reminder ?? false };
  return (
    <Panel title={t('plannerTitle')}>
      <PlannerView
        planner={data}
        draft={draft}
        onDraft={setDraft}
        onAdd={() => {
          const text = draft.trim();
          const key = unsent.current?.text === text ? unsent.current.key : todoKey(data.revision, text);
          unsent.current = { text, key };
          void run(
            () => api.mutate('academy', 'planner.addTodo', { clientKey: key, text }, academyPlannerTodoSchema),
            () => {
              unsent.current = null;
              setDraft('');
            },
            () => {
              unsent.current = null;
            },
          );
        }}
        onDone={(todoId, done) => {
          setTicked((now) => ({ ...now, [todoId]: done }));
          void run(() => api.mutate('academy', 'planner.setTodoDone', { todoId, done }, academyPlannerTodoSchema));
        }}
        onRemove={(todoId) =>
          void run(() => api.mutate('academy', 'planner.removeTodo', { todoId }, z.object({ id: z.string(), removed: z.literal(true) })))
        }
        goalDraft={goal}
        onGoalDraft={(next) => {
          setGoalSaved(false);
          setGoalDraft(next);
        }}
        onSaveGoal={() =>
          void run(
            () =>
              api.mutate(
                'academy',
                'planner.setGoal',
                { itemsPerWeek: Number(goal.itemsPerWeek), reminder: goal.reminder },
                academyGoalSchema.nullable(),
              ),
            () => {
              setGoalDraft(null);
              setGoalSaved(true);
            },
          )
        }
        onSendReminder={() =>
          void run(
            () => api.mutate('academy', 'planner.sendGoalReminder', undefined, academyGoalReminderSchema),
            () => setReminderAnswered(true),
          )
        }
        busy={busy || refreshing}
        problem={problem}
        goalSaved={goalSaved}
        reminderAnswered={reminderAnswered}
      />
    </Panel>
  );
}
