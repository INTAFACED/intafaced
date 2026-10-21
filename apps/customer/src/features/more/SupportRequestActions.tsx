import { useId, useRef, useState, type ReactNode } from 'react';
import { useResource, type Resource } from '../../shared/resource';
import { Button } from '../../shared/ui';
import { useApi, useSession } from '../session/session';
import { Details, Read, Select, type useAction } from './common';
import { deskCopy } from './support-desk-copy';
import { RATING_NOTE_MAX, RATING_SCORES, requestActionStates, showRatePrompt, ticketReference, type ActionReason } from './support-desk';
import { fileSizeLabel, readAttachment } from './support-attach';
import { attachFile, closeRequest, downloadFile, rateRequest, readAttachLimits, readRating, readTicketFiles } from './support-calls';
import {
  SCAN_STATE_KEY,
  attachLimitsView,
  canDownload,
  fileOriginKey,
  limitsValues,
  precheckFile,
  saveBase64,
} from './support-attachments';
import type { Ticket } from './support-schemas';
import type { ratingSchema } from './support-calls';
import type { z } from 'zod';

const SCORE_KEY = {
  5: 'rateScoreOption5',
  4: 'rateScoreOption4',
  3: 'rateScoreOption3',
  2: 'rateScoreOption2',
  1: 'rateScoreOption1',
} as const;
const REASON_KEY = {
  closeAlreadyClosed: 'closeAlreadyClosed',
  rateNotYet: 'rateNotYet',
  attachClosed: 'attachClosed',
} as const satisfies Partial<Record<ActionReason, 'closeAlreadyClosed' | 'rateNotYet' | 'attachClosed'>>;
type State = ReturnType<typeof requestActionStates>[keyof ReturnType<typeof requestActionStates>];
/** The line beside a control: what it does when it works, why it is off when it is not. */
function line(state: State, help: 'closeHelp' | 'rateHelp' | 'attachHelp'): string {
  if (state.available) return deskCopy.t(help);
  const key = REASON_KEY[state.reason as keyof typeof REASON_KEY];
  return key ? deskCopy.t(key) : deskCopy.t(help);
}

/**
 * Close, rate and attach, each wired to the support service. Every send goes through the shared review step (so it cannot
 * be sent twice) and carries its own request id, so a repeat of the same send is answered with the first result instead of
 * doing it again. A control that does not apply to this status stays on the page, switched off, with the reason beside it.
 */
export function SupportRequestActions({
  ticket,
  action,
  onChanged,
}: {
  ticket: Ticket;
  action: ReturnType<typeof useAction>;
  onChanged: () => void;
}) {
  const copy = deskCopy.useCopy();
  const api = useApi(),
    { userId } = useSession();
  const id = ticket.id;
  const rating = useResource((signal) => readRating(api, id, userId, signal), `support-rating:${userId}:${id}`);
  const rated = rating.resource.status === 'ready' ? rating.resource.data !== null : false;
  const states = requestActionStates(ticket.status, rated);
  const base = useId();
  return (
    <div className="support-actions">
      <h3>{copy.t('actionsHeading')}</h3>
      {showRatePrompt(ticket.status, rating.resource.status === 'ready', rated) ? (
        <p className="support-rate-ask">{copy.t('rateAsk')}</p>
      ) : null}
      <ul>
        <li>
          <CloseControl ticket={ticket} action={action} state={states.close} describedBy={`${base}-close`} onChanged={onChanged} />
        </li>
        <li>
          <RateControl
            ticket={ticket}
            action={action}
            state={states.rate}
            describedBy={`${base}-rate`}
            rating={rating}
            onChanged={() => {
              rating.reload();
              onChanged();
            }}
          />
        </li>
        <li>
          <AttachControl ticket={ticket} action={action} state={states.attach} describedBy={`${base}-attach`} />
        </li>
      </ul>
    </div>
  );
}

type ControlProps = {
  ticket: Ticket;
  action: ReturnType<typeof useAction>;
  state: State;
  describedBy: string;
};

function Reason({ id, children }: { id: string; children: string }) {
  return (
    <small id={id} className="muted">
      {children}
    </small>
  );
}

function CloseControl({ ticket, action, state, describedBy, onChanged }: ControlProps & { onChanged: () => void }) {
  const copy = deskCopy.useCopy();
  const api = useApi(),
    { userId } = useSession();
  const id = ticket.id;
  return (
    <>
      <Button
        variant="secondary"
        disabled={!state.available || action.disabled}
        aria-describedby={describedBy}
        onClick={() => {
          // One id per decision to close: the service answers a repeat of this id with the first result.
          const clientRequestId = `close:${crypto.randomUUID()}`;
          action.stage({
            title: () => deskCopy.t('closeTitle'),
            reference: id,
            confirm: () => deskCopy.t('closeConfirm'),
            success: () => deskCopy.t('closeDone'),
            content: () => (
              <Details
                items={[
                  [deskCopy.t('reference'), <span lang="zxx">{ticketReference(id)}</span>],
                  [deskCopy.t('subjectField'), <span lang="und">{ticket.subject}</span>],
                ]}
              />
            ),
            run: () => closeRequest(api, { ticketId: id, userId, clientRequestId }),
            done: onChanged,
          });
        }}
      >
        {copy.t('closeLabel')}
      </Button>
      <Reason id={describedBy}>{line(state, 'closeHelp')}</Reason>
    </>
  );
}

function RateControl({
  ticket,
  action,
  state,
  describedBy,
  rating,
  onChanged,
}: ControlProps & { rating: { resource: Resource<z.infer<typeof ratingSchema> | null>; reload: () => void }; onChanged: () => void }) {
  const copy = deskCopy.useCopy();
  const api = useApi(),
    { userId } = useSession();
  const id = ticket.id;
  const [score, setScore] = useState('5'),
    [note, setNote] = useState('');
  const noteId = useId();
  const existing = rating.resource.status === 'ready' ? rating.resource.data : null;
  if (existing)
    return (
      <>
        <p role="status" id={describedBy}>
          {copy.t('rateDone', { score: existing.score })}
        </p>
        <p className="muted">{copy.t('rateDoneNext')}</p>
      </>
    );
  return (
    <div className="support-rate">
      <>
        <Select
          label={copy.t('rateScoreLabel')}
          value={score}
          onChange={setScore}
          options={RATING_SCORES.map((value) => ({ value: String(value), label: copy.t(SCORE_KEY[value]) }))}
        />
        <label className="field" htmlFor={noteId}>
          <span>{copy.t('rateNoteLabel')}</span>
          <textarea
            id={noteId}
            lang="und"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={RATING_NOTE_MAX}
            rows={3}
          />
          <small>{copy.t('rateNoteHint')}</small>
        </label>
        <Button
          variant="secondary"
          disabled={!state.available || action.disabled}
          aria-describedby={describedBy}
          onClick={() => {
            const clientRequestId = `rate:${crypto.randomUUID()}`;
            const sent = { score: Number(score), note: note.trim() };
            action.stage({
              title: () => deskCopy.t('rateTitle'),
              reference: id,
              confirm: () => deskCopy.t('rateConfirm'),
              success: () => deskCopy.t('rateSent'),
              content: () => (
                <Details
                  items={[
                    [deskCopy.t('reference'), <span lang="zxx">{ticketReference(id)}</span>],
                    [deskCopy.t('rateScoreRow'), <span lang="zxx">{sent.score} / 5</span>],
                    ...(sent.note ? ([[deskCopy.t('rateNoteRow'), <span lang="und">{sent.note}</span>]] as [string, ReactNode][]) : []),
                  ]}
                />
              ),
              run: () => rateRequest(api, { ticketId: id, userId, score: sent.score, note: sent.note, clientRequestId }),
              done: () => {
                setNote('');
                onChanged();
              },
            });
          }}
        >
          {copy.t('reviewRate')}
        </Button>
        <Reason id={describedBy}>{line(state, 'rateHelp')}</Reason>
      </>
    </div>
  );
}

/** A page of the files on one request. A page size has to be asked for; this is only how many rows the list reads. */
const FILES_PAGE = 100;

function AttachControl({ ticket, action, state, describedBy }: ControlProps) {
  const copy = deskCopy.useCopy();
  const api = useApi(),
    { userId } = useSession();
  const id = ticket.id;
  const input = useRef<HTMLInputElement>(null);
  const fileId = useId();
  const [problem, setProblem] = useState<
      'attachNoFile' | 'attachEmpty' | 'attachUnreadable' | 'refuseAttachLarge' | 'refuseAttachType' | 'attachDownloadFailed' | null
    >(null),
    [busyFile, setBusyFile] = useState<string | null>(null);
  const limits = useResource((signal) => readAttachLimits(api, signal), `support-attach-limits:${userId}`);
  const files = useResource((signal) => readTicketFiles(api, id, userId, FILES_PAGE, signal), `support-files:${userId}:${id}`);
  const view = limits.resource.status === 'ready' ? attachLimitsView(limits.resource.data) : null;
  const off = view?.kind === 'off';
  return (
    <>
      <label className="field" htmlFor={fileId}>
        <span>{copy.t('attachFileLabel')}</span>
        <input
          id={fileId}
          ref={input}
          type="file"
          disabled={!state.available || action.disabled || off}
          onChange={() => setProblem(null)}
        />
      </label>
      <Button
        variant="secondary"
        disabled={!state.available || action.disabled || off}
        aria-describedby={describedBy}
        onClick={async () => {
          const file = input.current?.files?.[0];
          if (!file) return setProblem('attachNoFile');
          const read = await readAttachment(file);
          if (!read.ok)
            return setProblem(
              read.reason === 'empty' ? 'attachEmpty' : read.reason === 'tooLarge' ? 'refuseAttachLarge' : 'attachUnreadable',
            );
          // The service's own limits, already read: spare the person a send the service will refuse.
          const refused = precheckFile(view, read);
          if (refused) return setProblem(refused as 'refuseAttachLarge' | 'refuseAttachType');
          setProblem(null);
          const clientRequestId = `attach:${crypto.randomUUID()}`;
          action.stage({
            title: () => deskCopy.t('attachTitle'),
            reference: id,
            confirm: () => deskCopy.t('attachConfirm'),
            success: () => deskCopy.t('attachDone'),
            content: () => (
              <Details
                items={[
                  [deskCopy.t('reference'), <span lang="zxx">{ticketReference(id)}</span>],
                  [deskCopy.t('attachRowType'), <span lang="zxx">{read.contentType}</span>],
                  [deskCopy.t('attachRowSize'), <span lang="zxx">{fileSizeLabel(read.byteLength)}</span>],
                ]}
              />
            ),
            run: () => attachFile(api, { ticketId: id, userId, ...read, clientRequestId }),
            done: () => {
              if (input.current) input.current.value = '';
              files.reload();
            },
          });
        }}
      >
        {copy.t('reviewAttach')}
      </Button>
      <Reason id={describedBy}>{line(state, 'attachHelp')}</Reason>
      {limits.resource.status === 'ready' && view ? (
        <p className="muted" data-testid="attach-limits">
          {view.kind === 'ready' ? copy.t('attachLimitsLine', limitsValues(view)) : copy.t('attachLimitsOff')}
        </p>
      ) : limits.resource.status === 'failed' ? (
        <p className="muted" data-testid="attach-limits">
          {copy.t('attachLimitsUnread')}
        </p>
      ) : null}
      {problem && (
        <p className="support-warning" role="alert">
          {copy.t(problem)}
        </p>
      )}
      <div>
        <small>{copy.t('attachFilesHeading')}</small>
        <Read resource={files.resource} retry={files.reload}>
          {(rows) =>
            rows.length === 0 ? (
              <p className="muted">{copy.t('attachNoFiles')}</p>
            ) : (
              <ul data-testid="attach-files">
                {rows.map((row) => (
                  <li key={row.id}>
                    <span lang="zxx">{copy.t('attachedRow', { type: row.contentType, size: fileSizeLabel(row.byteLength) })}</span> ·{' '}
                    <span data-scan-state={row.scanState}>{copy.t(SCAN_STATE_KEY[row.scanState])}</span>
                    {fileOriginKey(row.uploadedBy) && (
                      <>
                        {' '}
                        · <span data-testid="attach-from-support">{copy.t('attachFromSupport')}</span>
                      </>
                    )}
                    {canDownload(row.scanState) && (
                      <>
                        {' '}
                        <Button
                          variant="ghost"
                          disabled={busyFile !== null}
                          onClick={async () => {
                            setBusyFile(row.id);
                            setProblem(null);
                            const got = await downloadFile(api, row.id);
                            if (!got.ok || !saveBase64(got.data.bodyBase64, row.id)) setProblem('attachDownloadFailed');
                            setBusyFile(null);
                          }}
                        >
                          {copy.t('attachDownload')}
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )
          }
        </Read>
        <Button variant="ghost" onClick={files.reload}>
          {copy.t('refresh')}
        </Button>
      </div>
    </>
  );
}
