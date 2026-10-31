import { useEffect, useRef, useState, type FormEvent } from 'react';
import { SUPPORT_GUEST_REQUEST_PATH } from '@intafaced/contracts/support-guest';
import { useDataEnv } from '../../data/hooks';
import { writeContract, type ContractData } from '../../shared/contract-call';
import type { ApiResult } from '../../shared/api';
import { ServiceOffNotice } from '../../shared/service-off';
import { Button, Field } from '../../shared/ui';
import { Select } from './common';
import { CustomerStatusBadge } from './SupportRequest';
import { categoryLabel } from './support-category';
import { CATEGORY_VALUES } from './support-schemas';
import { deskCopy } from './support-desk-copy';
import { guestCopy } from './support-guest-copy';
import { guestCreate, guestReply, guestThread, guestVerify, takeLinkToken } from './support-guest';
import './support-desk.css';
import '../public/public-pages.css';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;

/** A link's token, read once from the address and kept in this tab's storage under `slot` (best effort). */
function keptToken(name: 'token' | 'access', slot: string): string {
  const fromLink = takeLinkToken(name);
  try {
    if (fromLink) sessionStorage.setItem(slot, fromLink);
    return fromLink || (sessionStorage.getItem(slot) ?? '');
  } catch {
    return fromLink;
  }
}
type GuestT = ReturnType<typeof guestCopy.useCopy>['t'];

/** The code a refusal names: the service's dotted code, or `vendor.email`. */
function refusalCode(refusal: Refusal): string | null {
  const named = /\b(?:support|guest)(?:\.[a-z0-9_]+)+|\bvendor\.email\b/.exec(refusal.message)?.[0];
  return named ?? refusal.code ?? null;
}

/** The plain sentence for a refusal of the guest path; every code is also shown as it is. */
function GuestRefusal({ refusal, t }: { refusal: Refusal; t: GuestT }) {
  const code = refusalCode(refusal);
  if (code === 'vendor.email')
    return (
      <div role="alert" data-testid="support-guest-not-connected">
        <ServiceOffNotice code="vendor.email" action={t('verifyAction')} />
        <p className="muted">{t('pendingBody')}</p>
      </div>
    );
  const unset = /support\.guest_(link_ttl|rate_limit|retention|address_key)_unset/.exec(code ?? '');
  const sentence =
    code === 'support.guest_rate_limited'
      ? t('rateLimited')
      : unset
        ? t('unset', { setting: (/SUPPORT_GUEST_[A-Z_]+/.exec(refusal.message)?.[0] ?? code)! })
        : code === 'support.guest_delivery_unknown'
          ? t('deliveryUnknown')
          : code === 'support.category_unknown'
            ? t('categoryUnknown')
            : code === 'support.fraud_route_unset' || code === 'support.fraud_route_missing'
              ? t('fraudUnset')
              : t('failed');
  return (
    <p role="alert" className="support-warning" data-testid="support-guest-refusal" data-code={code ?? undefined}>
      {sentence} {code ? <small lang="zxx">{code}</small> : null}
    </p>
  );
}

/**
 * /support/new for someone who is not signed in (SP-tickets-01): the same request form with an email field. Sending it
 * opens nothing: it shows "check your email", and the request is opened when the emailed link is used.
 */
export function GuestNewRequest() {
  const copy = deskCopy.useCopy();
  const { t } = guestCopy.useCopy();
  const { api } = useDataEnv();
  const [email, setEmail] = useState(''),
    [category, setCategory] = useState('other'),
    [subject, setSubject] = useState(''),
    [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ email: string; expires: string } | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  // One key per submission: sending the same words again (a retry, a double tap, a resend once a sender exists) answers
  // the first one. Changed words are a new submission with a new key.
  const key = useRef<{ id: string; words: string } | null>(null);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    const words = JSON.stringify([email.trim().toLowerCase(), category, subject.trim(), body.trim()]);
    if (key.current?.words !== words) key.current = { id: `guest:${crypto.randomUUID()}`, words };
    const answer = await writeContract(api, guestCreate, {
      email: email.trim(),
      category,
      subject: subject.trim(),
      body: body.trim(),
      clientRequestId: key.current.id,
    });
    setBusy(false);
    if (answer.ok) setSent({ email: email.trim(), expires: new Date(answer.data.linkExpiresAt).toLocaleString() });
    else setRefusal(answer);
  }

  if (sent)
    return (
      <section className="pub-page support-new" data-testid="support-guest-check-email" aria-live="polite">
        <header className="pub-heading">
          <h1>{t('checkTitle')}</h1>
        </header>
        <p role="status">{t('checkBody', { email: sent.email, expires: sent.expires })}</p>
        <Button
          variant="secondary"
          onClick={() => {
            key.current = null;
            setSent(null);
            setSubject('');
            setBody('');
          }}
        >
          {t('checkAgain')}
        </Button>
      </section>
    );
  return (
    <section className="pub-page support-pane support-new" data-testid="support-guest-new" aria-label={copy.t('tabNew')}>
      <header className="pub-heading">
        <h1>{copy.t('pageNewRequest')}</h1>
      </header>
      <form onSubmit={(event) => void send(event)}>
        <p className="muted">{t('intro')}</p>
        <p className="support-warning" role="note">
          {copy.t('newWarning')}
        </p>
        <Field
          label={t('emailField')}
          type="email"
          autoComplete="email"
          lang="zxx"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          maxLength={320}
        />
        <Select
          label={copy.t('topicField')}
          value={category}
          onChange={setCategory}
          options={CATEGORY_VALUES.map((value) => ({ value, label: categoryLabel(value) }))}
        />
        <Field
          label={copy.t('subjectField')}
          lang="und"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          required
          maxLength={200}
        />
        <label className="field">
          <span>{copy.t('messageField')}</span>
          <textarea lang="und" value={body} onChange={(event) => setBody(event.target.value)} maxLength={10000} rows={7} />
          <small>{copy.t('characters', { count: body.length, max: 10000 })}</small>
        </label>
        {refusal ? <GuestRefusal refusal={refusal} t={t} /> : null}
        <Button type="submit" disabled={busy || !email.trim() || !subject.trim() || !body.trim()}>
          {busy ? t('sending') : t('send')}
        </Button>
      </form>
      <p>
        <a className="text-link" href="/login">
          {t('signInInstead')}
        </a>
      </p>
    </section>
  );
}

/**
 * /support/guest/verify#token=… (SP-tickets-01): the page the emailed link opens. Opening it changes nothing, so a mail
 * scanner that fetches the link opens no request; the person presses Open. The token leaves the address bar once read.
 */
export function GuestVerify() {
  const { t } = guestCopy.useCopy();
  const { api } = useDataEnv();
  // Kept for this tab only, so a reload before Open still has it while the address bar holds no token.
  const [token] = useState(() => keptToken('token', 'support-guest-verify'));
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  async function open() {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    const answer = await writeContract(api, guestVerify, { token });
    setBusy(false);
    if (answer.ok) location.assign(`${SUPPORT_GUEST_REQUEST_PATH}#access=${answer.data.access}`);
    else setRefusal(answer);
  }

  const code = refusal ? refusalCode(refusal) : null;
  const dead = !token || code === 'support.guest_link_invalid' || code === 'support.guest_link_expired';
  return (
    <div className="pub-page" data-testid="support-guest-verify">
      <header className="pub-heading">
        <p className="eyebrow">{t('verifyEyebrow')}</p>
        <h1>{code === 'support.guest_link_expired' ? t('expiredTitle') : dead ? t('invalidTitle') : t('verifyTitle')}</h1>
      </header>
      {dead ? (
        <div className="pub-notice" role="alert" data-testid="support-guest-link-dead" data-code={code ?? undefined}>
          <p>{code === 'support.guest_link_expired' ? t('expiredBody') : t('invalidBody')}</p>
          {code ? <small lang="zxx">{code}</small> : null}
        </div>
      ) : (
        <>
          <p className="muted">{t('verifyIntro')}</p>
          <Button onClick={() => void open()} disabled={busy}>
            {busy ? t('verifying') : t('verifyButton')}
          </Button>
          {refusal ? <GuestRefusal refusal={refusal} t={t} /> : null}
        </>
      )}
      <p>
        <a className="text-link" href="/support/new" data-testid="support-guest-back">
          {t('backToForm')}
        </a>
      </p>
    </div>
  );
}

type Thread = ContractData<typeof guestThread>;

/**
 * /support/guest/request#access=… (SP-tickets-01): the one request a guest's access link opens, with its public thread
 * and a reply box. It is not a session: nothing else in the app reads it, and the page says so.
 */
export function GuestRequest() {
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
      <div className="pub-page" data-testid="support-guest-request">
        <header className="pub-heading">
          <h1>{code === 'support.guest_link_expired' ? t('expiredTitle') : t('invalidTitle')}</h1>
        </header>
        <div className="pub-notice" role="alert" data-testid="support-guest-link-dead" data-code={code ?? undefined}>
          <p>{code === 'support.guest_link_expired' ? t('expiredBody') : t('invalidBody')}</p>
          {code ? <small lang="zxx">{code}</small> : null}
        </div>
        <p>
          <a className="text-link" href="/support/new" data-testid="support-guest-back">
            {t('backToForm')}
          </a>
        </p>
      </div>
    );
  return (
    <div className="pub-page support-pane" data-testid="support-guest-request">
      <header className="pub-heading">
        <p className="eyebrow">{t('verifyEyebrow')}</p>
        <h1 lang="und">{thread?.ticket.subject ?? t('requestTitle')}</h1>
      </header>
      <p className="support-warning" role="note" data-testid="support-guest-not-a-sign-in">
        {t('notASignIn')}
      </p>
      {refusal ? (
        <GuestRefusal refusal={refusal} t={t} />
      ) : !thread ? (
        <p role="status">{t('loading')}</p>
      ) : (
        <>
          <p data-testid="support-guest-ticket" data-ticket-id={thread.ticket.id}>
            {t('status')}: <CustomerStatusBadge row={thread.ticket} />
          </p>
          <label className="field">
            <span>{t('keepLink')}</span>
            <input
              readOnly
              lang="zxx"
              value={`${location.origin}${SUPPORT_GUEST_REQUEST_PATH}#access=${access}`}
              data-testid="support-guest-keep-link"
            />
          </label>
          <ol className="support-thread" data-testid="support-guest-thread">
            <li lang="und">
              <strong>{t('you')}</strong> {thread.ticket.body}
            </li>
            {thread.comments.map((comment) => (
              <li key={comment.id} lang="und" data-author={comment.authorRole}>
                <strong>{comment.authorRole === 'user' ? t('you') : t('team')}</strong> {comment.body}
              </li>
            ))}
          </ol>
          {thread.comments.length === 0 ? <p className="muted">{t('noReplies')}</p> : null}
          <form onSubmit={(event) => void send(event)}>
            <label className="field">
              <span>{t('replyField')}</span>
              <textarea lang="und" value={reply} onChange={(event) => setReply(event.target.value)} maxLength={10000} rows={4} />
              <small>{copy.t('characters', { count: reply.length, max: 10000 })}</small>
            </label>
            <Button type="submit" disabled={busy || !reply.trim()}>
              {t('replySend')}
            </Button>
            {note ? (
              <p role={note === 'replySent' ? 'status' : 'alert'} data-testid="support-guest-reply-note">
                {t(note)}
              </p>
            ) : null}
          </form>
        </>
      )}
    </div>
  );
}
