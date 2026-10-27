import { t as copyText, Text } from './copy';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { z, type ZodType } from 'zod';
import { currentPreferences } from '../../shared/preferences';
import { stamp } from '../../screens/money/time';
import { useApi, useSession } from '../session/session';
import { useResource, type Resource } from '../../shared/resource';
import { authoredRefusal, type ApiResult } from '../../shared/api';
import { Button, Dialog, EmptyState, Failure, Field, Loading } from '../../shared/ui';
import { decimalSchema, displayAmount, parseAmount } from '../../shared/money';
import { bankReads, bankWriteForReview, type BankRead, type BankWrite } from './contracts';
import { createMoneyClient, type Space, type TransferDraft } from './client';
import {
  clearPendingOutcome,
  originalRecordRefs,
  pendingOutcomes,
  rememberPendingOutcome,
  type PendingReservation,
} from './pending-outcomes';
import { settleRefusal } from './money-refusal-copy';
import { StepUpConfirm } from './StepUpConfirm';
import type { StepUpBegin } from '../account/security-step-up';

export const PAGE_SIZE = 50;
export const amount = (value: string | null | undefined, asset: string) =>
  value == null ? copyText('components.unavailable') : `${displayAmount(value)} ${asset}`;
export const funds = (value: string | null | undefined, asset: string) =>
  currentPreferences().hideBalances && value != null ? `•••• ${asset}` : amount(value, asset);
/** One date and time look across the app: "18 Oct, 01:05" in the viewer's zone, with a picked zone named. */
export function date(value: string | null, seconds = false) {
  if (!value) return copyText('components.none');
  if (!Number.isFinite(Date.parse(value))) return copyText('components.date.unavailable');
  return stamp(value, currentPreferences().timeZone, Date.now(), seconds);
}
export const bps = (value: number) => `${value / 100}%`;
export function useBankRead<K extends BankRead>(procedure: K, input: unknown, enabled = true) {
  const { api, userId } = useSession();
  return useResource<z.infer<(typeof bankReads)[K]>>(
    async (signal) => {
      if (!enabled) return { ok: false, reason: 'not_supported', message: copyText('components.select.a.record.to.load.its.details') };
      if (!userId) return { ok: false, reason: 'unauthorized', message: copyText('components.sign.in.to.read.your.bank.information') };
      return api.query('bank', procedure, input, bankReads[procedure] as unknown as ZodType<z.infer<(typeof bankReads)[K]>>, { signal });
    },
    `${userId}:${procedure}:${JSON.stringify(input)}:${enabled}`,
  );
}
export function ResourceView<T>({
  resource,
  reload,
  children,
}: {
  resource: Resource<T>;
  reload: () => void;
  children: (data: T) => ReactNode;
}) {
  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  return <>{children(resource.data)}</>;
}
export function Section({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section data-testid="money-section" className="money-section">
      <header>
        <div>
          <h2>{title}</h2>
          {description && <p className="muted">{description}</p>}
        </div>
        {actions && <div className="actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}
export function Continuation({ count, limit, onMore }: { count: number; limit: number; onMore: () => void }) {
  return (
    <div data-testid="money-continuation" className="money-continuation">
      <span>
        {count}
        <Text k="components.records.returned.requested.limit" />.{' '}
        {count >= limit
          ? limit < 200
            ? copyText('components.more.records.may.exist')
            : copyText('components.this.service.has.no.continuation.beyond.200')
          : copyText('components.this.list.has.no.total.count.or')}
      </span>
      {count >= limit && limit < 200 && (
        <Button variant="secondary" onClick={onMore}>
          <Text k="components.load.up.to" />
          {Math.min(200, limit + 50)}
        </Button>
      )}
    </div>
  );
}
export function usePageLimit() {
  return useState(PAGE_SIZE);
}
export type ActionField = {
  name: string;
  label: string;
  unit?: string;
  hint?: string;
  type?: 'text' | 'datetime-local';
  options?: { value: string; label: string }[];
  optional?: boolean;
  validate?: (value: string) => string | null;
};
export type ActionSpec = {
  title: string;
  procedure: BankWrite;
  fields?: ActionField[];
  initial?: Record<string, string>;
  facts?: [string, string][];
  /** Rows shown above the fields while filling in the form (balance, pool, APR, term...). */
  formFacts?: [string, string][];
  /** Rows worked out from what has been typed so far (estimates). Shown with the form and again in the review. */
  liveRows?: (values: Record<string, string>) => [string, string][];
  notes: string[];
  input: (values: Record<string, string>, requestId: string) => Record<string, unknown>;
  validate?: (input: Record<string, unknown>) => string | null;
  /** Fresh read checks inside the Bank write lock, before journaling or POST. */
  preflight?: (input: Record<string, unknown>) => Promise<ApiResult<null>>;
  /** Match returned fields to the original review where the wire exposes them. */
  verifyOutcome?: (data: unknown, input: Record<string, unknown>) => boolean;
  /** Plain-words rows for a confirmed result, in place of the raw field list. Return null to fall back to it. */
  describeOutcome?: (data: unknown, input: Record<string, unknown>) => [string, string][] | null;
  transferSpaces?: Space[];
  /**
   * What the service itself says about this exact request, read when the review opens (fees and limits). Its rows show in
   * the review; while it is reading, or when it names a reason, Confirm stays off and the reason is shown.
   */
  reviewTerms?: {
    checking: string;
    read: (input: Record<string, unknown>, signal: AbortSignal) => Promise<{ rows: [string, string][]; blocked: string | null }>;
  };
  /**
   * A fresh second factor for this exact request (a send to another person): the `stepUp.begin` request naming its
   * fields, and the words around it. Confirm becomes the code or passkey, and the single-use approval goes with the request.
   */
  stepUp?: {
    request: (input: Record<string, unknown>) => StepUpBegin;
    words: { why: string; code: string; codeHint: string; codeShort: string; noFactor: string; sendWithout: string };
  };
  submit?: string;
  unit?: string;
  /**
   * The bank answers this exact request sent again under its reference with the first send's result (a loan repayment's
   * `eventId`), so after an unknown outcome the person may send it again and nothing is collected twice. Never with
   * `stepUp`: its approval is spent by the first send.
   */
  resendSame?: boolean;
};
/** The original opened action's owner, API, mount and observed full-URL lifetime. */
export type BankActionContext = { current: () => boolean };
export const positiveMoney = (asset: string | undefined, name = 'amount', label = copyText('form.amount')): ActionField => ({
  name,
  unit: asset,
  label: asset ? `${label} (${asset})` : label,
  hint: copyText('components.exact.decimal.amount.available.funds.only'),
  validate: (value) =>
    decimalSchema.safeParse(value).success && parseAmount(value) > 0n
      ? null
      : copyText('components.enter.an.exact.decimal.amount.greater.than'),
});
export const uuidField = (name: string, label: string): ActionField => ({
  name,
  label,
  validate: (value) => (z.string().guid().safeParse(value).success ? null : copyText('components.enter.a.valid.id')),
});
export const startsField: ActionField = {
  name: 'startsAt',
  get label() {
    return copyText('components.first.run');
  },
  type: 'datetime-local',
  validate: (value) =>
    Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now() ? null : copyText('components.choose.a.future.date.and.time'),
};
export const cadenceField: ActionField = {
  name: 'cadence',
  get label() {
    return copyText('components.cadence');
  },
  get options() {
    return ['daily', 'weekly', 'monthly'].map((value) => ({
      value,
      label: copyText(value === 'daily' ? 'form.daily' : value === 'weekly' ? 'form.weekly' : 'form.monthly'),
    }));
  },
};
/** A bank transfer schedule also takes a one-off; auto-invest keeps `cadenceField`, which has no 'once'. */
export const scheduleCadenceField: ActionField = {
  name: 'cadence',
  get label() {
    return copyText('components.cadence');
  },
  get options() {
    return [...cadenceField.options!, { value: 'once', label: copyText('form.once') }];
  },
};
/** An optional last date for a repeating order. Blank means it runs until cancelled. */
export const endsField: ActionField = {
  name: 'endsAt',
  get label() {
    return copyText('components.last.run');
  },
  get hint() {
    return copyText('components.last.run.hint');
  },
  type: 'datetime-local',
  optional: true,
  validate: (value) =>
    Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now() ? null : copyText('components.choose.an.end.after.first.run'),
};
export const iso = (value: string) => new Date(value).toISOString();
/** A one-off has no end date, and an end at or before the first run would never fire. */
export function scheduleWindowIssue(input: Record<string, unknown>): string | null {
  if (typeof input.endsAt !== 'string') return null;
  if (input.cadence === 'once') return copyText('components.last.run.hint');
  return typeof input.startsAt === 'string' && Date.parse(input.endsAt) <= Date.parse(input.startsAt)
    ? copyText('components.choose.an.end.after.first.run')
    : null;
}
const outputNames: Record<string, string> = {
  get ledgerTxId() {
    return copyText('components.ledger.transaction');
  },
  get drawLedgerTxId() {
    return copyText('components.draw.transaction');
  },
  get holdLedgerTxId() {
    return copyText('components.reservation.transaction');
  },
  get positionId() {
    return copyText('components.position');
  },
  get maturesAt() {
    return copyText('components.matures.at');
  },
  get amount() {
    return copyText('components.confirmed.amount');
  },
  get status() {
    return copyText('components.status');
  },
  get remainingPrincipal() {
    return copyText('components.remaining.principal');
  },
  get remainingInterest() {
    return copyText('components.remaining.interest');
  },
  get principalPaid() {
    return copyText('components.principal.paid');
  },
  get interestPaid() {
    return copyText('components.interest.paid');
  },
  get skipped() {
    return copyText('components.missed.occurrences.skipped');
  },
  get kind() {
    return copyText('components.outcome');
  },
  get approval() {
    return copyText('components.approval');
  },
  get released() {
    return copyText('components.released.quantity');
  },
  get nextRunAt() {
    return copyText('components.next.run');
  },
  get id() {
    return copyText('outcome.record');
  },
  get name() {
    return copyText('outcome.name');
  },
};
const monetaryOutcomeKeys = new Set([
  'amount',
  'principal',
  'threshold',
  'interestPaid',
  'principalPaid',
  'remainingPrincipal',
  'remainingInterest',
  'released',
]);
function Outcome({ data, unit }: { data: unknown; unit?: string }) {
  if (Array.isArray(data)) return <span>{data.map((item) => String(item)).join(', ') || copyText('components.none')}</span>;
  if (data && typeof data === 'object')
    return (
      <dl className="detail-list">
        {Object.entries(data).map(([key, value]) => (
          <div key={key}>
            <dt>{outputNames[key] ?? key}</dt>
            <dd>
              {monetaryOutcomeKeys.has(key) && typeof value === 'string' ? (
                unit || typeof (data as Record<string, unknown>).assetId === 'string' ? (
                  amount(value, String((data as Record<string, unknown>).assetId ?? unit))
                ) : (
                  copyText('components.unit.unavailable', { value1: displayAmount(value) })
                )
              ) : key === 'ltvBps' && typeof value === 'number' ? (
                bps(value)
              ) : (
                <Outcome data={value} unit={unit} />
              )}
            </dd>
          </div>
        ))}
      </dl>
    );
  return <span>{data === null ? copyText('components.none') : String(data)}</span>;
}
/** Is a request built after an edit different from the one that was sent? Compared field by field, the reference included. */
export function editedRequestChanged(sent: Record<string, unknown>, edited: Record<string, unknown>): boolean {
  return JSON.stringify(sent) !== JSON.stringify(edited);
}
export function MutationDialog({
  spec,
  context,
  onClose,
  onDone,
  onPendingChange,
}: {
  spec: ActionSpec;
  context: BankActionContext;
  onClose: () => void;
  onDone: () => void;
  onPendingChange: () => void;
}) {
  const { api, userId, session } = useSession();
  const token = session?.accessToken ?? null;
  const sending = useRef<object | null>(null);
  const mounted = useRef(true);
  const body = useRef<HTMLDivElement | null>(null);
  const original = useRef({ api, userId, token, spec, context });
  const actor = useRef({ api, userId, token });
  actor.current = { api, userId, token };
  const [clearFailure, setClearFailure] = useState(false);
  const [values, setValues] = useState(spec.initial ?? {});
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  // The request that was last sent to the bank. A different request after it never reuses its reference.
  const lastSent = useRef<Record<string, unknown> | null>(null);
  // This dialog's own journaled request while its outcome is unknown: sending it again sends exactly this, under this
  // entry's reference, and clears the entry once the bank answers.
  const journaled = useRef<{ reservation: PendingReservation; input: Record<string, unknown> } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [stage, setStage] = useState<'form' | 'review' | 'sending' | 'outcome'>((spec.fields?.length ?? 0) ? 'form' : 'review');
  const [result, setResult] = useState<ApiResult<unknown> | null>(null);
  const [reviewInput, setReviewInput] = useState<Record<string, unknown> | null>(() =>
    spec.fields?.length ? null : spec.input(spec.initial ?? {}, requestId),
  );
  const reviewed = useRef(reviewInput);
  // The service's terms for the request under review. Kept with the request they were read for, so a stale answer never shows.
  const [terms, setTerms] = useState<{ for: Record<string, unknown>; rows: [string, string][]; blocked: string | null } | null>(null);
  const termsFor = spec.reviewTerms && reviewInput ? (terms?.for === reviewInput ? terms : null) : null;
  const termsHold = Boolean(spec.reviewTerms) && (termsFor === null || termsFor.blocked !== null);
  useEffect(() => {
    if (!spec.reviewTerms || stage !== 'review' || !reviewInput) return;
    const controller = new AbortController();
    const input = reviewInput;
    spec.reviewTerms
      .read(input, controller.signal)
      .catch(() => ({ rows: [], blocked: copyText('components.review.check.failed.no.request.sent') }))
      .then((read) => {
        if (!controller.signal.aborted) setTerms({ for: input, ...read });
      });
    return () => controller.abort();
  }, [spec, stage, reviewInput]);
  const staged = useRef({ reviewInput, values });
  staged.current = { reviewInput, values };
  const rendering = {};
  const rendered = useRef(rendering);
  rendered.current = rendering;
  const current = () =>
    mounted.current &&
    original.current.context === context &&
    original.current.spec === spec &&
    original.current.api === api &&
    original.current.userId === userId &&
    original.current.token === token &&
    actor.current.api === api &&
    actor.current.userId === userId &&
    actor.current.token === token &&
    context.current() &&
    api.canWrite();
  useLayoutEffect(() => {
    mounted.current = true;
    // StrictMode replays setup after cleanup. Restore the current controlled
    // state and initial fieldless review only within the original context.
    if (current()) {
      reviewed.current = staged.current.reviewInput;
      for (const field of body.current?.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select') ?? [])
        field.value = staged.current.values[field.name] ?? '';
    }
    return () => {
      mounted.current = false;
      sending.current = null;
      reviewed.current = null;
      if (!context.current()) staged.current = { reviewInput: null, values: {} };
      for (const field of body.current?.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select') ?? []) field.value = '';
    };
  }, []);
  const admitted = () => current() && rendered.current === rendering;
  function edit() {
    if (!admitted() || sending.current) return;
    reviewed.current = null;
    setReviewInput(null);
    setResult(null);
    setStage('form');
  }
  function close() {
    if (admitted() && !sending.current) onClose();
  }
  function review() {
    if (!admitted() || stage !== 'form' || sending.current) return;
    const next: Record<string, string> = {};
    for (const field of spec.fields ?? []) {
      const value = values[field.name]?.trim() ?? '';
      if (!value && !field.optional) next[field.name] = copyText('components.complete.this.field');
      else if (value && field.validate?.(value)) next[field.name] = field.validate(value)!;
      if (value && field.options && !field.options.some((option) => option.value === value))
        next[field.name] = copyText('components.choose.a.supported.option');
    }
    if (Object.keys(next).length) {
      setErrors(next);
      return;
    }
    let input = spec.input(values, requestId);
    // After a refusal, an unchanged request may be sent again under the same reference. A changed one is a new request:
    // the bank may have kept the first one's reference, and would answer the new terms with the old ones.
    if (lastSent.current && editedRequestChanged(lastSent.current, input)) {
      const fresh = crypto.randomUUID();
      input = spec.input(values, fresh);
      setRequestId(fresh);
      lastSent.current = null;
    }
    const error = spec.validate?.(input);
    if (error) {
      setErrors({ form: error });
      return;
    }
    reviewed.current = input;
    setReviewInput(input);
    setStage('review');
  }
  // The request on the wire and what its reply settles to. A thrown or unreadable reply cannot prove the bank did nothing.
  async function post(input: Record<string, unknown>, sent: Record<string, unknown>) {
    let outcome: ApiResult<unknown>;
    try {
      outcome = spec.transferSpaces
        ? await createMoneyClient(api).transfer(spec.transferSpaces, sent as TransferDraft)
        : await api.mutate(
            'bank',
            spec.procedure,
            sent,
            bankWriteForReview(spec.procedure, input).refine((data) => spec.verifyOutcome?.(data, input) ?? true),
          );
    } catch {
      outcome = { ok: false, reason: 'uncertain', message: copyText('components.the.original.bank.outcome.could.not.be') };
    }
    // Local transfer validation precedes HTTP dispatch. Auth refusals occur
    // before the Bank handler. Other failures cannot prove non-settlement.
    // A typed refusal the bank makes before it posts or changes anything is definitive too, and says so in plain words.
    const settled = settleRefusal(outcome, spec.procedure);
    outcome = settled.outcome;
    const definitive =
      outcome.ok || outcome.code === 'money.invalid_transfer' || outcome.status === 401 || outcome.status === 403 || settled.refusedFirst;
    return { outcome, definitive };
  }
  /** What a settled reply leaves journaled: a definitive one clears its original, anything else stays guarded and says so. */
  async function settle(outcome: ApiResult<unknown>, definitive: boolean, original: PendingReservation, live: () => boolean) {
    if (definitive) {
      try {
        await clearPendingOutcome(original, live);
        if (journaled.current?.reservation === original) journaled.current = null;
      } catch {
        if (live()) setClearFailure(true);
      }
      return outcome;
    }
    if (!outcome.ok && outcome.reason !== 'uncertain')
      return {
        ...outcome,
        reason: 'uncertain' as const,
        message: outcome.message + copyText('components.the.original.request.remains.guarded.until.its'),
      };
    return outcome;
  }
  /**
   * One bank write at a time across this person's tabs. When the lock is held elsewhere, or the browser has none, nothing
   * is sent, and `unsent` says how that reads for the caller.
   */
  function underWriteLock(
    body: () => Promise<ApiResult<unknown>>,
    unsent: (reason: 'error' | 'not_supported', message: string) => ApiResult<unknown>,
  ): Promise<ApiResult<unknown>> {
    if (!navigator.locks)
      return Promise.resolve(unsent('not_supported', copyText('components.this.browser.cannot.coordinate.bank.requests.across')));
    return navigator.locks.request(`bank-write:${userId}`, { ifAvailable: true }, (lock) =>
      lock ? body() : Promise.resolve(unsent('error', copyText('components.another.tab.has.a.bank.request.running'))),
    );
  }
  function finish(outcome: ApiResult<unknown>) {
    sending.current = null;
    setResult(outcome);
    setStage('outcome');
    if (outcome.ok) onDone();
  }
  // The confirmation answers after an async factor check; it must reach this render's submit, not the one it began with.
  const latestSubmit = useRef<(stepUpApprovalId?: string | null) => Promise<void>>(async () => {});
  latestSubmit.current = (approval) => submit(approval);
  async function submit(stepUpApprovalId?: string | null) {
    if (!admitted() || stage !== 'review' || sending.current || !reviewInput || reviewed.current !== reviewInput || termsHold) return;
    // A step-up review sends only after its confirmation answered: an approval, or null for a person with no factor.
    if (spec.stepUp && stepUpApprovalId === undefined) return;
    const run = {};
    sending.current = run;
    const input = reviewInput;
    // The approval is spent by this one call. It is sent, never journaled and never kept for a retry.
    const sent = stepUpApprovalId ? { ...input, stepUpApprovalId } : input;
    setStage('sending');
    const currentRun = () => current() && sending.current === run && reviewed.current === input;
    const dispatch = async (): Promise<ApiResult<unknown>> => {
      if (!currentRun()) return authoredRefusal('aborted', { key: 'accountChanged' });
      if (!userId) return { ok: false, reason: 'unauthorized', message: copyText('components.sign.in.before.sending.a.bank.request') };
      if (pendingOutcomes(userId).length)
        return { ok: false, reason: 'uncertain', message: copyText('components.an.original.bank.request.still.requires.recovery') };
      if (spec.preflight) {
        let checked: ApiResult<null>;
        try {
          checked = await spec.preflight(input);
        } catch {
          checked = { ok: false, reason: 'error', message: copyText('components.review.check.failed.no.request.sent') };
        }
        if (!currentRun()) return authoredRefusal('aborted', { key: 'accountChanged' });
        if (!checked.ok) return checked;
        if (pendingOutcomes(userId).length)
          return { ok: false, reason: 'uncertain', message: copyText('components.an.original.bank.request.still.requires.recovery') };
      }
      if (!currentRun()) return authoredRefusal('aborted', { key: 'accountChanged' });
      let reservation: PendingReservation;
      try {
        reservation = await rememberPendingOutcome(
          userId,
          {
            reference: requestId,
            title: spec.title,
            procedure: spec.procedure,
            recordRefs: originalRecordRefs(input),
          },
          currentRun,
        );
      } catch {
        return { ok: false, reason: 'error', message: copyText('components.recovery.storage.is.unavailable.no.bank.request') };
      }
      journaled.current = { reservation, input };
      onPendingChange();
      if (!currentRun()) {
        // This original has not dispatched. Remove only its just-saved marker;
        // a request already sent never reaches this non-dispatch cleanup.
        try {
          await clearPendingOutcome(reservation, () => true);
        } catch {
          // Keep the conservative guard if durable storage cannot be cleared.
        }
        return authoredRefusal('aborted', { key: 'accountChanged' });
      }
      const { outcome, definitive } = await post(input, sent);
      // Even a valid late reply cannot certify a departed private review.
      // Retain its original minimal journal rather than publish or clear it.
      if (!currentRun()) return authoredRefusal('uncertain', { key: 'accountChanged' });
      const said = await settle(outcome, definitive, reservation, currentRun);
      if (currentRun()) onPendingChange();
      return said;
    };
    const outcome = await underWriteLock(dispatch, (reason, message) => ({ ok: false, reason, message }));
    if (!currentRun()) return;
    lastSent.current = input;
    finish(outcome);
  }
  /** The journaled original this dialog may send again: its own, the last one it sent, under the reference it shows. */
  function resendable() {
    const original = journaled.current;
    return spec.resendSame &&
      !spec.stepUp &&
      original &&
      original.reservation.reference === requestId &&
      original.input === lastSent.current
      ? original
      : null;
  }
  /**
   * After an unknown outcome, the same request again: the same body and reference, without a new journal entry or a
   * fresh preflight (what it read has changed if the first send landed). The bank answers with the first send's result.
   * Anything that stops it before it is sent leaves the outcome unknown, as it was.
   */
  async function resend() {
    const original = resendable();
    if (!original || !admitted() || stage !== 'outcome' || sending.current || !userId) return;
    if (!result || result.ok || result.reason !== 'uncertain' || reviewed.current !== original.input) return;
    const { reservation, input } = original;
    const run = {};
    sending.current = run;
    setStage('sending');
    const currentRun = () => current() && sending.current === run && reviewed.current === input;
    const unknown = (message: string): ApiResult<unknown> => ({ ok: false, reason: 'uncertain', message });
    const again = async (): Promise<ApiResult<unknown>> => {
      if (!currentRun()) return authoredRefusal('uncertain', { key: 'accountChanged' });
      // Any other original with an unknown outcome still pauses every bank write.
      if (pendingOutcomes(userId).some((record) => record.reference !== reservation.reference))
        return unknown(copyText('components.an.original.bank.request.still.requires.recovery'));
      const { outcome, definitive } = await post(input, input);
      if (!currentRun()) return authoredRefusal('uncertain', { key: 'accountChanged' });
      const said = await settle(outcome, definitive, reservation, currentRun);
      if (currentRun()) onPendingChange();
      return said;
    };
    const outcome = await underWriteLock(again, (_reason, message) => unknown(message));
    if (!currentRun()) return;
    finish(outcome);
  }
  const terminalUnknown = result && !result.ok && result.reason === 'uncertain';
  const described =
    result?.ok && staged.current.reviewInput ? (spec.describeOutcome?.(result.data, staged.current.reviewInput) ?? null) : null;
  return (
    <Dialog title={stage === 'review' ? copyText('components.review.3', { value1: spec.title.toLowerCase() }) : spec.title} onClose={close}>
      <div className="money-dialog-body" ref={body}>
        {spec.notes.map((note) => (
          <p className="muted" key={note}>
            {note}
          </p>
        ))}
        {stage === 'form' && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              review();
            }}
          >
            {Boolean(spec.formFacts?.length) && (
              <dl className="detail-list money-form-facts">
                {spec.formFacts!.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {spec.fields?.map((field) =>
              field.options ? (
                <label className="field" key={field.name}>
                  <span>{field.label}</span>
                  <select
                    name={field.name}
                    value={values[field.name] ?? ''}
                    onChange={(event) => {
                      if (admitted() && !sending.current) setValues({ ...values, [field.name]: event.target.value });
                    }}
                    required={!field.optional}
                    aria-label={field.label}
                    aria-invalid={Boolean(errors[field.name])}
                    aria-describedby={field.hint || errors[field.name] ? `${field.name}-help` : undefined}
                  >
                    <option value="">
                      <Text k="components.choose" />
                    </option>
                    {field.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  {(field.hint || errors[field.name]) && (
                    <small id={`${field.name}-help`} className={errors[field.name] ? 'error-text' : ''}>
                      {errors[field.name] ?? field.hint}
                    </small>
                  )}
                </label>
              ) : (
                <Field
                  key={field.name}
                  name={field.name}
                  label={field.label}
                  aria-label={field.label}
                  hint={field.hint}
                  type={field.type ?? 'text'}
                  inputMode={field.name.toLowerCase().includes('amount') || field.name === 'principal' ? 'decimal' : undefined}
                  required={!field.optional}
                  value={values[field.name] ?? ''}
                  error={errors[field.name]}
                  onChange={(event) => {
                    if (admitted() && !sending.current) setValues({ ...values, [field.name]: event.target.value });
                  }}
                />
              ),
            )}
            {spec.liveRows && (
              <dl className="detail-list money-form-facts" aria-live="polite">
                {spec.liveRows(values).map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {errors.form && (
              <p className="error-text" role="alert">
                {errors.form}
              </p>
            )}
            <Button type="submit">
              <Text k="components.review.2" />
            </Button>
          </form>
        )}
        {(stage === 'review' || stage === 'sending') && (
          <>
            <dl className="detail-list">
              {spec.facts?.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
              {spec.fields?.map((field) => (
                <div key={field.name}>
                  <dt>{field.label}</dt>
                  <dd>
                    {field.options?.find((option) => option.value === values[field.name])?.label ??
                      values[field.name] ??
                      copyText('components.none')}
                  </dd>
                </div>
              ))}
              {spec.liveRows?.(values).map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
              {termsFor?.rows.map(([label, value]) => (
                <div key={label} data-testid="review-terms-row">
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            {spec.reviewTerms && stage === 'review' && termsFor === null && <Loading label={spec.reviewTerms.checking} />}
            {termsFor?.blocked && (
              <p className="notice" role="alert" data-testid="review-terms-blocked">
                {termsFor.blocked}
              </p>
            )}
            <p data-testid="money-reference" className="money-reference">
              <Text k="components.request.reference" />
              {requestId}
            </p>
            {stage === 'sending' ? (
              <Loading label={copyText('components.waiting.for.the.authoritative.outcome')} />
            ) : (
              <div className="actions">
                {spec.stepUp ? (
                  <StepUpConfirm
                    request={() => spec.stepUp!.request(reviewInput!)}
                    words={spec.stepUp.words}
                    disabled={termsHold}
                    onApproved={(approval) => void latestSubmit.current(approval)}
                  />
                ) : (
                  <Button disabled={termsHold} onClick={() => void submit()}>
                    {spec.submit ?? copyText('components.confirm')}
                  </Button>
                )}
                {Boolean(spec.fields?.length) && (
                  <Button variant="secondary" onClick={edit}>
                    <Text k="components.edit" />
                  </Button>
                )}
              </div>
            )}
          </>
        )}
        {stage === 'outcome' && result && (
          <div aria-live="polite">
            {clearFailure && (
              <p className="notice">
                <Text k="components.the.original.request.received.a.definitive.outcome" />
              </p>
            )}
            {result.ok ? (
              <>
                <h3>
                  <Text k="components.confirmed.by.the.service" />
                </h3>
                {described ? (
                  <dl className="detail-list">
                    {described.map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <Outcome
                    data={result.data}
                    unit={spec.unit ?? spec.fields?.find((field) => field.name === 'amount' || field.name === 'principal')?.unit}
                  />
                )}
              </>
            ) : (
              <Failure result={result} />
            )}
            {terminalUnknown && (
              <>
                <p className="notice">
                  <Text k="components.this.request.may.have.completed.keep.this" />
                </p>
                <p data-testid="money-reference" className="money-reference">
                  <Text k="components.request.reference" />
                  {requestId}
                </p>
                {resendable() && (
                  <>
                    <p className="muted">
                      <Text k="components.the.bank.answers.this.reference.with.its.first.result" />
                    </p>
                    <Button onClick={() => void resend()}>
                      <Text k="components.send.the.same.request.again" />
                    </Button>
                  </>
                )}
                <Button
                  variant="secondary"
                  onClick={() => {
                    if (admitted() && !sending.current) onDone();
                  }}
                >
                  <Text k="components.refresh.original.records" />
                </Button>
              </>
            )}
            <div className="actions">
              <Button variant="secondary" onClick={close}>
                <Text k="components.close" />
              </Button>
              {!result.ok && !terminalUnknown && (
                <Button onClick={edit}>
                  <Text k="components.edit.request" />
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
export function NoRows({ title, children }: { title: string; children?: ReactNode }) {
  return <EmptyState title={title}>{children}</EmptyState>;
}
