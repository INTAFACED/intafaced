import { useEffect, useMemo, useState } from 'react';
import { createPersonRequestsApi, type PersonRequest, type RequestStatus } from '../../features/pay/person-requests';
import { Button, cleanAmount, cleanNote, NOTE_MAX, resolveHandle, useSession } from './deps';
import { askCopy } from './ask-copy';

const STATUS_KEY = {
  open: 'askStatusOpen',
  paid: 'askStatusPaid',
  declined: 'askStatusDeclined',
  cancelled: 'askStatusCancelled',
  expired: 'askStatusExpired',
} as const satisfies Record<RequestStatus, string>;

/** Rows each list asks svc-bank for: the newest 20. */
const LIST_LIMIT = 20;

type Review = {
  payerUserId: string;
  handle: string;
  assetId: string;
  amount: string;
  note: string | undefined;
  expiresAt: string;
  key: string;
};

/**
 * Ask one person for money (J-pay-05 #1). The person is found by handle, the request is reviewed, and svc-bank keeps it and
 * tells them. Nothing is defaulted: the coin, the amount and when it stops being payable are the asker's own choice.
 */
export function AskPersonCard({ assets }: { assets: string[] }) {
  const { t } = askCopy.useCopy();
  const { api, userId } = useSession();
  const requests = useMemo(() => createPersonRequestsApi(api), [api]);
  const [handle, setHandle] = useState('');
  const [asset, setAsset] = useState(assets[0] ?? '');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [payBy, setPayBy] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<PersonRequest | null>(null);
  const [listed, setListed] = useState(0);

  const chosen = assets.includes(asset) ? asset : (assets[0] ?? '');
  const valid = cleanAmount(amount);
  const reason = handle.trim() === '' ? t('askNeedWho') : valid === null ? t('askNeedAmount') : payBy === '' ? t('askNeedPayBy') : null;

  async function toReview() {
    if (reason !== null || valid === null) return;
    const expires = new Date(payBy);
    if (Number.isNaN(expires.getTime()) || expires.getTime() <= Date.now()) {
      setProblem(t('askPayByPast'));
      return;
    }
    setBusy(true);
    setProblem(null);
    const found = await resolveHandle(api, handle);
    setBusy(false);
    if (found.kind === 'notFound') return setProblem(t('askNotFound'));
    if (found.kind !== 'found') return setProblem(t('askLookupFailed'));
    if (found.self || (userId !== null && found.userId.toLowerCase() === userId.toLowerCase())) return setProblem(t('askSelf'));
    setReview({
      payerUserId: found.userId,
      handle: found.handle,
      assetId: chosen,
      amount: valid,
      note: cleanNote(note) ?? undefined,
      expiresAt: expires.toISOString(),
      key: crypto.randomUUID(),
    });
  }

  async function send(r: Review) {
    setBusy(true);
    setProblem(null);
    const result = await requests.create({
      payerUserId: r.payerUserId,
      assetId: r.assetId,
      amount: r.amount,
      ...(r.note ? { note: r.note } : {}),
      expiresAt: r.expiresAt,
      idempotencyKey: r.key,
    });
    setBusy(false);
    if (!result.ok) return setProblem(result.code ? `${result.message} (${result.code})` : result.message);
    setMade(result.data);
    setReview(null);
    setListed((n) => n + 1);
  }

  return (
    <div className="pay-block" data-testid="ask-person">
      <h3 className="pay-section-title">{t('askHeading')}</h3>
      <p className="pay-hint">{t('askHint')}</p>
      {made ? (
        <div data-testid="ask-made" data-request-id={made.requestId}>
          <p className="pay-section-title">{t('askMade')}</p>
          <p className="pay-hint">{t('askMadeHint')}</p>
          <div className="pay-row-actions">
            <Button variant="primary" size={40} nativeButton={false} render={<a href={`/pay/request/${made.requestId}`} />}>
              {t('askOpen')}
            </Button>
            <Button
              variant="ghost"
              size={40}
              onClick={() => {
                setMade(null);
                setHandle('');
                setAmount('');
                setNote('');
                setPayBy('');
              }}
            >
              {t('askAnother')}
            </Button>
          </div>
        </div>
      ) : review ? (
        <div data-testid="ask-review">
          <p className="pay-section-title">{t('askReviewHeading')}</p>
          <dl className="pay-quote">
            <div>
              <dt>{t('askReviewWho')}</dt>
              <dd>@{review.handle}</dd>
            </div>
            <div>
              <dt>{t('askReviewAmount')}</dt>
              <dd>{`${review.amount} ${review.assetId}`}</dd>
            </div>
            <div>
              <dt>{t('askReviewNote')}</dt>
              <dd>{review.note ?? t('askNone')}</dd>
            </div>
            <div>
              <dt>{t('askReviewPayBy')}</dt>
              <dd lang="zxx">{new Date(review.expiresAt).toLocaleString()}</dd>
            </div>
          </dl>
          <p className="pay-hint">{t('askReviewMoves')}</p>
          <div className="pay-row-actions">
            <Button variant="primary" size={40} disabled={busy} onClick={() => void send(review)} data-testid="ask-send">
              {busy ? t('askSending') : t('askSend')}
            </Button>
            <Button variant="ghost" size={40} disabled={busy} onClick={() => setReview(null)}>
              {t('askEdit')}
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="pay-body"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void toReview();
          }}
        >
          <div className="pay-field">
            <label className="pay-field__label" htmlFor="ask-who">
              {t('askWho')}
            </label>
            <input
              id="ask-who"
              className="pay-text"
              type="text"
              value={handle}
              autoComplete="off"
              placeholder={t('askWhoPlaceholder')}
              onChange={(event) => setHandle(event.target.value)}
            />
          </div>
          <div className="pay-field">
            <label className="pay-field__label" htmlFor="ask-asset">
              {t('askAsset')}
            </label>
            <select id="ask-asset" className="pay-text" value={chosen} onChange={(event) => setAsset(event.target.value)}>
              {assets.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </div>
          <div className="pay-field">
            <label className="pay-field__label" htmlFor="ask-amount">
              {t('askAmount')}
            </label>
            <input
              id="ask-amount"
              className="pay-text"
              type="text"
              inputMode="decimal"
              value={amount}
              autoComplete="off"
              onChange={(event) => setAmount(event.target.value)}
            />
          </div>
          <div className="pay-field">
            <label className="pay-field__label" htmlFor="ask-note">
              {t('askNote')}
            </label>
            <input
              id="ask-note"
              className="pay-text"
              type="text"
              value={note}
              maxLength={NOTE_MAX}
              autoComplete="off"
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          <div className="pay-field">
            <label className="pay-field__label" htmlFor="ask-pay-by">
              {t('askPayBy')}
            </label>
            <input
              id="ask-pay-by"
              className="pay-text"
              type="datetime-local"
              value={payBy}
              onChange={(event) => setPayBy(event.target.value)}
            />
          </div>
          <Button type="submit" variant="primary" size={56} fullWidth disabled={reason !== null || busy} data-testid="ask-review-button">
            {reason ?? t('askReview')}
          </Button>
        </form>
      )}
      {problem && (
        <p className="pay-problem" role="alert" data-testid="ask-problem">
          {t('askRefused')}: {problem}
        </p>
      )}
      <RequestLists refreshKey={listed} />
    </div>
  );
}

/** The person's requests as svc-bank lists them: the ones they sent and the ones sent to them, each with its status. */
function RequestLists({ refreshKey }: { refreshKey: number }) {
  const { t } = askCopy.useCopy();
  const { api } = useSession();
  const requests = useMemo(() => createPersonRequestsApi(api), [api]);
  const [lists, setLists] = useState<{ sent: PersonRequest[]; received: PersonRequest[] } | 'loading' | 'failed'>('loading');
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      requests.list('outgoing', LIST_LIMIT, controller.signal),
      requests.list('incoming', LIST_LIMIT, controller.signal),
    ]).then(([sent, received]) => {
      if (controller.signal.aborted) return;
      setLists(sent.ok && received.ok ? { sent: sent.data, received: received.data } : 'failed');
    });
    return () => controller.abort();
  }, [requests, refreshKey]);
  if (lists === 'loading') return null;
  if (lists === 'failed')
    return (
      <p className="pay-problem" role="alert">
        {t('askListFailed')}
      </p>
    );
  const list = (title: string, rows: PersonRequest[], testid: string, other: (r: PersonRequest) => string) => (
    <div className="pay-block" data-testid={testid}>
      <h4 className="pay-section-title">{title}</h4>
      {rows.length === 0 ? (
        <p className="pay-empty">{t('askNone')}</p>
      ) : (
        <ul className="pay-list">
          {rows.map((r) => (
            <li key={r.requestId} data-request-id={r.requestId} data-status={r.status}>
              <a href={`/pay/request/${r.requestId}`}>
                {other(r)} · {`${r.amount} ${r.assetId}`} · <strong>{t(STATUS_KEY[r.status])}</strong>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
  return (
    <>
      {list(t('askSent'), lists.sent, 'ask-sent', (r) => (r.payerHandle ? `@${r.payerHandle}` : r.payerUserId))}
      {list(t('askReceived'), lists.received, 'ask-received', (r) => (r.payeeHandle ? `@${r.payeeHandle}` : r.payeeUserId))}
    </>
  );
}
