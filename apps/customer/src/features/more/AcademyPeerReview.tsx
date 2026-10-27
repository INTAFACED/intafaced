import { useEffect, useRef, useState } from 'react';
import {
  academyPeerReviewFileSchema,
  academyReviewStateSchema,
  type AcademyReviewState,
  type AcademyReviewTask,
} from '@intafaced/contracts/academy-courses';
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
  if (state.stage === 'off') return t('rvOff');
  if (state.peer && state.peerCount !== null) return t('rvCount', { done: state.peerDone, count: state.peerCount });
  return t('rvSelfToDo');
}

/** The file of a review task as the browser opens it: a classmate's under a neutral name, never their own. */
export function reviewFileName(task: AcademyReviewTask, contentType: string): string {
  const extension = contentType === 'application/pdf' ? 'pdf' : contentType === 'image/png' ? 'png' : 'bin';
  return task.kind === 'self' && task.file?.fileName ? task.file.fileName : `classmate-${task.ordinal ?? 1}.${extension}`;
}

/**
 * The work under review and one radio group per criterion of its rubric. A criterion left open is named here and
 * nothing is sent; the page never guesses a level. Pure but for the chosen levels.
 */
export function ReviewForm({
  task,
  sending,
  onSend,
  onOpenFile,
  opening = false,
}: {
  task: AcademyReviewTask;
  sending: boolean;
  onSend: (marks: string[]) => void;
  onOpenFile?: () => void;
  opening?: boolean;
}) {
  const { t } = copy.useCopy();
  const [marks, setMarks] = useState<(string | null)[]>(() => task.criteria.map(() => null));
  const [missing, setMissing] = useState<string | null>(null);
  const self = task.kind === 'self';
  return (
    <form
      className="academy-lms-stack"
      data-testid={self ? 'review-self' : 'review-work'}
      onSubmit={(event) => {
        event.preventDefault();
        const open = marks.findIndex((mark) => mark === null);
        setMissing(open === -1 ? null : task.criteria[open]!.name);
        if (open === -1) onSend(marks as string[]);
      }}
    >
      <strong>{self ? t('rvYourWork') : t('rvClassmate', { n: task.ordinal ?? 1 })}</strong>
      <p lang="und" style={{ whiteSpace: 'pre-wrap' }}>
        {task.text ?? t('rvNoText')}
      </p>
      {task.file && (
        <p data-testid="academy-lms-meta" className="academy-lms-meta">
          <span lang="und">
            {task.file.fileName
              ? t('rvFile', { name: task.file.fileName, size: byteSize(task.file.bytes) })
              : t('rvFilePeer', { size: byteSize(task.file.bytes) })}
          </span>
          {onOpenFile && (
            <Button type="button" variant="secondary" disabled={opening} onClick={onOpenFile}>
              {opening ? t('rvOpeningFile') : t('rvOpenFile')}
            </Button>
          )}
        </p>
      )}
      {task.criteria.map((criterion, i) => (
        <fieldset key={criterion.name} className="academy-lms-stack">
          <legend lang="und">{criterion.name}</legend>
          <span data-testid="academy-lms-meta" className="academy-lms-meta">
            {criterion.levels.map((level) => (
              <label key={level} className="academy-lms-choice">
                <input
                  type="radio"
                  name={`${task.id}-${i}`}
                  value={level}
                  aria-label={t('rvLevel', { criterion: criterion.name, level })}
                  checked={marks[i] === level}
                  onChange={() => setMarks((all) => all.map((mark, n) => (n === i ? level : mark)))}
                />
                <span lang="und">{level}</span>
              </label>
            ))}
          </span>
        </fieldset>
      ))}
      {missing && (
        <p role="status" data-testid="failure" className="failure">
          {t('rvMissingLevel', { criterion: missing })}
        </p>
      )}
      <Button type="submit" variant="primary" disabled={sending}>
        {sending ? t('rvSending') : self ? t('rvSendSelf') : t('rvSend')}
      </Button>
    </form>
  );
}

/**
 * Peer and self review on an assignment's page (AC-assignments-03). Opening it asks Academy for the learner's stage,
 * which hands them a classmate's work when one is due and free; asking again hands out nothing new. Each review is sent
 * once for its task: a lost reply re-reads the stage, and the same marks sent again are answered as stored. A file is
 * read through Academy, so the store address (which carries the author's account) never reaches the reviewer.
 */
export function AcademyPeerReview({ itemId, handedIn }: { itemId: string; handedIn: number }) {
  const api = useApi();
  const { t } = copy.useCopy();
  const view = useResource(
    (signal) => api.mutate('academy', 'peerReview', { itemId }, academyReviewStateSchema, { signal }),
    `peer-review:${itemId}:${handedIn}`,
  );
  const [sending, setSending] = useState(false);
  const [opening, setOpening] = useState(false);
  const [refused, setRefused] = useState<Failure | null>(null);
  const [uncertain, setUncertain] = useState(false);
  // A review's answer is newer than the read it was sent from, until the next read lands.
  const [answered, setAnswered] = useState<AcademyReviewState | null>(null);
  const inFlight = useRef(false);
  const ready = view.resource.status === 'ready' ? view.resource.data : null;
  useEffect(() => setAnswered(null), [ready]);
  const state = answered ?? ready;

  if (view.resource.status === 'failed' && !answered)
    return (
      <section data-testid="assignment-review" aria-label={t('rvTitle')}>
        <AcademyRefusal failure={view.resource.failure} retry={view.reload} />
      </section>
    );
  if (!state) return <Loading />;

  const send = async (task: AcademyReviewTask, marks: string[]) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setRefused(null);
    setUncertain(false);
    const sent = await api.mutate('academy', 'submitPeerReview', { itemId, taskId: task.id, marks }, academyReviewStateSchema);
    inFlight.current = false;
    setSending(false);
    if (sent.ok) return setAnswered(sent.data);
    if (sent.reason === 'uncertain') setUncertain(true);
    else setRefused(sent);
    // What Academy stored is what the page shows.
    view.reload();
  };

  const openFile = async (task: AcademyReviewTask) => {
    setOpening(true);
    setRefused(null);
    const file = await api.query('academy', 'peerReviewFile', { itemId, taskId: task.id }, academyPeerReviewFileSchema);
    setOpening(false);
    if (!file.ok) return setRefused(file);
    const bytes = Uint8Array.from(atob(file.data.contentBase64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: file.data.contentType }));
    const link = document.createElement('a');
    link.href = url;
    link.download = reviewFileName(task, file.data.contentType);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
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
      {state.task && (
        <ReviewForm
          key={state.task.id}
          task={state.task}
          sending={sending}
          opening={opening}
          onSend={(marks) => void send(state.task!, marks)}
          onOpenFile={() => void openFile(state.task!)}
        />
      )}
      {uncertain && (
        <p role="status" data-testid="failure" className="failure">
          {t('rvUncertain')}
        </p>
      )}
      {refused && <AcademyRefusal failure={refused} />}
    </section>
  );
}
