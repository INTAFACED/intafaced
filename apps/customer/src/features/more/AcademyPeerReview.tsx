import { useEffect, useRef, useState } from 'react';
import { academyReviewStateSchema, type AcademyReviewState, type AcademyReviewTask } from '@intafaced/contracts/academy-courses';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Loading } from '../../shared/ui';
import { useApi } from '../session/session';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { AcademyRefusal } from './AcademyLmsParts';
import { byteSize } from './AcademyAssignment';

type Failure = Extract<ApiResult<never>, { ok: false }>;
type T = (typeof copy)['t'];

/** The count line: peer reviews done of those due, the self review still to do, or all done. Pure. */
export function reviewCountLine(state: AcademyReviewState, t: T): string {
  if (state.stage === 'done') return t('rvDone');
  if (state.peer && state.peerCount !== null) return t('rvCount', { done: state.peerDone, count: state.peerCount });
  return t('rvSelfToDo');
}

/** The work under review and one radio group per criterion of its rubric. Pure but for the chosen levels. */
export function ReviewForm({
  task,
  sending,
  onSend,
}: {
  task: AcademyReviewTask;
  sending: boolean;
  onSend: (marks: (string | null)[]) => void;
}) {
  const { t } = copy.useCopy();
  const [marks, setMarks] = useState<(string | null)[]>(() => task.criteria.map(() => null));
  const self = task.kind === 'self';
  return (
    <form
      className="academy-lms-stack"
      data-testid={self ? 'review-self' : 'review-work'}
      onSubmit={(event) => {
        event.preventDefault();
        // A criterion left open is refused here by its name; the page never guesses a level.
        onSend(marks);
      }}
    >
      <strong>{self ? t('rvYourWork') : t('rvClassmate', { n: task.ordinal ?? 1 })}</strong>
      <p lang="und" style={{ whiteSpace: 'pre-wrap' }}>
        {task.text ?? t('rvNoText')}
      </p>
      {task.file && <p lang="und">{t('rvFile', { name: task.file.fileName, size: byteSize(task.file.bytes) })}</p>}
      {task.criteria.map((criterion, i) => (
        <fieldset key={criterion.name} className="academy-lms-stack">
          <legend lang="und">{criterion.name}</legend>
          <span className="academy-lms-meta">
            {criterion.levels.map((level) => (
              <label key={level}>
                <input
                  type="radio"
                  name={`${task.id}-${i}`}
                  value={level}
                  aria-label={t('rvLevel', { criterion: criterion.name, level })}
                  checked={marks[i] === level}
                  onChange={() => setMarks((all) => all.map((mark, n) => (n === i ? level : mark)))}
                />{' '}
                {level}
              </label>
            ))}
          </span>
        </fieldset>
      ))}
      <Button type="submit" variant="primary" disabled={sending}>
        {sending ? t('rvSending') : self ? t('rvSendSelf') : t('rvSend')}
      </Button>
    </form>
  );
}

/**
 * Peer and self review on an assignment's page (AC-assignments-03). Opening it asks Academy for the learner's stage,
 * which hands them a classmate's work when one is due and free; asking again hands out nothing new. Each review is sent
 * once for its task: a lost reply re-reads the stage, and the same marks sent again are answered as stored.
 */
export function AcademyPeerReview({ itemId, handedIn }: { itemId: string; handedIn: number }) {
  const api = useApi();
  const { t } = copy.useCopy();
  const view = useResource(
    (signal) => api.mutate('academy', 'peerReview', { itemId }, academyReviewStateSchema, { signal }),
    `peer-review:${itemId}:${handedIn}`,
  );
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState<Failure | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [last, setLast] = useState<AcademyReviewState | null>(null);
  const inFlight = useRef(false);
  const ready = view.resource.status === 'ready' ? view.resource.data : null;
  useEffect(() => {
    if (ready) setLast(ready);
  }, [ready]);
  const state = ready ?? last;

  if (view.resource.status === 'failed' && !state)
    return (
      <section data-testid="assignment-review" aria-label={t('rvTitle')}>
        <AcademyRefusal failure={view.resource.failure} retry={view.reload} />
      </section>
    );
  if (!state) return <Loading />;
  if (state.stage === 'off') return null;

  const send = async (task: AcademyReviewTask, chosen: (string | null)[]) => {
    if (inFlight.current) return;
    const marks = chosen.filter((mark): mark is string => mark !== null);
    if (marks.length !== chosen.length) {
      setUncertain(false);
      return setRefused({ ok: false, reason: 'error', message: 'academy.review_marks_invalid', code: 'academy.review_marks_invalid' });
    }
    inFlight.current = true;
    setSending(true);
    setRefused(null);
    setUncertain(false);
    const sent = await api.mutate('academy', 'submitPeerReview', { itemId, taskId: task.id, marks }, academyReviewStateSchema);
    inFlight.current = false;
    setSending(false);
    if (sent.ok) return setLast(sent.data);
    if (sent.reason === 'uncertain') setUncertain(true);
    else setRefused(sent);
    // What Academy stored is what the page shows.
    view.reload();
  };

  return (
    <section className="academy-lms-stack" data-testid="assignment-review" aria-label={t('rvTitle')}>
      <h3>{t('rvTitle')}</h3>
      <p role="status" data-testid="review-count">
        {reviewCountLine(state, t)}
      </p>
      {state.stage === 'hand_in_first' && <p className="muted">{t('rvHandInFirst')}</p>}
      {state.stage === 'waiting' && (
        <p className="muted" data-testid="review-waiting">
          {t('rvWaiting')}
        </p>
      )}
      {state.task && <ReviewForm key={state.task.id} task={state.task} sending={sending} onSend={(marks) => void send(state.task!, marks)} />}
      {uncertain && (
        <p role="status" className="failure">
          {t('rvUncertain')}
        </p>
      )}
      {refused && <AcademyRefusal failure={refused} />}
    </section>
  );
}
