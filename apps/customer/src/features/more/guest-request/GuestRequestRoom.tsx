import { useEffect, useRef, useState, type FormEvent } from 'react';
import { SUPPORT_GUEST_REQUEST_PATH } from '@intafaced/contracts/support-guest';
import { Button, Field, Tag, TextField } from '@intafaced/ui/lit';
import { ReadingTemplate, ServiceOffNotice } from '@intafaced/ui/lit/templates';
import { useDataEnv } from '../../../data/hooks';
import { writeContract, type ContractData } from '../../../shared/contract-call';
import type { ApiResult } from '../../../shared/api';
import { serviceOffCopy } from '../../../shared/service-off';
import { customerStatus } from '../support-desk';
import { deskCopy } from '../support-desk-copy';
import { guestCopy } from '../support-guest-copy';
import { guestRefusalWords, guestReply, guestThread, keptToken, refusalCode } from '../support-guest';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type Thread = ContractData<typeof guestThread>;
type GuestT = ReturnType<typeof guestCopy.useCopy>['t'];

/** Whose turn a request is, as the desk says it, with a tag's tone: waiting on you reads accent, solved reads up. */
const STATUS_KEY = { awaiting_reply: 'customerAwaiting', open: 'customerOpen', solved: 'customerSolved' } as const;
const STATUS_TONE = { awaiting_reply: 'accent', open: 'neutral', solved: 'up' } as const;

function RequestStatus({ row }: { row: Thread['ticket'] }) {
  const copy = deskCopy.useCopy();
  const shown = customerStatus(row);
  return <Tag tone={STATUS_TONE[shown]}>{copy.t(STATUS_KEY[shown])}</Tag>;
}

/** The plain sentence for a refusal of the guest path; every code is also shown as it is. */
function GuestRefusal({ refusal, t }: { refusal: Refusal; t: GuestT }) {
  const off = serviceOffCopy.useCopy();
  const words = guestRefusalWords(refusal);
  if (words.kind === 'not-connected')
    return (
      <div role="alert" data-testid="support-guest-not-connected" className="lt-stack">
        <ServiceOffNotice
          code="vendor.email"
          sentence={off.t('sentence', { action: t('verifyAction'), dependency: off.t('vendor.email') })}
        />
        <p className="lt-hint">{t('pendingBody')}</p>
      </div>
    );
  const sentence = words.key === 'unset' ? t('unset', { setting: words.setting }) : t(words.key);
  return (
    <p role="alert" data-testid="support-guest-refusal" data-code={words.code ?? undefined}>
      {sentence} {words.code ? <small lang="zxx">{words.code}</small> : null}
    </p>
  );
}

/**
 * /support/guest/request (SP-tickets-01), on the reading template: a guest's own request, opened by the emailed link,
 * with its thread and a reply box. A dead or missing link says so and points back at the form.
 */
export function GuestRequestRoom() {
  const copy = deskCopy.useCopy();
  const { t } = guestCopy.useCopy();
  const { api } = useDataEnv();
  // Kept for this tab only, so a reload still opens the request while the address bar holds no token.
  const [access] = useState(() => keptToken('access', 'support-guest-access'));
  const [thread, setThread] = useState<Thread | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<'replySent' | 'replyFailed' | null>(null);
  const replyKey = useRef(`guest-reply:${crypto.randomUUID()}`);

  async function load() {
    if (!access) return;
    const answer = await writeContract(api, guestThread, { access, limit: 100 });
    if (answer.ok) setThread(answer.data);
    else setRefusal(answer);
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (busy || !reply.trim()) return;
    setBusy(true);
    setNote(null);
    const answer = await writeContract(api, guestReply, { access, body: reply.trim(), clientRequestId: replyKey.current });
    setBusy(false);
    if (answer.ok) {
      replyKey.current = `guest-reply:${crypto.randomUUID()}`;
      setReply('');
      setNote('replySent');
      await load();
    } else setNote('replyFailed');
  }

  const code = refusal ? refusalCode(refusal) : null;
  if (!access || code === 'support.guest_link_invalid' || code === 'support.guest_link_expired')
    return (
      <div data-testid="support-guest-request">
        <ReadingTemplate
          title={code === 'support.guest_link_expired' ? t('expiredTitle') : t('invalidTitle')}
          state={{ kind: 'ready' }}
          body={
            <div className="lt-stack">
              <div className="lt-refusal" role="alert" data-testid="support-guest-link-dead" data-code={code ?? undefined}>
                <p className="lt-refusal-body">{code === 'support.guest_link_expired' ? t('expiredBody') : t('invalidBody')}</p>
                {code ? (
                  <small className="lt-ref" lang="zxx">
                    {code}
                  </small>
                ) : null}
              </div>
              <p>
                <a className="lt-link" href="/support/new" data-testid="support-guest-back">
                  {t('backToForm')}
                </a>
              </p>
            </div>
          }
        />
      </div>
    );
  return (
    <div data-testid="support-guest-request">
      <ReadingTemplate
        title={thread?.ticket.subject ?? t('requestTitle')}
        state={{ kind: 'ready' }}
        meta={<p className="lt-hint">{t('verifyEyebrow')}</p>}
        body={
          <div className="lt-stack">
            <p role="note" data-testid="support-guest-not-a-sign-in">
              {t('notASignIn')}
            </p>
            {refusal ? (
              <GuestRefusal refusal={refusal} t={t} />
            ) : !thread ? (
              <p role="status">{t('loading')}</p>
            ) : (
              <>
                <p data-testid="support-guest-ticket" data-ticket-id={thread.ticket.id}>
                  {t('status')}: <RequestStatus row={thread.ticket} />
                </p>
                <Field
                  label={t('keepLink')}
                  readOnly
                  lang="zxx"
                  value={`${location.origin}${SUPPORT_GUEST_REQUEST_PATH}#access=${access}`}
                  data-testid="support-guest-keep-link"
                />
                <ol data-testid="support-guest-thread">
                  <li lang="und">
                    <strong>{t('you')}</strong> {thread.ticket.body}
                  </li>
                  {thread.comments.map((comment) => (
                    <li key={comment.id} lang="und" data-author={comment.authorRole}>
                      <strong>{comment.authorRole === 'user' ? t('you') : t('team')}</strong> {comment.body}
                    </li>
                  ))}
                </ol>
                {thread.comments.length === 0 ? <p className="lt-hint">{t('noReplies')}</p> : null}
                <form className="lt-stack" onSubmit={(event) => void send(event)}>
                  <TextField
                    label={t('replyField')}
                    lang="und"
                    value={reply}
                    onChange={(event) => setReply(event.target.value)}
                    maxLength={10000}
                    rows={4}
                    hint={copy.t('characters', { count: reply.length, max: 10000 })}
                  />
                  <div className="lt-actions">
                    <Button type="submit" tone="primary" disabled={busy || !reply.trim()}>
                      {t('replySend')}
                    </Button>
                  </div>
                  {note ? (
                    <p role={note === 'replySent' ? 'status' : 'alert'} data-testid="support-guest-reply-note">
                      {t(note)}
                    </p>
                  ) : null}
                </form>
              </>
            )}
          </div>
        }
      />
    </div>
  );
}
