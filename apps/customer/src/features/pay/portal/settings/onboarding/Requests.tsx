import { useState } from 'react';
import { Button } from '@intafaced/ui';
import { useResource, type Resource } from '../../../../../shared/resource';
import type { ApiResult } from '../../../../../shared/api';
import { PaySection } from '../../../components';
import { Gate } from '../../components';
import type { PortalApi } from '../../api';
import type { MemberRole } from '../../schemas';
import { DateTime } from '../../ui/DateTime';
import { formatBytes } from '../reports/model';
import { applicationCopy } from './application-copy';
import { base64Of, fileProblem, kindsOf } from './Application';
import { requestsCopy } from './requests-copy';
import type { InformationRequest, RequestsView } from './requests-api';

type File_ = { contentType: string; bytesBase64: string };
export type AnswerRequest = (requestId: string, note: string | null, file: File_ | null) => Promise<ApiResult<unknown>>;

/**
 * `/pay/compliance`: what INTAFACED asked the business for, by when, the answer, and who closed each request. Only the
 * account owner reads and answers them (svc-pay checks ownership); a team member sees the section and why it is closed.
 */
export function InformationRequests({ portal, merchantId, role }: { portal: PortalApi; merchantId: string; role: MemberRole }) {
  if (role !== 'owner') return <OwnerOnlyRequests />;
  return <OwnersRequests portal={portal} merchantId={merchantId} />;
}

export function OwnerOnlyRequests() {
  const { t } = requestsCopy.useCopy();
  return (
    <PaySection title={t('title')} description={t('body')}>
      <p className="muted">{t('ownerOnly')}</p>
    </PaySection>
  );
}

function OwnersRequests({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const { resource, reload } = useResource((signal) => portal.kybRequests(merchantId, signal), `portal:kyb-requests:${merchantId}`);
  return (
    <InformationRequestsView
      resource={resource}
      reload={reload}
      answer={(requestId, note, file) => portal.kybRequestAnswer(requestId, note, file)}
    />
  );
}

export function InformationRequestsView({
  resource,
  reload,
  answer,
}: {
  resource: Resource<RequestsView>;
  reload: () => void;
  answer: AnswerRequest;
}) {
  const { t } = requestsCopy.useCopy();
  return (
    <PaySection title={t('title')} description={t('body')}>
      <Gate resource={resource} retry={reload} rows={2}>
        {(view) => (
          <div className="stack">
            {view.requests.some((request) => request.pastDue) && (
              <p className="pp-callout" role="alert">
                {t('pastDueBanner')}
              </p>
            )}
            {view.requests.length === 0 ? (
              <p className="muted">{t('empty')}</p>
            ) : (
              <ul className="sa-list" aria-label={t('title')}>
                {view.requests.map((request) => (
                  <RequestItem key={request.id} request={request} view={view} answer={answer} reload={reload} />
                ))}
              </ul>
            )}
          </div>
        )}
      </Gate>
    </PaySection>
  );
}

function RequestItem({
  request,
  view,
  answer,
  reload,
}: {
  request: InformationRequest;
  view: RequestsView;
  answer: AnswerRequest;
  reload: () => void;
}) {
  const { t } = requestsCopy.useCopy();
  const state = request.pastDue ? t('pastDue') : t(`state_${request.state}`);
  return (
    <li aria-label={request.text}>
      <p>
        <strong>{state}</strong> · {request.text}
      </p>
      <p className="muted pp-note">
        {t('dueBy')} <DateTime value={request.dueAt} /> · {t('asked')} <DateTime value={request.createdAt} />
      </p>
      {request.answer && (
        <div>
          <p className="muted pp-note">
            {t('yourAnswer')} · {t('answeredOn')} <DateTime value={request.answer.answeredAt} />
          </p>
          {request.answer.note && <p>{request.answer.note}</p>}
          {request.answer.file && (
            <p className="muted pp-note">{t('fileSent', { size: formatBytes(String(request.answer.file.byteLength)) })}</p>
          )}
        </div>
      )}
      {request.state === 'closed' && request.closedBy && request.closedAt && (
        <p className="pp-note">
          {t('closedBy', { who: request.closedBy.slice(0, 8) })} · {t('closedOn')} <DateTime value={request.closedAt} />
          {request.closeNote && (
            <>
              {' '}
              · {t('closeNote')}: {request.closeNote}
            </>
          )}
        </p>
      )}
      {request.state === 'open' && <AnswerForm request={request} view={view} answer={answer} reload={reload} />}
    </li>
  );
}

function AnswerForm({
  request,
  view,
  answer,
  reload,
}: {
  request: InformationRequest;
  view: RequestsView;
  answer: AnswerRequest;
  reload: () => void;
}) {
  const { t } = requestsCopy.useCopy();
  const { t: a } = applicationCopy.useCopy();
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  const rules = view.uploadRules;
  const files = rules !== null && view.scanner.status === 'connected';
  const nothing = note.trim() === '' && !file;
  const noteId = `kyb-answer-note-${request.id}`;
  const whyId = `kyb-answer-files-${request.id}`;
  async function send() {
    setBusy(true);
    setOutcome(null);
    try {
      const sent = file ? { contentType: file.type, bytesBase64: await base64Of(file) } : null;
      const result = await answer(request.id, note.trim() || null, sent);
      if (result.ok) {
        setOutcome({ ok: true, text: t('sent') });
        reload();
      } else {
        setOutcome({ ok: false, text: result.message });
        // Answered or closed meanwhile: show the request as it now stands rather than a form it no longer takes.
        if (result.code === 'pay.kyb_request_already_answered' || result.code === 'pay.kyb_request_closed') reload();
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <div data-testid="form-stack" className="form-stack pp-form">
      <label className="field" htmlFor={noteId}>
        <span>{t('noteLabel')}</span>
        <textarea id={noteId} rows={3} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      <p className="muted pp-note" id={whyId}>
        {files && rules
          ? t('limits', { size: formatBytes(String(rules.maxBytes)), types: kindsOf(rules.contentTypes) })
          : rules
            ? t('noScanner')
            : t('noRules')}
      </p>
      <label className="field">
        <span className="sr-only">{t('fileLabel')}</span>
        <input
          type="file"
          aria-label={t('fileLabel')}
          aria-describedby={whyId}
          disabled={!files}
          accept={rules?.contentTypes.join(',')}
          onChange={(event) => {
            const picked = event.target.files?.[0] ?? null;
            setFile(picked);
            setProblem(picked && rules ? fileProblem(picked, rules, a) : null);
          }}
        />
      </label>
      {problem && (
        <small className="text-down-text" role="alert">
          {problem}
        </small>
      )}
      <div className="pp-actions">
        <Button variant="primary" disabled={nothing || Boolean(problem) || busy} onClick={() => void send()}>
          {busy ? t('sending') : t('send')}
        </Button>
      </div>
      {nothing && <p className="muted pp-note">{t('needSomething')}</p>}
      {outcome &&
        (outcome.ok ? (
          <p className="pp-confirmed" role="status">
            {outcome.text}
          </p>
        ) : (
          <p className="pp-callout" role="alert">
            {outcome.text}
          </p>
        ))}
    </div>
  );
}
