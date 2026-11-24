import { useMemo, useReducer, useRef, useState } from 'react';
import { useEventListener, useMounted } from '../../shared/outside';
import { useResource, type Resource } from '../../shared/resource';
import { ClipboardPaste } from 'lucide-react';
import { AmountField, AssetIcon, Button, EmptyState, Field, HIDDEN_MASK, StatusNote, useToast } from '@intafaced/ui/lit';
import { Payee as PayeeCard } from '@intafaced/ui/lit';
import { Dialog, KeyValue, SelectField, Skeleton, TextField, type KeyValueRow } from '@intafaced/ui/lit/templates';
import { usePreferences } from '../../shared/preferences';
import {
  applyPrefill,
  bankPendingKey,
  classifyFailure,
  cleanNote,
  contactLabel,
  contactsFrom,
  createPersonalPayApi,
  dec,
  fetchPayeeCard,
  fetchSavedRecipients,
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
  resolveContact,
  contactKind,
  resolvePayQr,
  cleanHandle,
  confirmWithStepUp,
  personSendStepUp,
  sendInput,
  str,
  useSession,
  type ApiClient,
  type ApiResult,
  type Contact,
  type PaymentRequest,
  type PersonalPayApi,
  type SavedRecipientsOutcome,
  type SentEntry,
  type StepUpMethod,
} from './deps';
import { payCopy } from './copy';
import { SpacesRefused } from './SpacesRefused';
import { personalCopy } from './personal-copy';
import { copyText } from './share';
import { stepUpAgain, stepUpProblem, type StepUpHow } from './send-step-up';
import { heldSendHref, SEND_IN_REVIEW } from '../../features/pay/held-send';
import { PAY_SENT_EVENT } from './recent-model';
import { termsVerdict, useSendTerms, type TermsVerdict } from './send-terms';
import {
  checkAmount,
  lookalikeOf,
  SAVED_PAGE,
  parseAccountId,
  rememberRecipient,
  sentBefore,
  sourcesFrom,
  type Source,
} from './send-model';
import type { IdentityState } from './identity-state';
import type { z } from 'zod';

export const ACTIVITY_HREF = '/money/activity?tab=transfers';
const SUPPORT_HREF = '/support';
/** "Available" shows what the customer holds, never more (rounded down), like Money does. */
const BALANCE_PLACES = 8;

/**
 * Who the customer is about to pay. `handle` is null in Account ID mode: the service could not tell us who they are.
 * `name` is the name on their profile and `memberSince` the month they joined (`YYYY-MM`), when the lookup said so.
 * `member` is true when the service itself confirmed a member behind the handle or pay code.
 */
type Payee = {
  userId: string;
  handle: string | null;
  /** Undefined when nothing was asked about their name (a pay code, an Account ID, an older server): no line is shown. */
  name?: string | null;
  memberSince: string | null;
  member: boolean;
};
const payee = (userId: string, handle: string | null, more: Partial<Omit<Payee, 'userId' | 'handle'>> = {}): Payee => ({
  userId,
  handle,
  ...(more.name !== undefined ? { name: more.name } : {}),
  memberSince: more.memberSince ?? null,
  member: more.member ?? false,
});

type Recipient =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | ({ kind: 'found' } & Payee)
  /** `retry`: the answer says nothing about the person (busy or failed), so asking again is fine. */
  | { kind: 'problem'; text: string; retry?: boolean };

type Review = {
  input: z.infer<typeof sendInput>;
  source: Source;
  recipient: Payee;
  firstTime: boolean;
  /** The saved recipient this handle looks like, when it does: the caution stays on the review too. */
  lookalike: string | null;
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
  // `refused`: the bank answered why it won't list them (a person not yet verified), said in its own words, never as a failure.
  const [sources, setSources] = useState<{
    owner: string | null;
    state: 'loading' | 'error' | { refused: string } | { list: Source[] };
  }>({
    owner: null,
    state: 'loading',
  });
  const spacesRead = useResource<Source[] | { refused: string } | null>(
    (signal) =>
      pay.spaces(signal).then((result) => {
        if (result.ok) return { ok: true as const, data: sourcesFrom(result.data, Date.now()) };
        const failure = classifyFailure(result);
        return { ok: true as const, data: failure.kind === 'refused' ? { refused: failure.code } : null };
      }),
    `pay:send:spaces:${userId}:${revision}`,
  );
  // A list that has just arrived is taken once; a failed read keeps the list already on screen for this account.
  const [spacesSeen, setSpacesSeen] = useState<Resource<Source[] | { refused: string } | null> | null>(null);
  if (spacesRead.resource.status === 'ready' && spacesRead.resource !== spacesSeen) {
    setSpacesSeen(spacesRead.resource);
    const list = spacesRead.resource.data;
    setSources((previous) => {
      if (Array.isArray(list)) return { owner: userId, state: { list } };
      if (list) return { owner: userId, state: list };
      return previous.owner === userId && typeof previous.state === 'object' ? previous : { owner: userId, state: 'error' };
    });
  }
  const loaded = sources.owner === userId ? sources.state : 'loading';
  const retrySources = () => {
    setSources({ owner: null, state: 'loading' });
    reload();
  };

  if (identity.status === 'loading' || loaded === 'loading')
    return (
      <div aria-busy="true" data-testid="send-loading">
        <Skeleton shape="form" count={3} />
      </div>
    );
  if (identity.status === 'error')
    return (
      <StatusNote
        tone="error"
        title={payCopy.t('Couldn’t load your details')}
        actions={<Button onClick={() => identity.retry()}>{payCopy.t('Retry')}</Button>}
      />
    );
  if (loaded === 'error')
    return (
      <StatusNote
        tone="error"
        title={payCopy.t('Couldn’t load your balances')}
        actions={<Button onClick={() => retrySources()}>{payCopy.t('Retry')}</Button>}
      />
    );
  if ('refused' in loaded) return <SpacesRefused code={loaded.refused} />;
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
  // The pay code being read, so "Try again" reads the code again rather than the empty To field.
  const scanned = useRef<string | null>(null);
  // What this device remembers: a private note for this payment, people paid before, and what a payment link suggested.
  const [memo, setMemo] = useState('');
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const [remembered, rememberAgain] = useReducer((n: number) => n + 1, 0);
  const contacts = useMemo(() => contactsFrom(readSent(userId)), [userId, remembered]);
  const toast = useToast();
  // The people this customer saved to pay again: a looked-up handle is checked against them (J-pay-01 #2).
  // Kept with the account it was read for, so another account's list is never used after a switch.
  const savedRead = useResource<SavedRecipientsOutcome>(
    (signal) => fetchSavedRecipients(api, signal).then((outcome) => ({ ok: true as const, data: outcome })),
    `pay:send:saved:${userId}`,
  );
  const saved: SavedRecipientsOutcome | { kind: 'loading' } =
    savedRead.resource.status === 'ready' ? savedRead.resource.data : { kind: 'loading' };

  function editTo(value: string) {
    // A new keystroke retires the answer for the old one, and any lookup still on its way.
    lookup.current.id += 1;
    lookup.current.controller?.abort();
    lookup.current.controller = null;
    scanned.current = null;
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
      return setRecipient({ kind: 'found', ...payee(id, null) });
    }
    // An email or a phone the person added as a way to receive (PP-send-request-03) finds them like a handle does.
    const contact = contactKind(raw) !== null;
    const handle = contact ? null : cleanHandle(raw);
    if (!contact && handle === null) return setRecipient({ kind: 'problem', text: payCopy.t('Bad handle') });
    const mine = ++lookup.current.id;
    lookup.current.controller?.abort();
    const controller = new AbortController();
    lookup.current.controller = controller;
    setRecipient({ kind: 'checking' });
    const outcome =
      handle === null ? await resolveContact(api, raw, controller.signal) : await resolveHandle(api, handle, controller.signal);
    if (lookup.current.id !== mine || controller.signal.aborted) return;
    switch (outcome.kind) {
      case 'found':
        if (outcome.self || outcome.userId.toLowerCase() === userId.toLowerCase())
          return setRecipient({ kind: 'problem', text: payCopy.t('That is you') });
        {
          const who = await withCard(mine, controller.signal, payee(outcome.userId, outcome.handle, { member: true }));
          if (lookup.current.id !== mine || controller.signal.aborted) return;
          return setRecipient({ kind: 'found', ...who });
        }
      case 'notFound':
        return setRecipient({
          kind: 'problem',
          text: handle === null ? payCopy.t('Contact not found') : payCopy.t('Handle not found', { handle }),
        });
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
   * The person a lookup or a pay code named, with their payee card (J-pay-01 #2): the name on their profile and the
   * month they joined, which is also the member badge. When the card can't be read, the person is still shown by handle,
   * with no name line and no badge. A newer lookup that started meanwhile wins: the caller checks `mine` again.
   */
  async function withCard(mine: number, signal: AbortSignal, who: Payee): Promise<Payee> {
    const card = await fetchPayeeCard(api, who.userId, signal);
    if (lookup.current.id !== mine || signal.aborted || card.kind !== 'ok') return who;
    return { ...who, name: card.name, memberSince: card.memberSince, member: true };
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
    scanned.current = payload;
    setTo('');
    setRecipient({ kind: 'checking' });
    const outcome = await resolvePayQr(api, payload, controller.signal);
    if (lookup.current.id !== mine || controller.signal.aborted) return;
    switch (outcome.kind) {
      case 'found':
        if (outcome.self || outcome.userId.toLowerCase() === userId.toLowerCase())
          return setRecipient({ kind: 'problem', text: payCopy.t('That is you') });
        setTo(byHandle ? outcome.handle : outcome.userId);
        {
          const who = await withCard(mine, controller.signal, payee(outcome.userId, byHandle ? outcome.handle : null, { member: true }));
          if (lookup.current.id !== mine || controller.signal.aborted) return;
          return setRecipient({ kind: 'found', ...who });
        }
      case 'invalid':
        return setRecipient({ kind: 'problem', text: personal.t('qrInvalid') });
      case 'payeeUnavailable':
        return setRecipient({ kind: 'problem', text: personal.t('qrPayeeUnavailable') });
      case 'unset':
        return setRecipient({ kind: 'problem', text: personal.t('qrUnset') });
      case 'failed':
        return setRecipient({ kind: 'problem', text: personal.t('qrFailedSend'), retry: true });
    }
  }

  /** A person paid before. A handle is looked up again, so a handle that moved to someone else is caught. */
  function pickContact(contact: Contact) {
    scanned.current = null;
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
    setRecipient({ kind: 'found', ...payee(contact.userId, byHandle ? contact.handle : null) });
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
  const [sourceGoneSeen, setSourceGoneSeen] = useState(sourceGone);
  if (sourceGoneSeen !== sourceGone) {
    setSourceGoneSeen(sourceGone);
    if (sourceGone) setAmount('');
  }
  // Pin the default choice, so that if it drops out later it is "gone", not quietly replaced by the next asset.
  const firstId = sources[0]?.id ?? '';
  if (sourceId === '' && firstId !== '') setSourceId(firstId);
  // A payment link fills the form once per link, as the form is drawn. Everything it sets can be changed, and nothing is
  // sent without Review. The link is kept with the lookup it asks for (a pay code to read, or a handle to find), which
  // starts once the filled form is on screen, below.
  const [appliedLink, setAppliedLink] = useState<{ key: string; lookup: { kind: 'scan' | 'check'; value: string } | null }>({
    key: '',
    lookup: null,
  });
  if (prefill && prefillKey !== '' && appliedLink.key !== prefillKey) {
    // The warning is always shown first. The link's own words are quoted after it and never replace it.
    const notices: string[] = [personal.t('requestBannerPlain')];
    if (prefill.note) notices.push(personal.t('requestBanner', { note: prefill.note }));
    // An answer still on its way for what was typed before is retired, so it cannot overwrite what the link names.
    lookup.current.id += 1;
    lookup.current.controller?.abort();
    lookup.current.controller = null;
    let linkLookup: { kind: 'scan' | 'check'; value: string } | null = null;
    if (prefill.qr) {
      linkLookup = { kind: 'scan', value: prefill.qr };
    } else if (prefill.kind === 'handle' && byHandle) {
      setTo(prefill.to);
      linkLookup = { kind: 'check', value: prefill.to };
    } else if (prefill.kind === 'accountId') {
      if (prefill.to === userId.toLowerCase()) {
        setTo('');
        setRecipient({ kind: 'problem', text: payCopy.t('That is you') });
      } else {
        setTo(prefill.to);
        setRecipient({ kind: 'found', ...payee(prefill.to, null) });
      }
    } else {
      setTo('');
      setRecipient({ kind: 'idle' });
      setNote(payCopy.t('Handles not on'));
    }
    setAppliedLink({ key: prefillKey, lookup: linkLookup });
    const applied = applyPrefill(prefill, sources);
    if (applied.sourceId) setSourceId(applied.sourceId);
    setAmount(applied.amount);
    setMemo(prefill.note ?? '');
    if (applied.problem === 'assetNotHeld') notices.push(personal.t('requestAssetMissing', { asset: prefill.asset ?? '' }));
    if (applied.problem === 'amountTooLarge') notices.push(personal.t('requestAmountTooLarge'));
    setLinkNotice(notices.join(' '));
  }
  // The recipient lookup a link asks for is read once per applied link. It keeps its own order and abort with every
  // other lookup (scan and check), so a keystroke or a contact picked meanwhile still wins.
  useResource(() => {
    const ask = appliedLink.lookup;
    const read = ask === null ? Promise.resolve() : ask.kind === 'scan' ? scan(ask.value) : check(ask.value);
    return read.then(() => ({ ok: true as const, data: null }));
  }, `pay:send:link:${appliedLink.key}`);
  const amountCheck = checkAmount(amount, source);
  // The limits and fee are read for an amount the customer could send; the service applies the same ones again.
  const typedAmount = amountCheck.kind === 'ok' ? dec(amount) : null;
  const quotedAmount = typedAmount === null ? null : str(typedAmount);
  const [terms, recheckTerms] = useSendTerms(pay, source?.asset ?? null, quotedAmount);
  const verdict = termsVerdict(terms, quotedAmount);
  const { hideBalances } = usePreferences();
  const availableText = source
    ? hideBalances
      ? HIDDEN_MASK
      : `${fmtAmount(source.balance, { places: BALANCE_PLACES, round: 'down' })} ${source.asset}`
    : '';
  const places = source ? Math.min(18, Math.max(BALANCE_PLACES, fractionDigits(source.balance) ?? 0)) : BALANCE_PLACES;
  const amountError =
    amountCheck.kind === 'exceeds' && source ? payCopy.t('You have {value} available.', { value: availableText }) : undefined;
  const sourceOptions = useMemo(() => sources.map((row) => ({ value: row.id, label: labelOf(row) })), [sources]);

  // ── The safety layer, as PersonalPay uses it ─────────────────────────────────────────────────────────────────
  const key = `${userId}:send`;
  const [, refreshGuard] = useReducer((n: number) => n + 1, 0);
  const mounted = useMounted();
  const recovering = useRef<object | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  // The device note is only ever read from storage again here; nothing is re-sent from it. It is read once for this
  // account (the read's arrival draws the form again), then again when the page is back in view or another tab changes it.
  useResource(() => pay.guard.restore(key).then(() => ({ ok: true as const, data: null })), `pay:send:guard:${key}`);
  const restore = async () => {
    await pay.guard.restore(key);
    if (mounted.current) refreshGuard();
  };
  const returned = () => {
    if (document.visibilityState === 'visible') void restore();
  };
  useEventListener<StorageEvent>(window, 'storage', (event) => {
    if (event.key === `pay.unresolved:${key}` || event.key === bankPendingKey(userId) || event.key === null) void restore();
  });
  useEventListener(window, 'focus', returned);
  useEventListener(document, 'visibilitychange', returned);
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
  // The fresh confirmation step: open when the bank's money-out rule asked for one on this review. Every review asks
  // the bank first, so a rule switched off is followed at once and a refused call moves nothing.
  const [stepUp, setStepUp] = useState<{ code: string; problem: string | null; checking: StepUpHow | null } | null>(null);
  const checking = useRef(false);
  // A send the owner's review holds (PP-send-request-10): nothing moved; its status page says In review and why.
  const [heldId, setHeldId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(() => lastReceipt.get(key) ?? null);

  // A handle that looks like someone saved is flagged before Review and again on it. It is a caution, not a block.
  const foundHandle = recipient.kind === 'found' ? recipient.handle : null;
  const savedHandles = saved.kind === 'ok' ? saved.handles : null;
  const lookalike = useMemo(
    () => (foundHandle && savedHandles ? lookalikeOf(foundHandle, savedHandles) : null),
    [foundHandle, savedHandles],
  );
  // The list answers at most SAVED_PAGE saved recipients; a full page may not be all of them, so the screen says so.
  const savedUnchecked =
    foundHandle !== null && lookalike === null && (saved.kind === 'failed' || (savedHandles !== null && savedHandles.length >= SAVED_PAGE));

  // Enter looks the person up when nothing has been asked yet, or when the last try failed or was rationed.
  const retryable = recipient.kind === 'idle' || (recipient.kind === 'problem' && recipient.retry === true);

  const reason: string | null = waiting
    ? payCopy.t('Still confirming')
    : recipient.kind !== 'found'
      ? payCopy.t('Choose who to pay')
      : recipient.handle !== null && saved.kind === 'loading'
        ? payCopy.t('Checking saved')
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
    setHeldId(null);
    setReview({
      input: parsed.data,
      source,
      recipient: payee(recipient.userId, recipient.handle, recipient),
      firstTime: !sentBefore(userId, recipient.userId),
      lookalike,
      note,
      terms: verdict,
    });
  }

  function closeReview() {
    // While a request is on its way the dialog cannot be dismissed: the answer must be seen.
    if (inFlight.current || checking.current) return;
    setReview(null);
    setFailure(null);
    setStepUp(null);
  }

  /** Confirms it's this person for exactly this send, then sends it with the single-use approval. */
  async function confirmStepUp(how: StepUpHow) {
    if (!review || !stepUp || checking.current || inFlight.current) return;
    // An unsettled send blocks this one before a confirmation is spent on it.
    if (pay.guard.status(key) || bankPending) return refreshGuard();
    const code = stepUp.code.trim();
    if (how === 'code' && !/^\d{6}$/.test(code)) return setStepUp({ ...stepUp, problem: payCopy.t('Code short') });
    checking.current = true;
    setStepUp({ ...stepUp, problem: null, checking: how });
    const method: StepUpMethod = how === 'code' ? { totpCode: code } : { passkey: true };
    let approved: Awaited<ReturnType<typeof confirmWithStepUp>>;
    try {
      approved = await confirmWithStepUp(api, personSendStepUp(review.source.asset, review.input), method);
    } finally {
      checking.current = false;
    }
    if (!mounted.current) return;
    if (!approved.ok) {
      // A wrong code is refused by identity and nothing is sent: the person stays on this step and tries again.
      return setStepUp((now) => (now ? { ...now, code: '', checking: null, problem: stepUpProblem(approved) } : now));
    }
    setStepUp((now) => (now ? { ...now, code: '', checking: null } : now));
    await confirm(approved.data.stepUpApprovalId);
  }

  async function confirm(stepUpApprovalId?: string) {
    if (!review || inFlight.current || checking.current) return;
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
        stepUpApprovalId ? { ...review.input, stepUpApprovalId } : review.input,
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
      setStepUp(null);
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
      setStepUp(null);
      setReview(null);
      return;
    }
    if (stepUpAgain(outcome.code)) {
      // The owner's rule asks for a fresh confirmation (or the one given was spent or ran out): nothing was sent. The
      // same review, with the same transfer id, waits for it.
      setStepUp({ code: '', checking: null, problem: stepUpApprovalId ? payCopy.t('Confirm again') : null });
      return;
    }
    if (outcome.code === SEND_IN_REVIEW) {
      setStepUp(null);
      setReview(null);
      setHeldId(review.input.transferId);
      reload();
      return;
    }
    // Any other answer is final for this review (a mismatch included: confirming again would bind the same fields).
    setStepUp(null);
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
      <div className="lt-stack" data-testid="pay-receipt">
        <div className="lt-stack" role="status">
          <span aria-hidden="true" data-tone="ok">
            ✓
          </span>
          <h2 data-testid="buy-receipt__title">
            {entry.handle
              ? payCopy.t('Sent {amount} {asset} to @{handle}', { amount: shownAmount, asset: entry.asset, handle: entry.handle })
              : payCopy.t('Sent {amount} {asset}', { amount: shownAmount, asset: entry.asset })}
          </h2>
          <KeyValue
            rows={[
              {
                label: personal.t('receiptTo'),
                value: entry.handle ? `@${entry.handle}` : entry.toUserId,
                ltr: !entry.handle,
              },
              { label: personal.t('receiptFrom'), value: receipt.from },
              { label: payCopy.t('Amount'), value: <span data-testid="pay-receipt-amount">{shown}</span> },
              { label: personal.t('receiptWhen'), value: new Date(entry.at).toLocaleString(personal.requestedLocale) },
              {
                label: personal.t('receiptReference'),
                value: <span data-testid="pay-receipt-reference">{entry.ledgerTxId}</span>,
                ltr: true,
              },
              ...(entry.note ? [{ label: personal.t('noteRow'), value: entry.note }] : []),
            ]}
          />
          <div className="lt-actions">
            <a className="lt-button lt-button-primary" href={ACTIVITY_HREF}>
              {payCopy.t('View activity')}
            </a>
            <Button size="lg" block onClick={() => void copyReceipt()}>
              {personal.t('receiptCopy')}
            </Button>
            <Button size="lg" block onClick={sendAgain} data-testid="pay-send-again">
              {personal.t('sendAgain')}
            </Button>
            <Button
              tone="quiet"
              size="lg"
              block
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
      <EmptyState
        title={payCopy.t('Nothing to send title')}
        body={payCopy.t('Nothing to send body')}
        action={
          isHiddenPath('/uc/recharge') ? undefined : (
            <a className="lt-button lt-button-secondary" href="/uc/recharge">
              {payCopy.t('Add money')}
            </a>
          )
        }
      />
    );

  const firstTimeText = review?.firstTime
    ? review.recipient.handle
      ? payCopy.t('First time handle', { handle: review.recipient.handle })
      : payCopy.t('First time account')
    : null;
  const reviewAmount = review ? fmtAmount(review.input.amount, { places: 18 }) : '';

  const reviewRows: KeyValueRow[] = review
    ? [
        {
          label: payCopy.t('To'),
          value: (
            <span data-testid="pay-review-to">
              {review.recipient.handle ? (
                <PayeeLine who={review.recipient} locale={personal.requestedLocale} testId="pay-review-payee" />
              ) : (
                review.recipient.userId
              )}
            </span>
          ),
          ltr: !review.recipient.handle,
        },
        { label: payCopy.t('From'), value: <span data-testid="pay-review-from">{labelFrom(review.source)}</span> },
        ...(review.note ? [{ label: personal.t('noteRow'), value: <span data-testid="pay-review-note">{review.note}</span> }] : []),
        {
          label: personal.t('termsFeeRow'),
          value: (
            <span data-testid="pay-review-fee">
              {parseAmount(review.terms.fee) === 0n
                ? personal.t('termsNoFee')
                : `${fmtAmount(review.terms.fee, { places: 18 })} ${review.source.asset}`}
              {networkFeeText(review.terms.networkFee, review.source.asset, personal) === null
                ? null
                : `. ${networkFeeText(review.terms.networkFee, review.source.asset, personal)}`}
            </span>
          ),
        },
        {
          label: payCopy.t('Today’s allowance'),
          value: (
            <span data-testid="pay-review-allowance">
              {payCopy.t('{left} of {daily} {asset} left', {
                left: fmtAmount(review.terms.left, { places: 18 }),
                daily: fmtAmount(review.terms.daily, { places: 18 }),
                asset: review.source.asset,
              })}
            </span>
          ),
        },
        {
          label: personal.t('termsLeftRow'),
          value: (
            <span data-testid="pay-review-left">
              {fmtAmount(review.terms.leftAfter, { places: 18 })} {review.source.asset}
            </span>
          ),
        },
        {
          label: payCopy.t('Amount'),
          value: (
            <span data-testid="pay-review-amount">
              {reviewAmount} {review.source.asset}
            </span>
          ),
          total: true,
        },
      ]
    : [];

  return (
    <>
      <form
        className="lt-stack"
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

        {heldId ? (
          <StatusNote data-testid="pay-held">
            {payCopy.t('Held for review')}{' '}
            <a className="lt-link" href={heldSendHref(heldId)} data-testid="pay-held-link">
              {payCopy.t('See its status')}
            </a>
          </StatusNote>
        ) : null}

        {linkNotice ? <StatusNote data-testid="pay-link-notice">{linkNotice}</StatusNote> : null}

        <div className="lt-stack" data-testid="to-field">
          <Field
            id="pay-to"
            label={byHandle ? payCopy.t('To') : payCopy.t('Account ID')}
            before={byHandle && contactKind(to) === null ? <span data-testid="pay-to__at">@</span> : null}
            after={
              byHandle ? null : (
                <Button tone="quiet" onClick={() => void paste()}>
                  <ClipboardPaste size={14} aria-hidden="true" />
                  {payCopy.t('Paste')}
                </Button>
              )
            }
            type="text"
            value={to}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={byHandle ? 320 : 64}
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
          <div id="pay-to-status" aria-live="polite" data-testid="to-status">
            {recipient.kind === 'checking' ? (
              <span className="lt-muted">{payCopy.t('Checking handle')}</span>
            ) : recipient.kind === 'found' ? (
              <>
                <PayeeLine who={recipient} locale={personal.requestedLocale} />
                {lookalike ? (
                  <StatusNote tone="error" data-testid="pay-lookalike">
                    {payCopy.t('Looks like saved', { handle: recipient.handle ?? '', saved: lookalike })}
                  </StatusNote>
                ) : savedUnchecked ? (
                  <span className="lt-muted" data-testid="pay-saved-unchecked">
                    {payCopy.t('Saved not checked')}
                  </span>
                ) : null}
              </>
            ) : recipient.kind === 'problem' ? (
              <StatusNote
                tone="error"
                actions={
                  recipient.retry ? (
                    <Button tone="quiet" onClick={() => void (scanned.current !== null && to === '' ? scan(scanned.current) : check())}>
                      {payCopy.t('Try again')}
                    </Button>
                  ) : undefined
                }
              >
                {recipient.text}
              </StatusNote>
            ) : note ? (
              <span className="lt-muted">{note}</span>
            ) : (
              <span className="lt-muted">{byHandle ? payCopy.t('Ask for their handle') : payCopy.t('Ask for their account ID')}</span>
            )}
          </div>
          {contacts.length > 0 && recipient.kind !== 'found' ? (
            <div className="lt-actions" data-testid="pay-contacts">
              <span className="lt-muted">{personal.t('recent')}</span>
              {contacts.map((contact) => (
                <Button key={contact.userId} onClick={() => pickContact(contact)} data-testid="pay-contact">
                  {contactLabel(contact)}
                </Button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="lt-stack" data-testid="amount-field">
          <SelectField
            label={payCopy.t('Amount')}
            aria-label={payCopy.t('Asset to send')}
            options={source ? sourceOptions : [{ value: '', label: '' }, ...sourceOptions]}
            value={source?.id ?? ''}
            onChange={(value) => {
              if (value !== '') {
                setSourceId(value);
                setAmount('');
              }
            }}
          />
          <AmountField
            size="hero"
            label={payCopy.t('Amount to send')}
            hideLabel
            value={amount}
            onChange={setAmount}
            precision={places}
            placeholder="0"
            error={amountError}
            unit={source ? <AssetIcon asset={source.asset} /> : undefined}
            available={<span data-testid="pay-available">{source ? payCopy.t('Available {value}', { value: availableText }) : ''}</span>}
            max={
              source && !waiting
                ? {
                    label: payCopy.t('Max'),
                    onSelect: () => {
                      const whole = dec(source.balance);
                      if (whole !== null) setAmount(str(whole));
                    },
                  }
                : undefined
            }
          />
          <TermsLine verdict={verdict} asset={source?.asset ?? ''} onRetry={recheckTerms} />
        </div>

        <div data-testid="note-field">
          <TextField
            id="pay-note"
            label={personal.t('note')}
            type="text"
            value={memo}
            maxLength={NOTE_MAX}
            autoComplete="off"
            placeholder={personal.t('notePlaceholder')}
            onChange={setMemo}
            hint={personal.t('noteHint')}
          />
        </div>

        {source && amountCheck.kind === 'ok' && typedAmount !== null ? (
          <div data-testid="pay-summary">
            <KeyValue
              rows={[
                {
                  label: payCopy.t('You send'),
                  value: (
                    <span data-testid="pay-summary-amount">
                      {fmtAmount(str(typedAmount), { places: 18 })} {source.asset}
                    </span>
                  ),
                },
                { label: payCopy.t('From'), value: <span data-testid="pay-summary-source">{labelFrom(source)}</span> },
                ...(cleanNote(memo)
                  ? [{ label: personal.t('noteRow'), value: <span data-testid="pay-summary-note">{cleanNote(memo)}</span> }]
                  : []),
              ]}
            />
          </div>
        ) : null}

        <Button type="submit" tone="primary" size="lg" block disabled={reason !== null} data-testid="pay-review">
          {reason !== null && !waiting ? reason : payCopy.t('Review')}
        </Button>
      </form>

      {review ? (
        // Drawn outside the form: Enter inside the review never submits the form and so never starts a second review.
        <Dialog
          alert
          data-testid="pay-dialog"
          onClose={closeReview}
          closeLabel={payCopy.t('Dismiss')}
          title={
            review.recipient.handle
              ? payCopy.t('Send {amount} {asset} to @{handle}?', {
                  amount: reviewAmount,
                  asset: review.source.asset,
                  handle: review.recipient.handle,
                })
              : payCopy.t('Send {amount} {asset} to this account?', { amount: reviewAmount, asset: review.source.asset })
          }
        >
          <div className="lt-stack">
            <p className="lt-muted">{payCopy.t('Arrives instantly')}</p>
            <KeyValue rows={reviewRows} />
            {review.lookalike && review.recipient.handle ? (
              <StatusNote tone="error" data-testid="pay-review-lookalike">
                {payCopy.t('Looks like saved', { handle: review.recipient.handle, saved: review.lookalike })}
              </StatusNote>
            ) : null}
            {firstTimeText ? (
              <StatusNote tone="warn" data-testid="pay-first-time">
                {firstTimeText} {payCopy.t('No test payment')}
              </StatusNote>
            ) : null}
            {failure ? (
              <StatusNote tone="error" data-testid="pay-failure">
                {failure}
              </StatusNote>
            ) : null}
            {stepUp ? (
              <section className="lt-stack" data-testid="pay-step-up" aria-labelledby="pay-step-up-title">
                <h3 id="pay-step-up-title">{payCopy.t('Confirm it’s you')}</h3>
                <p className="lt-hint">{payCopy.t('Step-up why')}</p>
                <Field
                  id="pay-step-up-code"
                  label={payCopy.t('Authenticator code')}
                  hint={payCopy.t('Code hint')}
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={stepUp.code}
                  disabled={stepUp.checking !== null || busy}
                  onChange={(event) => {
                    const code = event.target.value.replace(/\D/g, '').slice(0, 6);
                    setStepUp((now) => (now ? { ...now, code } : now));
                  }}
                />
                {stepUp.problem ? (
                  <StatusNote tone="error" data-testid="pay-step-up-problem">
                    {stepUp.problem}
                  </StatusNote>
                ) : null}
                <Button tone="quiet" disabled={stepUp.checking !== null || busy || waiting} onClick={() => void confirmStepUp('passkey')}>
                  {stepUp.checking === 'passkey' ? payCopy.t('Checking') : payCopy.t('Confirm with a passkey')}
                </Button>
              </section>
            ) : null}
            <div className="lt-actions">
              <Button disabled={busy || stepUp?.checking != null} onClick={closeReview}>
                {payCopy.t('Cancel')}
              </Button>
              {stepUp ? (
                <Button
                  tone="primary"
                  onClick={() => void confirmStepUp('code')}
                  aria-busy={busy || stepUp.checking === 'code' || undefined}
                  disabled={busy || waiting || stepUp.checking !== null || stepUp.code.length < 6}
                  data-testid="pay-step-up-confirm"
                >
                  {busy ? payCopy.t('Sending') : stepUp.checking === 'code' ? payCopy.t('Checking') : payCopy.t('Confirm and send')}
                </Button>
              ) : (
                <Button
                  tone="primary"
                  onClick={() => void confirm()}
                  aria-busy={busy || undefined}
                  disabled={busy || waiting}
                  data-testid="pay-send"
                >
                  {busy ? payCopy.t('Sending') : payCopy.t('Send now')}
                </Button>
              )}
            </div>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

type PersonalCopy = ReturnType<typeof personalCopy.useCopy>;

/** The network fee as the bank states it: the figure, none, or "not known"; null when the bank states nothing. */
function networkFeeText(networkFee: string | null | undefined, asset: string, personal: PersonalCopy): string | null {
  if (networkFee === undefined) return null;
  if (networkFee === null) return personal.t('termsNetworkFeeUnknown');
  if (parseAmount(networkFee) === 0n) return personal.t('termsNoNetworkFee');
  return personal.t('termsNetworkFee', { fee: fmtAmount(networkFee, { places: 18 }), asset });
}

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
      <p className="lt-hint" role="alert" data-testid="pay-terms" data-terms="unavailable">
        {personal.t('termsUnavailable')}{' '}
        <Button tone="quiet" onClick={onRetry}>
          {personal.t('termsRetry')}
        </Button>
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
              : `${parseAmount(verdict.fee) === 0n ? personal.t('termsNoFee') : personal.t('termsFee', { fee: amountOf(verdict.fee), asset })}.${networkFeeText(verdict.networkFee, asset, personal) === null ? '' : ` ${networkFeeText(verdict.networkFee, asset, personal)}`} ${personal.t('termsAllowance', { perTransfer: amountOf(verdict.perTransfer), left: amountOf(verdict.left), asset })}`;
  const blocked = verdict.kind !== 'ok' && verdict.kind !== 'checking';
  return (
    <p className="lt-hint" role={blocked ? 'alert' : 'status'} data-testid="pay-terms" data-terms={verdict.kind}>
      {text}
    </p>
  );
}

const labelOf = (row: Source) => (row.name ? `${row.asset} · ${row.name}` : row.asset);
/** The space the money leaves, by the name the bank keeps for it ("Main" for the main space). */
const labelFrom = (row: Source) =>
  row.space
    ? payCopy.t('Your {asset}, {name} space', { asset: row.asset, name: row.space })
    : payCopy.t('Your {asset}', { asset: row.asset });

/** "Nov 2026" for `2026-11`, in the reader's language. Null when the month is not one. */
function memberMonth(month: string | null, locale: string): string | null {
  const match = month ? /^(\d{4})-(\d{2})$/.exec(month) : null;
  if (!match) return null;
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, 1);
  try {
    return new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(at);
  } catch {
    return new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(at);
  }
}

/** The person being paid: the name on their profile, their handle, and a member badge when the service confirmed one. */
function PayeeLine({ who, locale, testId = 'recipient-found' }: { who: Payee; locale: string; testId?: string }) {
  const since = memberMonth(who.memberSince, locale);
  return (
    <PayeeCard
      data-testid={testId}
      face={who.name ?? who.handle ?? '#'}
      name={
        who.handle ? (
          who.name !== undefined ? (
            <span data-testid="recipient-name">{who.name ?? payCopy.t('No name shared')}</span>
          ) : null
        ) : (
          payCopy.t('Account ID ready')
        )
      }
      handle={who.handle ? <span data-testid="recipient-handle">{`@${who.handle}`}</span> : null}
      badge={
        who.member ? (
          <span data-testid="recipient-member">{since ? payCopy.t('Member since {month}', { month: since }) : payCopy.t('Member')}</span>
        ) : null
      }
      confirmed
    />
  );
}

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
    <StatusNote
      tone={recoveryProblem && !knownCleanup ? 'warn' : 'neutral'}
      title={title}
      data-testid="pay-waiting"
      actions={
        <>
          {knownCleanup || recoveryProblem ? (
            <Button disabled={busy} onClick={onRetry}>
              {busy ? payCopy.t('Working') : knownCleanup ? payCopy.t('Finish up') : payCopy.t('Try again')}
            </Button>
          ) : null}
          {showActivity ? (
            <a className="lt-button lt-button-secondary" href={ACTIVITY_HREF}>
              {payCopy.t('View activity')}
            </a>
          ) : null}
          {isHiddenPath(SUPPORT_HREF) ? null : (
            <a className="lt-link" href={SUPPORT_HREF}>
              {payCopy.t('Contact support')}
            </a>
          )}
        </>
      }
    >
      {body}
    </StatusNote>
  );
}
