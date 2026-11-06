import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, StateBlock } from '@intafaced/ui';
import { useSession } from '../../features/session/session';
import { resolveHandle } from '../../data/identity';
import { fmtAmount } from '../../data';
import { usePreferences } from '../../shared/preferences';
import { stamp } from '../money/time';
import { cleanAmount, cleanNote, createPersonalPayApi, NOTE_MAX, confirmWithStepUp, personSendStepUp } from './deps';
import {
  createRequestsApi,
  reportReasons,
  requestTransferId,
  type ReminderFacts,
  type ReportReason,
  type RequestSafety,
  type ServerRequest,
} from '../../features/pay/personal/requests';
import { requestsCopy } from './requests-copy';
import { stepUpAgain, stepUpProblem } from './send-step-up';

const EXPIRY_DAYS = [1, 7, 30] as const;

const who = (handle: string | null, userId: string) => handle ?? userId;
const failureWhy = (result: { message: string; code?: string }) => result.code ?? result.message;

/** Plain words for the bank's typed refusals on requests; anything else is named as the bank answered it. */
const REFUSAL_WORDS = {
  'bank.personal_request_remind_capped': 'refusedCapped',
  'bank.personal_request_unavailable': 'refusedUnavailable',
  'bank.personal_request_expired': 'refusedExpired',
  'bank.personal_request_closed': 'refusedClosed',
  'bank.personal_request_claim_held': 'refusedInFlight',
  'bank.reminder_policy_unset': 'refusedUnset',
} as const;
function useRefusal() {
  const { t } = requestsCopy.useCopy();
  return (result: { message: string; code?: string }) => {
    const key = result.code ? REFUSAL_WORDS[result.code as keyof typeof REFUSAL_WORDS] : undefined;
    return key ? t(key) : t('failed', { why: failureWhy(result) });
  };
}

/** An ask stays open to the end of a whole UTC day, `days` days from today, so the same ask made again today closes at the same moment. */
export function askExpiry(now: Date, days: number): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days + 1) - 1000).toISOString();
}

/** `ask:<payer>:<16 hex of SHA-256 over coin, amount, note and closing time>`: at most 57 characters. */
export async function askKey(payerUserId: string, asset: string, amount: string, note: string | null, expiresAt: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode([asset, amount, note ?? '', expiresAt].join('\n')));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `ask:${payerUserId}:${hex.slice(0, 16)}`;
}

/** Ask a person by handle (PP-send-request-12): a review first, then one request on a business key. No money moves. */
export function AskAPerson({ assets, onSent }: { assets: string[]; onSent: () => void }) {
  const { api, userId } = useSession();
  const requests = useMemo(() => createRequestsApi(api), [api]);
  const { t } = requestsCopy.useCopy();
  const refusal = useRefusal();
  const { timeZone } = usePreferences();
  const [handle, setHandle] = useState('');
  const [asset, setAsset] = useState(assets[0] ?? '');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [days, setDays] = useState<number>(7);
  const [problem, setProblem] = useState<string | null>(null);
  const [review, setReview] = useState<{
    payerUserId: string;
    handle: string;
    asset: string;
    amount: string;
    note: string | null;
    expiresAt: string;
    key: string;
  } | null>(null);
  const [sent, setSent] = useState<ServerRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = assets.includes(asset) ? asset : (assets[0] ?? '');
  const valid = cleanAmount(amount);
  const blocker = handle.trim() === '' ? t('askNeedWho') : valid === null ? t('askNeedAmount') : null;

  async function toReview() {
    if (blocker !== null || valid === null || busy) return;
    setBusy(true);
    setProblem(null);
    const found = await resolveHandle(api, handle);
    setBusy(false);
    if (found.kind === 'notFound') return setProblem(t('askNotFound', { handle: handle.trim().replace(/^@/, '') }));
    if (found.kind !== 'found') return setProblem(t('askLookupFailed'));
    if (found.self || found.userId === userId) return setProblem(t('askSelf'));
    const expiresAt = askExpiry(new Date(), days);
    // The business key of this ask is what it asks: the same person, coin, amount, note and closing day. A lost reply, a
    // second press or the same ask reviewed again after a reload is the same request, never a second one.
    const key = await askKey(found.userId, chosen, valid, cleanNote(note), expiresAt);
    setReview({ payerUserId: found.userId, handle: found.handle, asset: chosen, amount: valid, note: cleanNote(note), expiresAt, key });
  }

  async function send() {
    if (!review || busy) return;
    setBusy(true);
    setProblem(null);
    const result = await requests.create({
      payerUserId: review.payerUserId,
      assetId: review.asset,
      amount: review.amount,
      ...(review.note ? { note: review.note } : {}),
      expiresAt: review.expiresAt,
      idempotencyKey: review.key,
    });
    setBusy(false);
    if (!result.ok) return setProblem(refusal(result));
    setSent(result.data);
    setReview(null);
    onSent();
  }

  if (sent)
    return (
      <div className="pay-block" data-testid="request-sent" data-request-id={sent.requestId}>
        <h3 className="pay-section-title">{t('sentTitle', { handle: who(sent.payerHandle, sent.payerUserId) })}</h3>
        <p className="pay-hint">{t('sentBody')}</p>
        <div className="pay-row-actions">
          <Button variant="primary" size={40} nativeButton={false} render={<a href={`/pay/request/${sent.requestId}`} />}>
            {t('sentOpen')}
          </Button>
          <Button
            variant="ghost"
            size={40}
            onClick={() => {
              setSent(null);
              setHandle('');
              setAmount('');
              setNote('');
            }}
          >
            {t('sentAnother')}
          </Button>
        </div>
      </div>
    );

  if (review)
    return (
      <section className="pay-block" aria-label={t('reviewTitle')} data-testid="request-review">
        <h3 className="pay-section-title">{t('reviewTitle')}</h3>
        <dl className="pay-quote">
          <div>
            <dt>{t('reviewTo')}</dt>
            <dd data-testid="request-review-to">@{review.handle}</dd>
          </div>
          <div>
            <dt>{t('reviewAmount')}</dt>
            <dd data-testid="request-review-amount">
              {fmtAmount(review.amount, { places: 18 })} {review.asset}
            </dd>
          </div>
          <div>
            <dt>{t('reviewNote')}</dt>
            <dd data-testid="request-review-note">{review.note ?? t('reviewNoNote')}</dd>
          </div>
          <div>
            <dt>{t('reviewExpires')}</dt>
            <dd>{stamp(review.expiresAt, timeZone, Date.now())}</dd>
          </div>
        </dl>
        <p className="pay-hint" data-testid="request-review-no-money">
          {t('reviewNoMoney')}
        </p>
        {problem ? (
          <p className="pay-problem" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="pay-row-actions">
          <Button variant="primary" size={48} onClick={() => void send()} disabled={busy} data-testid="request-send">
            {t('reviewSend')}
          </Button>
          <Button variant="ghost" size={48} onClick={() => setReview(null)} disabled={busy}>
            {t('reviewEdit')}
          </Button>
        </div>
      </section>
    );

  return (
    <form
      className="pay-block"
      aria-label={t('askTitle')}
      data-testid="request-ask"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void toReview();
      }}
    >
      <h3 className="pay-section-title">{t('askTitle')}</h3>
      <p className="pay-hint">{t('askIntro')}</p>
      <div className="pay-field">
        <label className="pay-field__label" htmlFor="request-ask-who">
          {t('askWho')}
        </label>
        <input
          id="request-ask-who"
          className="pay-text"
          type="text"
          value={handle}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder={t('askWhoPlaceholder')}
          onChange={(event) => setHandle(event.target.value)}
        />
      </div>
      <div className="pay-field">
        <label className="pay-field__label" htmlFor="request-ask-asset">
          {t('askAsset')}
        </label>
        <select id="request-ask-asset" className="pay-text" value={chosen} onChange={(event) => setAsset(event.target.value)}>
          {assets.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      </div>
      <div className="pay-field">
        <label className="pay-field__label" htmlFor="request-ask-amount">
          {t('askAmount')}
        </label>
        <input
          id="request-ask-amount"
          className="pay-text"
          type="text"
          inputMode="decimal"
          value={amount}
          autoComplete="off"
          placeholder="0"
          onChange={(event) => setAmount(event.target.value)}
        />
      </div>
      <div className="pay-field">
        <label className="pay-field__label" htmlFor="request-ask-note">
          {t('askNote')}
        </label>
        <input
          id="request-ask-note"
          className="pay-text"
          type="text"
          value={note}
          maxLength={NOTE_MAX}
          autoComplete="off"
          onChange={(event) => setNote(event.target.value)}
        />
      </div>
      <div className="pay-field">
        <label className="pay-field__label" htmlFor="request-ask-expiry">
          {t('askExpiry')}
        </label>
        <select id="request-ask-expiry" className="pay-text" value={days} onChange={(event) => setDays(Number(event.target.value))}>
          {EXPIRY_DAYS.map((d) => (
            <option key={d} value={d}>
              {d === 1 ? t('askExpiryDay') : t('askExpiryDays', { days: String(d) })}
            </option>
          ))}
        </select>
      </div>
      {problem ? (
        <p className="pay-problem" role="alert">
          {problem}
        </p>
      ) : null}
      <Button type="submit" variant="primary" size={48} fullWidth disabled={blocker !== null || busy} data-testid="request-ask-review">
        {blocker ?? t('askReview')}
      </Button>
    </form>
  );
}

function StatusChip({ status }: { status: ServerRequest['status'] }) {
  const { t } = requestsCopy.useCopy();
  return (
    <span className="pay-chip" data-testid="request-status" data-status={status}>
      {t(`status_${status}`)}
    </span>
  );
}

/** The person's requests from the bank: asked of them, and asked by them, each with its status. */
export function RequestLists({ revision }: { revision: number }) {
  const { api } = useSession();
  const requests = useMemo(() => createRequestsApi(api), [api]);
  const { t } = requestsCopy.useCopy();
  const [lists, setLists] = useState<{ incoming: ServerRequest[]; outgoing: ServerRequest[] } | 'loading' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([requests.list('incoming', controller.signal), requests.list('outgoing', controller.signal)]).then(
      ([incoming, outgoing]) => {
        if (controller.signal.aborted) return;
        setLists(incoming.ok && outgoing.ok ? { incoming: incoming.data, outgoing: outgoing.data } : 'error');
      },
    );
    return () => controller.abort();
  }, [requests, revision, attempt]);
  if (lists === 'loading') return <div className="pay-block" aria-busy="true" data-testid="request-lists-loading" />;
  if (lists === 'error')
    return <StateBlock kind="error" title={t('listFailed')} onRetry={() => setAttempt((n) => n + 1)} retryLabel={t('listRetry')} />;
  return (
    <>
      {(['incoming', 'outgoing'] as const).map((direction) => (
        <section
          key={direction}
          className="pay-block"
          aria-label={t(direction === 'incoming' ? 'incomingTitle' : 'outgoingTitle')}
          data-testid={`requests-${direction}`}
        >
          <h3 className="pay-section-title">{t(direction === 'incoming' ? 'incomingTitle' : 'outgoingTitle')}</h3>
          {lists[direction].length === 0 ? (
            <p className="pay-empty">{t(direction === 'incoming' ? 'listEmptyIncoming' : 'listEmptyOutgoing')}</p>
          ) : (
            <ul className="pay-list">
              {lists[direction].map((row) => (
                <li key={row.requestId} data-testid="server-request-row" data-request-id={row.requestId}>
                  <div className="pay-list__main">
                    <span>
                      {fmtAmount(row.amount, { places: 18 })} {row.assetId}
                    </span>
                    <StatusChip status={row.status} />
                  </div>
                  <div className="pay-list__sub">
                    {direction === 'incoming'
                      ? t('from', { handle: who(row.payeeHandle, row.payeeUserId) })
                      : t('to', { handle: who(row.payerHandle, row.payerUserId) })}
                    {row.note ? ` · ${row.note}` : ''}
                  </div>
                  <a className="pay-recent__link" href={`/pay/request/${row.requestId}`}>
                    {t('listOpen')}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </>
  );
}

type Load = { kind: 'loading' } | { kind: 'missing' } | { kind: 'error' } | { kind: 'ok'; request: ServerRequest };

/** One request kept by the bank (/pay/request/:requestId): the payer pays, declines or reports; the asker reminds or cancels. */
export function ServerRequestRoom({ id, onMissing }: { id: string; onMissing?: () => void }) {
  const { api, userId } = useSession();
  const requests = useMemo(() => createRequestsApi(api), [api]);
  const pay = useMemo(() => createPersonalPayApi(api, userId), [api, userId]);
  const { t } = requestsCopy.useCopy();
  const refusal = useRefusal();
  const { timeZone } = usePreferences();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [stepUp, setStepUp] = useState<{ code: string; problem: string | null } | null>(null);
  const [reporting, setReporting] = useState<{ reason: ReportReason; block: boolean } | null>(null);
  const [safety, setSafety] = useState<RequestSafety | null>(null);
  const [reminders, setReminders] = useState<ReminderFacts | 'unset' | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const remindKey = useRef<string | null>(null);
  const confirmingCode = useRef(false);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    void requests.get(id, controller.signal).then(async (result) => {
      if (controller.signal.aborted) return;
      if (!result.ok)
        return setLoad(
          result.code === 'bank.personal_request_not_found' || result.status === 404 ? { kind: 'missing' } : { kind: 'error' },
        );
      setLoad({ kind: 'ok', request: result.data });
      if (result.data.payerUserId === userId) {
        const read = await requests.safety(id, controller.signal);
        if (!controller.signal.aborted && read.ok) setSafety(read.data);
      } else if (result.data.payeeUserId === userId && result.data.status === 'open') {
        const read = await requests.reminders(id, controller.signal);
        if (controller.signal.aborted) return;
        if (read.ok) setReminders(read.data);
        else if (read.code === 'bank.reminder_policy_unset') setReminders('unset');
      }
    });
    return () => controller.abort();
  }, [requests, id, userId, attempt]);
  useEffect(() => {
    if (load.kind === 'missing') onMissing?.();
  }, [load.kind, onMissing]);

  if (load.kind === 'loading') return <div className="pay-block" aria-busy="true" data-testid="request-room-loading" />;
  if (load.kind === 'missing' && onMissing) return null;
  if (load.kind === 'missing')
    return (
      <StateBlock
        kind="empty"
        title={t('roomNotFound')}
        body={t('roomNotFoundBody')}
        action={{ label: t('listOpen'), href: '/pay/request' }}
      />
    );
  if (load.kind === 'error') return <StateBlock kind="error" title={t('roomLoadFailed')} onRetry={reload} retryLabel={t('listRetry')} />;
  const request = load.request;
  const iPay = request.payerUserId === userId;
  const payee = who(request.payeeHandle, request.payeeUserId);
  const payer = who(request.payerHandle, request.payerUserId);
  const shownAmount = fmtAmount(request.amount, { places: 18 });
  const open = request.status === 'open';

  async function payNow(stepUpApprovalId?: string) {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const spaces = await pay.spaces();
    const source = spaces.ok ? spaces.data.find((space) => space.assetId === request.assetId && space.kind === 'primary') : undefined;
    if (!source) {
      setBusy(false);
      return setProblem(spaces.ok ? t('payNoSpace', { asset: request.assetId }) : refusal(spaces));
    }
    const input = {
      transferId: requestTransferId(request.requestId),
      fromSpaceId: source.id,
      toUserId: request.payeeUserId,
      amount: request.amount,
      requestId: request.requestId,
    };
    const outcome = await pay.send(stepUpApprovalId ? { ...input, stepUpApprovalId } : input);
    setBusy(false);
    if (outcome.ok) {
      setConfirming(false);
      setStepUp(null);
      setReceipt(outcome.data.ledgerTxId);
      return reload();
    }
    if (stepUpAgain(outcome.code)) return setStepUp({ code: '', problem: null });
    setProblem(refusal(outcome));
    reload();
  }

  async function confirmCode() {
    if (!stepUp || busy || confirmingCode.current) return;
    confirmingCode.current = true;
    try {
      await confirmOnce(stepUp.code);
    } finally {
      confirmingCode.current = false;
    }
  }

  async function confirmOnce(typed: string) {
    const code = typed.trim();
    const input = {
      transferId: requestTransferId(request.requestId),
      toUserId: request.payeeUserId,
      amount: request.amount,
      requestId: request.requestId,
    };
    const spaces = await pay.spaces();
    const source = spaces.ok ? spaces.data.find((space) => space.assetId === request.assetId && space.kind === 'primary') : undefined;
    if (!source) return setProblem(t('payNoSpace', { asset: request.assetId }));
    const approved = await confirmWithStepUp(api, personSendStepUp(request.assetId, { ...input, fromSpaceId: source.id }), {
      totpCode: code,
    });
    if (!approved.ok) return setStepUp({ code: '', problem: stepUpProblem(approved) });
    await payNow(approved.data.stepUpApprovalId);
  }

  async function act(run: () => Promise<{ ok: boolean } & Record<string, unknown>>, done: string) {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const result = (await run()) as Awaited<ReturnType<typeof requests.decline>>;
    setBusy(false);
    if (!result.ok) {
      setProblem(refusal(result));
    } else setNote(done);
    reload();
  }

  async function remind() {
    if (busy) return;
    remindKey.current ??= `remind:${crypto.randomUUID()}`.slice(0, 64);
    setBusy(true);
    setProblem(null);
    const result = await requests.remind(request.requestId, remindKey.current);
    setBusy(false);
    // A definite answer ends this reminder; a lost reply keeps its key, so trying again is the same reminder.
    if (result.ok || result.code !== undefined) remindKey.current = null;
    if (result.ok) {
      setReminders(result.data.reminder);
      setNote(t('reminded'));
      return;
    }
    if (result.code === 'bank.reminder_policy_unset') setReminders('unset');
    setProblem(refusal(result));
    const read = await requests.reminders(request.requestId);
    if (read.ok) setReminders(read.data);
  }

  async function report() {
    if (!reporting || busy) return;
    setBusy(true);
    setProblem(null);
    const result = await requests.report(request.requestId, reporting.reason, reporting.block);
    setBusy(false);
    if (!result.ok) return setProblem(refusal(result));
    setReporting(null);
    setSafety(result.data.safety);
    reload();
  }

  return (
    <div className="pay-body" data-testid="request-room" data-request-id={request.requestId} data-status={request.status}>
      <p className="pay-hint">{iPay ? t('roomLineIncoming', { handle: payee }) : t('roomLineOutgoing', { handle: payer })}</p>
      <dl className="pay-quote" data-testid="request-facts">
        <div>
          <dt>{iPay ? t('roomFrom') : t('roomTo')}</dt>
          <dd data-testid="request-who">@{iPay ? payee : payer}</dd>
        </div>
        <div>
          <dt>{t('roomAmount')}</dt>
          <dd data-testid="request-amount">
            {shownAmount} {request.assetId}
          </dd>
        </div>
        <div>
          <dt>{t('roomNote')}</dt>
          <dd data-testid="request-note">{request.note ?? t('reviewNoNote')}</dd>
        </div>
        <div>
          <dt>{t('roomStatus')}</dt>
          <dd>
            <StatusChip status={request.status} />
          </dd>
        </div>
        <div>
          <dt>{t('roomExpires')}</dt>
          <dd>{stamp(request.expiresAt, timeZone, Date.now())}</dd>
        </div>
        {request.ledgerTxId ? (
          <div>
            <dt>{t('roomReceipt')}</dt>
            <dd data-testid="request-receipt" lang="zxx">
              {request.ledgerTxId}
            </dd>
          </div>
        ) : null}
      </dl>

      {receipt ? (
        <p className="pay-hint" role="status" data-testid="request-paid">
          {t('paid', { receipt })}
        </p>
      ) : null}
      {note ? (
        <p className="pay-hint" role="status" data-testid="request-note-shown">
          {note}
        </p>
      ) : null}
      {problem ? (
        <p className="pay-problem" role="alert" data-testid="request-problem">
          {problem}
        </p>
      ) : null}
      {request.status === 'paid' ? <p className="pay-hint">{t('closedPaid')}</p> : null}
      {request.status === 'expired' ? <p className="pay-hint">{t('closedExpired')}</p> : null}
      {request.status === 'declined' && iPay ? <p className="pay-hint">{t('declined', { handle: payee })}</p> : null}
      {iPay && !open && !safety && !reporting ? (
        <Button variant="ghost" size={40} onClick={() => setReporting({ reason: 'scam', block: true })} disabled={busy}>
          {t('reportOnly')}
        </Button>
      ) : null}

      {iPay && safety ? (
        <div
          className="pay-reason"
          role="note"
          data-testid="request-safety"
          data-case-id={safety.caseId}
          data-blocked={String(safety.blocked)}
        >
          <p className="pay-reason__title" data-testid="request-case">
            {t('reported', { caseId: safety.caseId })}
          </p>
          <p className="pay-reason__body" data-testid="request-block">
            {safety.blocked ? t('blocked', { handle: payee }) : t('notBlocked', { handle: payee })}
          </p>
        </div>
      ) : null}

      {iPay && open && !confirming && !reporting ? (
        <div className="pay-row-actions">
          <Button variant="primary" size={48} onClick={() => setConfirming(true)} disabled={busy} data-testid="request-pay">
            {t('pay', { amount: shownAmount, asset: request.assetId })}
          </Button>
          <Button
            variant="secondary"
            size={48}
            onClick={() => void act(() => requests.decline(request.requestId), t('declined', { handle: payee }))}
            disabled={busy}
          >
            {t('decline')}
          </Button>
          <Button variant="ghost" size={48} onClick={() => setReporting({ reason: 'scam', block: true })} disabled={busy}>
            {t('report')}
          </Button>
        </div>
      ) : null}

      {iPay && open && confirming ? (
        <section className="pay-block" aria-label={t('payConfirm')} data-testid="request-pay-review">
          <p className="pay-hint">{t('payReview', { handle: payee, amount: shownAmount, asset: request.assetId })}</p>
          {stepUp ? (
            <div className="pay-field">
              <label className="pay-field__label" htmlFor="request-step-up">
                {t('stepUpCode')}
              </label>
              <input
                id="request-step-up"
                className="pay-text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={stepUp.code}
                onChange={(event) => setStepUp({ code: event.target.value, problem: null })}
              />
              {stepUp.problem ? (
                <p className="pay-problem" role="alert">
                  {stepUp.problem}
                </p>
              ) : null}
              <Button variant="primary" size={48} onClick={() => void confirmCode()} disabled={busy}>
                {t('stepUpConfirm')}
              </Button>
            </div>
          ) : (
            <div className="pay-row-actions">
              <Button variant="primary" size={48} onClick={() => void payNow()} disabled={busy} data-testid="request-pay-confirm">
                {t('payConfirm')}
              </Button>
              <Button variant="ghost" size={48} onClick={() => setConfirming(false)} disabled={busy}>
                {t('payCancel')}
              </Button>
            </div>
          )}
        </section>
      ) : null}

      {iPay && reporting ? (
        <section className="pay-block" aria-label={t('reportTitle')} data-testid="request-report">
          <h3 className="pay-section-title">{t('reportTitle')}</h3>
          <p className="pay-hint">{t('reportBody', { handle: payee })}</p>
          <div className="pay-field">
            <label className="pay-field__label" htmlFor="request-report-reason">
              {t('reportReason')}
            </label>
            <select
              id="request-report-reason"
              className="pay-text"
              value={reporting.reason}
              onChange={(event) => setReporting({ ...reporting, reason: event.target.value as ReportReason })}
            >
              {reportReasons.map((reason) => (
                <option key={reason} value={reason}>
                  {t(`reason_${reason}`)}
                </option>
              ))}
            </select>
          </div>
          <label className="pay-check">
            <input
              type="checkbox"
              checked={reporting.block}
              onChange={(event) => setReporting({ ...reporting, block: event.target.checked })}
            />
            <span>{t('reportBlock', { handle: payee })}</span>
          </label>
          <div className="pay-row-actions">
            <Button variant="primary" size={48} onClick={() => void report()} disabled={busy} data-testid="request-report-send">
              {t('reportSend')}
            </Button>
            <Button variant="ghost" size={48} onClick={() => setReporting(null)} disabled={busy}>
              {t('payCancel')}
            </Button>
          </div>
        </section>
      ) : null}

      {!iPay && open ? (
        <div className="pay-block" data-testid="request-remind-block">
          {reminders === 'unset' ? (
            <p className="pay-hint">{t('remindUnset')}</p>
          ) : reminders ? (
            <>
              <p className="pay-hint" data-testid="request-remind-count">
                {t('remindCount', { sent: String(reminders.sentInWindow), cap: String(reminders.cap) })}
              </p>
              {reminders.nextAllowedAt ? (
                <p className="pay-hint" data-testid="request-remind-next" data-next={reminders.nextAllowedAt}>
                  {t('remindNext', { when: stamp(reminders.nextAllowedAt, timeZone, Date.now()) })}
                </p>
              ) : null}
            </>
          ) : null}
          <div className="pay-row-actions">
            <Button
              variant="primary"
              size={40}
              onClick={() => void remind()}
              disabled={busy || reminders === 'unset'}
              data-testid="request-remind"
            >
              {t('remind')}
            </Button>
            <Button
              variant="secondary"
              size={40}
              onClick={() => void act(() => requests.cancel(request.requestId), t('cancelled'))}
              disabled={busy}
            >
              {t('cancel')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
