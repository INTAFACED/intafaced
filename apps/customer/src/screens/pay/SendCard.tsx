import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Check, ClipboardPaste } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AmountInput,
  applyPrefill,
  bankPendingKey,
  Button,
  cleanNote,
  CoinIcon,
  contactLabel,
  contactsFrom,
  createPersonalPayApi,
  dec,
  fmtAmount,
  fractionDigits,
  isHiddenPath,
  NOTE_MAX,
  parseAmount,
  pendingOutcomes,
  readSent,
  receiptText,
  recordSent,
  refusalCopy,
  resolveHandle,
  resolvePayQr,
  cleanHandle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  sendInput,
  Skeleton,
  StateBlock,
  str,
  useHideBalances,
  HIDDEN_MASK,
  useSession,
  useToast,
  type ApiClient,
  type ApiResult,
  type Contact,
  type PaymentRequest,
  type PersonalPayApi,
  type SentEntry,
} from './deps';
import { payCopy } from './copy';
import { personalCopy } from './personal-copy';
import { copyText } from './share';
import { PAY_SENT_EVENT } from './recent-model';
import { termsVerdict, useSendTerms, type TermsVerdict } from './send-terms';
import { checkAmount, parseAccountId, rememberRecipient, sentBefore, sourcesFrom, type Source } from './send-model';
import type { IdentityState } from './identity-state';
import type { z } from 'zod';

export const ACTIVITY_HREF = '/money/activity?tab=transfers';
const SUPPORT_HREF = '/support';
/** "Available" shows what the customer holds, never more (rounded down), like Money does. */
const BALANCE_PLACES = 8;

type Recipient =
  | { kind: 'idle' }
  | { kind: 'checking' }
  /** `handle` is null in Account ID mode: the service could not tell us who they are. */
  | { kind: 'found'; userId: string; handle: string | null }
  /** `retry`: the answer says nothing about the person (busy or failed), so asking again is fine. */
  | { kind: 'problem'; text: string; retry?: boolean };

type Review = {
  input: z.infer<typeof sendInput>;
  source: Source;
  recipient: { userId: string; handle: string | null };
  firstTime: boolean;
  note: string | null;
  /** The published fee and what is left of today after this payment, as the service quoted them for this amount. */
  terms: Extract<TermsVerdict, { kind: 'ok' }>;
};
type Receipt = { entry: SentEntry; from: string };

/**
 * The last confirmed payment per signed-in user, kept outside the screen. If the customer leaves Pay while a payment is
 * on its way, the answer still clears the device note; this keeps the receipt so it is there when they come back.
 */
const lastReceipt = new Map<string, Receipt>();

/** Send (UI-SPEC 5.10): who, what, how much, then a review that cannot be skipped. */
export function SendCard({
  identity,
  prefill = null,
  prefillKey = '',
}: {
  identity: IdentityState;
  /** A payment link's suggestion for the form. It only fills fields; the customer still reviews and confirms. */
  prefill?: PaymentRequest | null;
  prefillKey?: string;
}) {
  const { api, userId } = useSession();
  const pay = useMemo(() => createPersonalPayApi(api, userId), [api, userId]);
  const [revision, reload] = useReducer((n: number) => n + 1, 0);
  // The list stays on screen while it is read again after a payment, so the receipt is never torn down by a reload.
  const [sources, setSources] = useState<{ owner: string | null; state: 'loading' | 'error' | { list: Source[] } }>({
    owner: null,
    state: 'loading',
  });
  useEffect(() => {
    const controller = new AbortController();
    void pay.spaces(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setSources((previous) => {
        if (result.ok) return { owner: userId, state: { list: sourcesFrom(result.data, Date.now()) } };
        return previous.owner === userId && typeof previous.state === 'object' ? previous : { owner: userId, state: 'error' };
      });
    });
    return () => controller.abort();
  }, [pay, userId, revision]);
  const loaded = sources.owner === userId ? sources.state : 'loading';
  const retrySources = () => {
    setSources({ owner: null, state: 'loading' });
    reload();
  };

  if (identity.status === 'loading' || loaded === 'loading')
    return (
      <div className="pay-body pay-body--skeleton" aria-busy="true" data-testid="send-loading">
        <Skeleton height={104} />
        <Skeleton height={132} />
        <Skeleton height={56} circle />
      </div>
    );
  if (identity.status === 'error')
    return (
      <StateBlock kind="error" title={payCopy.t('Couldn’t load your details')} onRetry={identity.retry} retryLabel={payCopy.t('Retry')} />
    );
  if (loaded === 'error')
    return (
      <StateBlock kind="error" title={payCopy.t('Couldn’t load your balances')} onRetry={retrySources} retryLabel={payCopy.t('Retry')} />
    );
  return (
    <SendForm
      api={api}
      pay={pay}
      userId={userId as string}
      sources={loaded.list}
      handles={identity.status === 'handles'}
      reload={reload}
      prefill={prefill}
      prefillKey={prefillKey}
    />
  );
}

function SendForm({
  api,
  pay,
  userId,
  sources,
  handles,
  reload,
  prefill,
  prefillKey,
}: {
  api: ApiClient;
  pay: PersonalPayApi;
  userId: string;
  sources: Source[];
  handles: boolean;
  reload: () => void;
  prefill: PaymentRequest | null;
  prefillKey: string;
}) {
  const personal = personalCopy.useCopy();
  // ── Who ──────────────────────────────────────────────────────────────────────────────────────────────────────
  // `handles` is what the server can do; `fallback` is set when a lookup finds the procedure missing after all.
  const [fallback, setFallback] = useState(false);
  const byHandle = handles && !fallback;
  const [to, setTo] = useState('');
  const [recipient, setRecipient] = useState<Recipient>({ kind: 'idle' });
  const [note, setNote] = useState<string | null>(null);
  const lookup = useRef<{ id: number; controller: AbortController | null }>({ id: 0, controller: null });
  // What this device remembers: a private note for this payment, people paid before, and what a payment link suggested.
  const [memo, setMemo] = useState('');
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const [remembered, rememberAgain] = useReducer((n: number) => n + 1, 0);
  const contacts = useMemo(() => contactsFrom(readSent(userId)), [userId, remembered]);
  const toast = useToast();

  function editTo(value: string) {
    // A new keystroke retires the answer for the old one, and any lookup still on its way.
    lookup.current.id += 1;
    lookup.current.controller?.abort();
    lookup.current.controller = null;
    setTo(value);
    setRecipient({ kind: 'idle' });
    setNote(null);
  }

  async function check(raw: string = to) {
    if (raw.trim() === '') return setRecipient({ kind: 'idle' });
    if (!byHandle) {
      const id = parseAccountId(raw);
      if (id === null) return setRecipient({ kind: 'problem', text: payCopy.t('Bad account ID') });
      if (id === userId.toLowerCase()) return setRecipient({ kind: 'problem', text: payCopy.t('That is you') });
      return setRecipient({ kind: 'found', userId: id, handle: null });
    }
    const handle = cleanHandle(raw);
    if (handle === null) return setRecipient({ kind: 'problem', text: payCopy.t('Bad handle') });
    const mine = ++lookup.current.id;
    lookup.current.controller?.abort();
    const controller = new AbortController();
    lookup.current.controller = controller;
    setRecipient({ kind: 'checking' });
    const outcome = await resolveHandle(api, handle, controller.signal);
    if (lookup.current.id !== mine || controller.signal.aborted) return;
    switch (outcome.kind) {
      case 'found':
        if (outcome.self || outcome.userId.toLowerCase() === userId.toLowerCase())
          return setRecipient({ kind: 'problem', text: payCopy.t('That is you') });
        return setRecipient({ kind: 'found', userId: outcome.userId, handle: outcome.handle });
      case 'notFound':
        return setRecipient({ kind: 'problem', text: payCopy.t('Handle not found', { handle }) });
      case 'rateLimited':
        return setRecipient({ kind: 'problem', text: payCopy.t('Lookup rate limited'), retry: true });
      case 'unavailable':
        // The server cannot do handles yet: switch to the Account ID input and say why.
        setFallback(true);
        setTo('');
        setNote(payCopy.t('Handles not on'));
        return setRecipient({ kind: 'idle' });
      case 'failed':
        return setRecipient({ kind: 'problem', text: payCopy.t('Lookup failed'), retry: true });
    }
  }

  /**
   * A scanned pay code (PP-send-request-11): the service says who it pays, by account id, even when their handle can't
   * be found. A code that does not verify is refused, and nothing in the link is trusted in its place.
   */
  async function scan(payload: string) {
    const mine = ++lookup.current.id;
    lookup.current.controller?.abort();
    const controller = new AbortController();
    lookup.current.controller = controller;
    setTo('');
    setRecipient({ kind: 'checking' });
    const outcome = await resolvePayQr(api, payload, controller.signal);
    if (lookup.current.id !== mine || controller.signal.aborted) return;
    switch (outcome.kind) {
      case 'found':
        if (outcome.self || outcome.userId.toLowerCase() === userId.toLowerCase())
          return setRecipient({ kind: 'problem', text: payCopy.t('That is you') });
        setTo(byHandle ? outcome.handle : outcome.userId);
        return setRecipient({ kind: 'found', userId: outcome.userId, handle: byHandle ? outcome.handle : null });
      case 'invalid':
        return setRecipient({ kind: 'problem', text: personal.t('qrInvalid') });
      case 'payeeUnavailable':
        return setRecipient({ kind: 'problem', text: personal.t('qrPayeeUnavailable') });
      case 'unset':
        return setRecipient({ kind: 'problem', text: personal.t('qrUnset') });
      case 'failed':
        return setRecipient({ kind: 'problem', text: personal.t('qrFailedSend') });
    }
  }

  /** A person paid before. A handle is looked up again, so a handle that moved to someone else is caught. */
  function pickContact(contact: Contact) {
    lookup.current.id += 1;
    lookup.current.controller?.abort();
    lookup.current.controller = null;
    setNote(null);
    if (byHandle && contact.handle) {
      setTo(contact.handle);
      void check(contact.handle);
      return;
    }
    setTo(contact.handle ?? contact.userId);
    setRecipient({ kind: 'found', userId: contact.userId, handle: byHandle ? contact.handle : null });
  }

  async function paste() {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      editTo(text);
      void check(text);
    } catch {
      setNote(payCopy.t('Paste blocked'));
    }
  }

  // ── What and how much ────────────────────────────────────────────────────────────────────────────────────────
  const [sourceId, setSourceId] = useState('');
  // The chosen asset, or the first one held. If the chosen one drops out (spent elsewhere, newly locked), nothing is
  // chosen and the amount is cleared: a typed number must never silently move to another asset.
  const source = sourceId === '' ? (sources[0] ?? null) : (sources.find((row) => row.id === sourceId) ?? null);
  const [amount, setAmount] = useState('');
  const sourceGone = sourceId !== '' && source === null;
  useEffect(() => {
    if (sourceGone) setAmount('');
  }, [sourceGone]);
  // Pin the default choice, so that if it drops out later it is "gone", not quietly replaced by the next asset.
  const firstId = sources[0]?.id ?? '';
  useEffect(() => {
    if (sourceId === '' && firstId !== '') setSourceId(firstId);
  }, [sourceId, firstId]);
  // A payment link fills the form once per link. Everything it sets can be changed, and nothing is sent without Review.
  const appliedLink = useRef('');
  useEffect(() => {
    if (!prefill || prefillKey === '' || appliedLink.current === prefillKey) return;
    appliedLink.current = prefillKey;
    // The warning is always shown first. The link's own words are quoted after it and never replace it.
    const notices: string[] = [personal.t('requestBannerPlain')];
    if (prefill.note) notices.push(personal.t('requestBanner', { note: prefill.note }));
    lookup.current.id += 1;
    lookup.current.controller?.abort();
    lookup.current.controller = null;
    if (prefill.qr) {
      void scan(prefill.qr);
    } else if (prefill.kind === 'handle' && byHandle) {
      setTo(prefill.to);
      void check(prefill.to);
    } else if (prefill.kind === 'accountId') {
      if (prefill.to === userId.toLowerCase()) {
        setTo('');
        setRecipient({ kind: 'problem', text: payCopy.t('That is you') });
      } else {
        setTo(prefill.to);
        setRecipient({ kind: 'found', userId: prefill.to, handle: null });
      }
    } else {
      setTo('');
      setRecipient({ kind: 'idle' });
      setNote(payCopy.t('Handles not on'));
    }
    const applied = applyPrefill(prefill, sources);
    if (applied.sourceId) setSourceId(applied.sourceId);
    setAmount(applied.amount);
    setMemo(prefill.note ?? '');
    if (applied.problem === 'assetNotHeld') notices.push(personal.t('requestAssetMissing', { asset: prefill.asset ?? '' }));
    if (applied.problem === 'amountTooLarge') notices.push(personal.t('requestAmountTooLarge'));
    setLinkNotice(notices.join(' '));
  }, [prefill, prefillKey]);
  const amountCheck = checkAmount(amount, source);
  // The limits and fee are read for an amount the customer could send; the service applies the same ones again.
  const typedAmount = amountCheck.kind === 'ok' ? dec(amount) : null;
  const quotedAmount = typedAmount === null ? null : str(typedAmount);
  const [terms, recheckTerms] = useSendTerms(pay, source?.asset ?? null, quotedAmount);
  const verdict = termsVerdict(terms, quotedAmount);
  const hideBalances = useHideBalances();
  const availableText = source
    ? hideBalances
      ? HIDDEN_MASK
      : `${fmtAmount(source.balance, { places: BALANCE_PLACES, round: 'down' })} ${source.asset}`
    : '';
  const places = source ? Math.min(18, Math.max(BALANCE_PLACES, fractionDigits(source.balance) ?? 0)) : BALANCE_PLACES;
  const amountError =
    amountCheck.kind === 'exceeds' && source ? payCopy.t('You have {value} available.', { value: availableText }) : undefined;
  const sourceItems = useMemo(() => Object.fromEntries(sources.map((row) => [row.id, labelOf(row)])), [sources]);

  // ── The safety layer, as PersonalPay uses it ─────────────────────────────────────────────────────────────────
  const key = `${userId}:send`;
  const [, refreshGuard] = useReducer((n: number) => n + 1, 0);
  const mounted = useRef(true);
  const recovering = useRef<object | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  // The device note is only ever read from storage again here; nothing is re-sent from it.
  useEffect(() => {
    mounted.current = true;
    const restore = async () => {
      await pay.guard.restore(key);
      if (mounted.current) refreshGuard();
    };
    const returned = () => {
      if (document.visibilityState === 'visible') void restore();
    };
    const changed = (event: StorageEvent) => {
      if (event.key === `pay.unresolved:${key}` || event.key === bankPendingKey(userId) || event.key === null) void restore();
    };
    void restore();
    window.addEventListener('storage', changed);
    window.addEventListener('focus', returned);
    document.addEventListener('visibilitychange', returned);
    return () => {
      mounted.current = false;
      window.removeEventListener('storage', changed);
      window.removeEventListener('focus', returned);
      document.removeEventListener('visibilitychange', returned);
    };
  }, [pay, key, userId]);
  const unresolved = pay.guard.status(key);
  const recoveryProblem = pay.guard.problem(key);
  const knownCleanup = pay.guard.knownCleanup(key);
  const knownConfirmed = pay.guard.knownConfirmed(key);
  let bankPending = false;
  try {
    bankPending = pendingOutcomes(userId).length > 0;
  } catch {
    bankPending = true;
  }
  const waiting = Boolean(unresolved) || bankPending;

  async function retryRecovery() {
    if (!mounted.current || !api.canWrite() || recovering.current) return;
    const action = {};
    recovering.current = action;
    setRecoveryBusy(true);
    try {
      if (knownCleanup) await pay.guard.cleanupKnown(key, () => mounted.current && api.canWrite(), pay.guard.knownProof(key));
      else await pay.guard.restore(key);
    } finally {
      if (recovering.current === action) recovering.current = null;
      if (mounted.current) {
        setRecoveryBusy(false);
        refreshGuard();
      }
    }
  }

  // ── Review and send: one transferId per review, never re-sent by code ───────────────────────────────────────
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const inFlight = useRef<object | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(() => lastReceipt.get(key) ?? null);

  // Enter looks the person up when nothing has been asked yet, or when the last try failed or was rationed.
  const retryable = recipient.kind === 'idle' || (recipient.kind === 'problem' && recipient.retry === true);

  const reason: string | null = waiting
    ? payCopy.t('Still confirming')
    : recipient.kind !== 'found'
      ? payCopy.t('Choose who to pay')
      : !source
        ? payCopy.t('Choose what to send')
        : amountCheck.kind === 'exceeds'
          ? payCopy.t('Not enough {asset}', { asset: source.asset })
          : amountCheck.kind !== 'ok'
            ? payCopy.t('Enter an amount')
            : termsBlock(verdict, personal);

  function prepare() {
    if (reason !== null || recipient.kind !== 'found' || !source || inFlight.current || verdict.kind !== 'ok') return;
    const canonical = dec(amount);
    if (canonical === null) return;
    const note = cleanNote(memo);
    const parsed = sendInput.safeParse({
      // Made once for this review and kept until it is closed: a retry inside the same review carries the same id.
      transferId: crypto.randomUUID(),
      fromSpaceId: source.id,
      toUserId: recipient.userId,
      amount: str(canonical),
      ...(note ? { note } : {}),
    });
    if (!parsed.success) return (setFailure(payCopy.t('Check amount and recipient')), setReview(null));
    setFailure(null);
    setReview({
      input: parsed.data,
      source,
      recipient: { userId: recipient.userId, handle: recipient.handle },
      firstTime: !sentBefore(userId, recipient.userId),
      note,
      terms: verdict,
    });
  }

  function closeReview() {
    // While a request is on its way the dialog cannot be dismissed: the answer must be seen.
    if (inFlight.current) return;
    setReview(null);
    setFailure(null);
  }

  async function confirm() {
    if (!review || inFlight.current) return;
    if (pay.guard.status(key) || bankPending) return refreshGuard();
    const action = {};
    inFlight.current = action;
    setBusy(true);
    setFailure(null);
    let outcome: ApiResult<{ ledgerTxId: string; amount: string }>;
    try {
      // `isCurrent` only asks "is it still this signed-in person": a definitive answer must clear the note even if the
      // screen was left meanwhile, or the customer would be stuck "confirming" a payment that is already known.
      outcome = await pay.send(
        review.input,
        () => api.canWrite(),
        () => api.canWrite(),
      );
    } finally {
      inFlight.current = null;
    }
    if (outcome.ok) {
      // Kept even if the screen was left meanwhile: the note is cleared by a definitive answer, so the receipt must outlive it.
      const entry: SentEntry = {
        transferId: review.input.transferId,
        ledgerTxId: outcome.data.ledgerTxId,
        toUserId: review.recipient.userId,
        handle: review.recipient.handle,
        amount: outcome.data.amount,
        asset: review.source.asset,
        note: review.note,
        at: new Date().toISOString(),
      };
      const confirmed: Receipt = { entry, from: labelFrom(review.source) };
      rememberRecipient(userId, review.recipient.userId);
      recordSent(userId, entry);
      window.dispatchEvent(new Event(PAY_SENT_EVENT));
      lastReceipt.set(key, confirmed);
      if (!mounted.current) return;
      setBusy(false);
      refreshGuard();
      setReceipt(confirmed);
      setReview(null);
      setAmount('');
      setMemo('');
      setLinkNotice(null);
      rememberAgain();
      reload();
      return;
    }
    if (!mounted.current) return;
    setBusy(false);
    refreshGuard();
    if (outcome.reason === 'uncertain' || outcome.reason === 'aborted') {
      // The guard now holds the original: Send stays off until it is settled. No automatic retry.
      setReview(null);
      return;
    }
    setFailure(failureText(outcome, review.source, review.recipient.handle));
    // Funds may have moved on while the review was open: read them again.
    reload();
  }

  // ── Receipt ──────────────────────────────────────────────────────────────────────────────────────────────────
  if (receipt) {
    const { entry } = receipt;
    const shownAmount = fmtAmount(entry.amount, { places: 18 });
    const shown = `${shownAmount} ${entry.asset}`;
    const labels = {
      title: personal.t('receiptTitle'),
      to: personal.t('receiptTo'),
      amount: personal.t('receiptAmount'),
      when: personal.t('receiptWhen'),
      reference: personal.t('receiptReference'),
      note: personal.t('noteRow'),
    };
    const copyReceipt = async () => {
      const ok = await copyText(receiptText(entry, labels));
      toast.add({ title: ok ? personal.t('receiptCopied') : personal.t('receiptCopyFailed'), timeout: ok ? 2000 : 4000 });
    };
    const sendAgain = () => {
      lastReceipt.delete(key);
      setReceipt(null);
      const again = sources.find((row) => row.asset === entry.asset) ?? null;
      setSourceId(again?.id ?? '');
      setAmount(again ? entry.amount : '');
      setMemo(entry.note ?? '');
      pickContact({ userId: entry.toUserId, handle: entry.handle, lastAt: entry.at, times: 1 });
    };
    return (
      <div className="pay-body" data-testid="pay-receipt">
        <div className="buy-receipt" role="status">
          <span className="buy-receipt__badge" aria-hidden="true" data-tone="ok">
            ✓
          </span>
          <h2 data-testid="buy-receipt__title" className="buy-receipt__title">
            {entry.handle
              ? payCopy.t('Sent {amount} {asset} to @{handle}', { amount: shownAmount, asset: entry.asset, handle: entry.handle })
              : payCopy.t('Sent {amount} {asset}', { amount: shownAmount, asset: entry.asset })}
          </h2>
          <dl className="buy-receipt__rows">
            <div>
              <dt>{personal.t('receiptTo')}</dt>
              <dd className={entry.handle ? undefined : 'pay-mono'}>{entry.handle ? `@${entry.handle}` : entry.toUserId}</dd>
            </div>
            <div>
              <dt>{personal.t('receiptFrom')}</dt>
              <dd>{receipt.from}</dd>
            </div>
            <div>
              <dt>{payCopy.t('Amount')}</dt>
              <dd data-testid="pay-receipt-amount">{shown}</dd>
            </div>
            <div>
              <dt>{personal.t('receiptWhen')}</dt>
              <dd>{new Date(entry.at).toLocaleString(personal.requestedLocale)}</dd>
            </div>
            <div>
              <dt>{personal.t('receiptReference')}</dt>
              <dd className="pay-mono" data-testid="pay-receipt-reference">
                {entry.ledgerTxId}
              </dd>
            </div>
            {entry.note ? (
              <div>
                <dt>{personal.t('noteRow')}</dt>
                <dd>{entry.note}</dd>
              </div>
            ) : null}
          </dl>
          <div className="buy-receipt__actions">
            <Button variant="primary" size={56} fullWidth nativeButton={false} render={<a href={ACTIVITY_HREF} role="link" />}>
              {payCopy.t('View activity')}
            </Button>
            <Button variant="secondary" size={56} fullWidth onClick={() => void copyReceipt()}>
              {personal.t('receiptCopy')}
            </Button>
            <Button variant="secondary" size={56} fullWidth onClick={sendAgain} data-testid="pay-send-again">
              {personal.t('sendAgain')}
            </Button>
            <Button
              variant="ghost"
              size={56}
              fullWidth
              onClick={() => {
                lastReceipt.delete(key);
                setReceipt(null);
                setSourceId('');
                editTo('');
              }}
            >
              {payCopy.t('Done')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (sources.length === 0 && !waiting)
    return (
      <StateBlock
        kind="empty"
        title={payCopy.t('Nothing to send title')}
        body={payCopy.t('Nothing to send body')}
        action={isHiddenPath('/uc/recharge') ? undefined : { label: payCopy.t('Add money'), href: '/uc/recharge' }}
      />
    );

  const firstTimeText = review?.firstTime
    ? review.recipient.handle
      ? payCopy.t('First time handle', { handle: review.recipient.handle })
      : payCopy.t('First time account')
    : null;
  const reviewAmount = review ? fmtAmount(review.input.amount, { places: 18 }) : '';

  return (
    <form
      className="pay-body"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        // Enter in the To field looks the person up first; a second Enter (or the button) reviews.
        if (retryable && to.trim() !== '') void check();
        else prepare();
      }}
    >
      {waiting ? (
        <WaitingNotice
          recoveryProblem={Boolean(recoveryProblem)}
          knownCleanup={knownCleanup}
          knownConfirmed={knownConfirmed}
          busy={recoveryBusy}
          onRetry={() => void retryRecovery()}
          showActivity={!(recoveryProblem && !knownCleanup)}
        />
      ) : null}

      {linkNotice ? (
        <p className="pay-banner" role="status" data-testid="pay-link-notice">
          {linkNotice}
        </p>
      ) : null}

      <div className="pay-field" data-testid="to-field">
        <label className="pay-field__label" htmlFor="pay-to">
          {byHandle ? payCopy.t('To') : payCopy.t('Account ID')}
        </label>
        <div className="pay-to">
          {byHandle ? (
            <span data-testid="pay-to__at" className="pay-to__at" aria-hidden="true">
              @
            </span>
          ) : null}
          <input
            id="pay-to"
            className="pay-to__input"
            type="text"
            value={to}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={byHandle ? 33 : 64}
            placeholder={byHandle ? payCopy.t('Handle placeholder') : payCopy.t('Account ID placeholder')}
            aria-label={byHandle ? payCopy.t('Handle') : payCopy.t('Account ID')}
            aria-invalid={recipient.kind === 'problem' || undefined}
            aria-describedby="pay-to-status"
            onChange={(event) => editTo(event.target.value)}
            onKeyDown={(event) => {
              // A disabled Review button blocks Enter's own submit, so the lookup is started here.
              if (event.key === 'Enter') {
                event.preventDefault();
                if (retryable && to.trim() !== '') void check();
                else prepare();
              }
            }}
            onBlur={() => {
              if (recipient.kind === 'idle' && to.trim() !== '') void check();
            }}
            data-mono={byHandle ? undefined : ''}
          />
          {byHandle ? null : (
            <button type="button" className="pay-chip" onClick={() => void paste()}>
              <ClipboardPaste size={14} aria-hidden="true" />
              {payCopy.t('Paste')}
            </button>
          )}
        </div>
        <div id="pay-to-status" className="pay-to__status" aria-live="polite" data-testid="to-status">
          {recipient.kind === 'checking' ? (
            <span className="pay-muted">{payCopy.t('Checking handle')}</span>
          ) : recipient.kind === 'found' ? (
            <span className="pay-found" data-testid="recipient-found">
              <span className="pay-avatar" aria-hidden="true">
                {(recipient.handle ?? '#').slice(0, 1).toUpperCase()}
              </span>
              <span className="pay-found__name">{recipient.handle ? `@${recipient.handle}` : payCopy.t('Account ID ready')}</span>
              <Check size={16} className="pay-found__check" aria-hidden="true" />
            </span>
          ) : recipient.kind === 'problem' ? (
            <span className="pay-problem" role="alert">
              {recipient.text}
              {recipient.retry ? (
                <button type="button" className="pay-chip" onClick={() => void check()}>
                  {payCopy.t('Try again')}
                </button>
              ) : null}
            </span>
          ) : note ? (
            <span className="pay-muted">{note}</span>
          ) : (
            <span className="pay-muted">{byHandle ? payCopy.t('Ask for their handle') : payCopy.t('Ask for their account ID')}</span>
          )}
        </div>
        {contacts.length > 0 && recipient.kind !== 'found' ? (
          <div className="pay-contacts" data-testid="pay-contacts">
            <span className="pay-contacts__label">{personal.t('recent')}</span>
            {contacts.map((contact) => (
              <button
                key={contact.userId}
                type="button"
                className="pay-chip"
                onClick={() => pickContact(contact)}
                data-testid="pay-contact"
              >
                {contactLabel(contact)}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="pay-field" data-testid="amount-field">
        <span className="pay-field__label">{payCopy.t('Amount')}</span>
        <div className="pay-field__main">
          <Select
            items={sourceItems}
            value={source?.id ?? ''}
            onValueChange={(value) => {
              if (typeof value === 'string') {
                setSourceId(value);
                setAmount('');
              }
            }}
          >
            <SelectTrigger className="pay-asset" aria-label={payCopy.t('Asset to send')}>
              {source ? <CoinIcon asset={source.asset} size={28} /> : null}
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sources.map((row) => (
                <SelectItem key={row.id} value={row.id}>
                  {labelOf(row)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <AmountInput
            size="hero"
            aria-label={payCopy.t('Amount to send')}
            value={amount}
            onValueChange={setAmount}
            precision={places}
            placeholder="0"
            error={amountError}
            className="pay-amount"
          />
        </div>
        <div className="pay-field__foot">
          <span data-testid="pay-available">{source ? payCopy.t('Available {value}', { value: availableText }) : ''}</span>
          {source && !waiting ? (
            <button
              type="button"
              className="pay-chip"
              onClick={() => {
                const whole = dec(source.balance);
                if (whole !== null) setAmount(str(whole));
              }}
            >
              {payCopy.t('Max')}
            </button>
          ) : null}
        </div>
        <TermsLine verdict={verdict} asset={source?.asset ?? ''} onRetry={recheckTerms} />
      </div>

      <div className="pay-field" data-testid="note-field">
        <label className="pay-field__label" htmlFor="pay-note">
          {personal.t('note')}
        </label>
        <input
          id="pay-note"
          className="pay-text"
          type="text"
          value={memo}
          maxLength={NOTE_MAX}
          autoComplete="off"
          placeholder={personal.t('notePlaceholder')}
          onChange={(event) => setMemo(event.target.value)}
        />
        <span className="pay-hint">{personal.t('noteHint')}</span>
      </div>

      <Button type="submit" variant="primary" size={56} fullWidth disabled={reason !== null} data-testid="pay-review">
        {reason !== null && !waiting ? reason : payCopy.t('Review')}
      </Button>

      <AlertDialog open={review !== null} onOpenChange={(open) => !open && closeReview()}>
        <AlertDialogContent className="pay-dialog" data-testid="pay-dialog">
          {review ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {review.recipient.handle
                    ? payCopy.t('Send {amount} {asset} to @{handle}?', {
                        amount: reviewAmount,
                        asset: review.source.asset,
                        handle: review.recipient.handle,
                      })
                    : payCopy.t('Send {amount} {asset} to this account?', { amount: reviewAmount, asset: review.source.asset })}
                </AlertDialogTitle>
                <AlertDialogDescription>{payCopy.t('Arrives instantly')}</AlertDialogDescription>
              </AlertDialogHeader>
              <dl className="pay-dialog__rows">
                <div>
                  <dt>{payCopy.t('To')}</dt>
                  <dd className={review.recipient.handle ? undefined : 'pay-mono'}>
                    {review.recipient.handle ? `@${review.recipient.handle}` : review.recipient.userId}
                  </dd>
                </div>
                <div>
                  <dt>{payCopy.t('From')}</dt>
                  <dd>{labelFrom(review.source)}</dd>
                </div>
                {review.note ? (
                  <div>
                    <dt>{personal.t('noteRow')}</dt>
                    <dd>{review.note}</dd>
                  </div>
                ) : null}
                <div data-testid="pay-review-fee">
                  <dt>{personal.t('termsFeeRow')}</dt>
                  <dd>
                    {parseAmount(review.terms.fee) === 0n
                      ? personal.t('termsNoFee')
                      : `${fmtAmount(review.terms.fee, { places: 18 })} ${review.source.asset}`}
                  </dd>
                </div>
                <div data-testid="pay-review-left">
                  <dt>{personal.t('termsLeftRow')}</dt>
                  <dd>
                    {fmtAmount(review.terms.leftAfter, { places: 18 })} {review.source.asset}
                  </dd>
                </div>
                <div data-strong="">
                  <dt>{payCopy.t('Amount')}</dt>
                  <dd>
                    {reviewAmount} {review.source.asset}
                  </dd>
                </div>
              </dl>
              {firstTimeText ? (
                <p className="pay-dialog__first" data-testid="pay-first-time">
                  {firstTimeText}
                </p>
              ) : null}
              {failure ? (
                <p className="pay-dialog__error" role="alert" data-testid="pay-failure">
                  {failure}
                </p>
              ) : null}
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="secondary" size={48} disabled={busy} />}>{payCopy.t('Cancel')}</AlertDialogClose>
                <Button
                  variant="primary"
                  size={48}
                  onClick={() => void confirm()}
                  loading={busy}
                  disabled={busy || waiting}
                  data-testid="pay-send"
                >
                  {busy ? payCopy.t('Sending') : payCopy.t('Send now')}
                </Button>
              </AlertDialogFooter>
            </>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}

type PersonalCopy = ReturnType<typeof personalCopy.useCopy>;

/** Why Review is off because of the published terms, in a few words for the button. Null when they allow the send. */
function termsBlock(verdict: TermsVerdict, personal: PersonalCopy): string | null {
  switch (verdict.kind) {
    case 'none':
    case 'ok':
      return null;
    case 'checking':
      return personal.t('termsBlockChecking');
    case 'unset':
    case 'feeUnwired':
      return personal.t('termsBlockPaused');
    case 'overPayment':
    case 'overDaily':
      return personal.t('termsBlockOver');
    case 'unavailable':
      return personal.t('termsBlockUnavailable');
  }
}

/** The fee and today's allowance under the amount, or the plain reason the amount cannot be sent. */
function TermsLine({ verdict, asset, onRetry }: { verdict: TermsVerdict; asset: string; onRetry: () => void }) {
  const personal = personalCopy.useCopy();
  const amountOf = (value: string) => fmtAmount(value, { places: 18 });
  if (verdict.kind === 'none') return null;
  if (verdict.kind === 'unavailable')
    return (
      <p className="pay-hint" role="alert" data-testid="pay-terms" data-terms="unavailable">
        {personal.t('termsUnavailable')}{' '}
        <button type="button" className="pay-chip" onClick={onRetry}>
          {personal.t('termsRetry')}
        </button>
      </p>
    );
  const text =
    verdict.kind === 'checking'
      ? personal.t('termsChecking')
      : verdict.kind === 'unset'
        ? personal.t('termsUnset', { asset })
        : verdict.kind === 'feeUnwired'
          ? personal.t('termsFeeUnwired', { asset })
          : verdict.kind === 'overPayment'
            ? personal.t('termsOverPayment', { limit: amountOf(verdict.limit), asset })
            : verdict.kind === 'overDaily'
              ? personal.t('termsOverDaily', { left: amountOf(verdict.left), asset })
              : `${parseAmount(verdict.fee) === 0n ? personal.t('termsNoFee') : personal.t('termsFee', { fee: amountOf(verdict.fee), asset })}. ${personal.t('termsAllowance', { perTransfer: amountOf(verdict.perTransfer), left: amountOf(verdict.left), asset })}`;
  const blocked = verdict.kind !== 'ok' && verdict.kind !== 'checking';
  return (
    <p className="pay-hint" role={blocked ? 'alert' : 'status'} data-testid="pay-terms" data-terms={verdict.kind}>
      {text}
    </p>
  );
}

const labelOf = (row: Source) => (row.name ? `${row.asset} · ${row.name}` : row.asset);
const labelFrom = (row: Source) =>
  row.name ? payCopy.t('Your {asset} in {name}', { asset: row.asset, name: row.name }) : payCopy.t('Your {asset}', { asset: row.asset });

/** A refused payment in plain words. Only called for answers that are definitive: nothing moved. */
function failureText(outcome: Extract<ApiResult<unknown>, { ok: false }>, source: Source, handle: string | null): string {
  const available = `${fmtAmount(source.balance, { places: BALANCE_PLACES, round: 'down' })}`;
  switch (outcome.code) {
    case 'pay.amount_exceeds_balance':
      return payCopy.t('You have {value} available.', { value: `${available} ${source.asset}` });
    case 'pay.recipient_self':
      return payCopy.t('That is you');
    case 'pay.source_locked':
      return payCopy.t('Balance locked');
    case 'pay.input_invalid':
    case 'pay.source_invalid':
      return payCopy.t('Check amount and recipient');
    case 'pay.recovery_journal_unavailable':
      return payCopy.t('No safe storage');
  }
  if (outcome.reason === 'unauthorized') return payCopy.t('Sign in again');
  if (outcome.status === 429) return payCopy.t('Too many tries');
  if (outcome.code === 'bank.dest_user_missing' && !handle) return payCopy.t('Account not found');
  if (outcome.code) {
    const words = refusalCopy(outcome.code, { asset: source.asset, available, ...(handle ? { recipient: `@${handle}` } : {}) });
    return `${words.title}. ${words.body}`;
  }
  return payCopy.t('Not sent');
}

function WaitingNotice({
  recoveryProblem,
  knownCleanup,
  knownConfirmed,
  busy,
  onRetry,
  showActivity,
}: {
  recoveryProblem: boolean;
  knownCleanup: boolean;
  knownConfirmed: boolean;
  busy: boolean;
  onRetry: () => void;
  showActivity: boolean;
}) {
  const title = knownCleanup
    ? knownConfirmed
      ? payCopy.t('Went through title')
      : payCopy.t('Did not go through title')
    : recoveryProblem
      ? payCopy.t('Check storage title')
      : payCopy.t('Still confirming');
  const body = knownCleanup
    ? knownConfirmed
      ? payCopy.t('Went through body')
      : payCopy.t('Did not go through body')
    : recoveryProblem
      ? payCopy.t('Check storage body')
      : payCopy.t('Still confirming body');
  return (
    <div className="pay-waiting" role="status" data-testid="pay-waiting">
      <p className="pay-waiting__title">{title}</p>
      <p className="pay-waiting__body">{body}</p>
      <div className="pay-waiting__actions">
        {knownCleanup || recoveryProblem ? (
          <Button variant="secondary" size={40} disabled={busy} onClick={onRetry}>
            {busy ? payCopy.t('Working') : knownCleanup ? payCopy.t('Finish up') : payCopy.t('Try again')}
          </Button>
        ) : null}
        {showActivity ? (
          <Button variant="secondary" size={40} nativeButton={false} render={<a href={ACTIVITY_HREF} role="link" />}>
            {payCopy.t('View activity')}
          </Button>
        ) : null}
        {isHiddenPath(SUPPORT_HREF) ? null : (
          <Button variant="ghost" size={40} nativeButton={false} render={<a href={SUPPORT_HREF} role="link" />}>
            {payCopy.t('Contact support')}
          </Button>
        )}
      </div>
    </div>
  );
}
