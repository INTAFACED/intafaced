/**
 * Reconciliation controls on the console (J-ops-console-07 steps 1-4, OPS-reconciliation-01). Plain data, parsers and form
 * builders, safe in server and browser code.
 *
 * svc-ledger owns the controls. The console lists them as the signed-in founder and sends define, update and run on the
 * treasury transport, through svc-edge. Every body is checked against the same contract svc-edge and svc-ledger use, so a
 * body this console sends is never one they refuse for its shape. A blank value stays blank: nothing here fills in a
 * tolerance, a schedule, a severity or a margin.
 */
import {
  RECONCILIATION_LIFECYCLE,
  RECONCILIATION_LIFECYCLE_MOVES,
  RECONCILIATION_SEVERITIES,
  RECONCILIATION_TEMPLATES,
  defineReconciliationControlInputSchema,
  reconciliationControlListSchema,
  reconciliationControlRunSchema,
  reconciliationControlViewSchema,
  reconciliationDecimalSchema,
  updateReconciliationControlInputSchema,
  type DefineReconciliationControlInput,
  type ReconciliationControlRunView,
  type ReconciliationControlView,
  type ReconciliationLifecycle,
  type ReconciliationSchedule,
  type UpdateReconciliationControlInput,
} from '@intafaced/contracts/ledger-reconciliation';

export type { ReconciliationControlRunView, ReconciliationControlView, ReconciliationLifecycle };
export type ControlTemplate = (typeof RECONCILIATION_TEMPLATES)[number];
export type ControlSeverity = (typeof RECONCILIATION_SEVERITIES)[number];
export const CONTROL_TEMPLATES = RECONCILIATION_TEMPLATES;
export const CONTROL_SEVERITIES = RECONCILIATION_SEVERITIES;
export const OWNER_TYPES = ['user', 'subaccount', 'module', 'house', 'treasury'] as const;
export const ACCOUNT_KINDS = ['available', 'hold', 'escrow', 'stake', 'collateral'] as const;
export const CADENCES = ['hourly', 'daily', 'weekly', 'monthly'] as const;
export type Cadence = (typeof CADENCES)[number];

/** svc-ledger's list answer, or null when it is not exactly that shape. */
export function parseControlList(raw: unknown): ReconciliationControlView[] | null {
  const parsed = reconciliationControlListSchema.safeParse(raw);
  return parsed.success ? parsed.data.controls : null;
}

export function parseControlView(raw: unknown): ReconciliationControlView | null {
  const parsed = reconciliationControlViewSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function parseControlRun(raw: unknown): ReconciliationControlRunView | null {
  const parsed = reconciliationControlRunSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** What a founder types into the define and update form. Every field is text, so a blank is visibly blank. */
export interface ControlForm {
  readonly template: ControlTemplate;
  readonly explanation: string;
  readonly labels: string;
  readonly cadence: Cadence | '';
  readonly hour: string;
  readonly minute: string;
  readonly isoWeekday: string;
  readonly day: string;
  readonly severity: ControlSeverity | '';
  readonly toleranceDefault: string;
  readonly toleranceByAsset: string;
  readonly margin: string;
  readonly accountMode: 'query' | 'explicit';
  readonly accountIds: string;
  readonly ownerType: (typeof OWNER_TYPES)[number] | '';
  readonly ownerIdPrefix: string;
  readonly accountKind: (typeof ACCOUNT_KINDS)[number] | '';
  readonly purpose: string;
  readonly assetId: string;
  readonly thresholdBound: 'min' | 'max' | '';
  readonly thresholdByAsset: string;
  readonly activate: boolean;
  readonly reason: string;
}

export function emptyControlForm(): ControlForm {
  return {
    template: 'threshold',
    explanation: '',
    labels: '',
    cadence: '',
    hour: '',
    minute: '',
    isoWeekday: '',
    day: '',
    severity: '',
    toleranceDefault: '',
    toleranceByAsset: '',
    margin: '',
    accountMode: 'query',
    accountIds: '',
    ownerType: '',
    ownerIdPrefix: '',
    accountKind: '',
    purpose: '',
    assetId: '',
    thresholdBound: '',
    thresholdByAsset: '',
    activate: false,
    reason: '',
  };
}

const byAssetText = (record: Readonly<Record<string, string>>): string =>
  Object.entries(record)
    .map(([asset, amount]) => `${asset}=${amount}`)
    .join(', ');

/** The form for changing a control, filled with what svc-ledger holds now. Unset values stay blank. */
export function formFromControl(view: ReconciliationControlView): ControlForm {
  const schedule = view.schedule.status === 'set' ? view.schedule.value : null;
  const accountSet = view.accountSet;
  return {
    ...emptyControlForm(),
    template: view.template,
    explanation: view.explanation,
    labels: view.labels.join(', '),
    cadence: schedule?.cadence ?? '',
    hour: schedule && 'hour' in schedule ? String(schedule.hour) : '',
    minute: schedule ? String(schedule.minute) : '',
    isoWeekday: schedule?.cadence === 'weekly' ? String(schedule.isoWeekday) : '',
    day: schedule?.cadence === 'monthly' ? String(schedule.day) : '',
    severity: view.severity.status === 'set' ? view.severity.value : '',
    toleranceDefault: view.tolerance.status === 'set' ? view.tolerance.default : '',
    toleranceByAsset: view.tolerance.status === 'set' ? byAssetText(view.tolerance.byAsset) : '',
    margin: view.margin.status === 'set' ? view.margin.value : '',
    accountMode: accountSet.mode === 'explicit' ? 'explicit' : 'query',
    accountIds: accountSet.mode === 'explicit' ? accountSet.accountIds.join('\n') : '',
    ownerType: accountSet.mode === 'query' ? (accountSet.ownerType ?? '') : '',
    ownerIdPrefix: accountSet.mode === 'query' ? (accountSet.ownerIdPrefix ?? '') : '',
    accountKind: accountSet.mode === 'query' ? (accountSet.kind ?? '') : '',
    purpose: accountSet.mode === 'query' ? (accountSet.purpose ?? '') : '',
    assetId: accountSet.mode === 'query' ? (accountSet.assetId ?? '') : '',
    thresholdBound: view.threshold.status === 'set' ? view.threshold.bound : '',
    thresholdByAsset: view.threshold.status === 'set' ? byAssetText(view.threshold.byAsset) : '',
  };
}

export type Built<T> = { readonly ok: true; readonly body: T } | { readonly ok: false; readonly why: string };

/** `USDT=0.5, BTC=0` as a record. Blank is null (not set); a malformed pair is an error naming it. */
function parseByAsset(text: string, what: string): { value: Record<string, string> | null } | { why: string } {
  const pairs = text
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (pairs.length === 0) return { value: null };
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const match = /^([A-Za-z0-9]{2,16})\s*=\s*(\S+)$/.exec(pair);
    if (!match) return { why: `${what}: write each as ASSET=amount, for example USDT=0.5 ("${pair}" is not).` };
    out[match[1]!] = match[2]!;
  }
  return { value: out };
}

const wholeNumber = (text: string): number | null => (/^\d{1,2}$/.test(text.trim()) ? Number(text.trim()) : null);

function scheduleOf(form: ControlForm): { value: ReconciliationSchedule | null } | { why: string } {
  if (form.cadence === '') return { value: null };
  const minute = wholeNumber(form.minute);
  const hour = wholeNumber(form.hour);
  if (minute === null) return { why: 'Schedule: the minute (UTC) is required for every cadence.' };
  if (form.cadence === 'hourly') return { value: { cadence: 'hourly', minute } };
  if (hour === null) return { why: 'Schedule: the hour (UTC) is required for a daily, weekly or monthly control.' };
  if (form.cadence === 'daily') return { value: { cadence: 'daily', hour, minute } };
  if (form.cadence === 'weekly') {
    const isoWeekday = wholeNumber(form.isoWeekday);
    if (isoWeekday === null) return { why: 'Schedule: the weekday (1 Monday to 7 Sunday) is required for a weekly control.' };
    return { value: { cadence: 'weekly', isoWeekday, hour, minute } };
  }
  const day = wholeNumber(form.day);
  if (day === null) return { why: 'Schedule: the day of the month is required for a monthly control.' };
  return { value: { cadence: 'monthly', day, hour, minute } };
}

function accountSetOf(form: ControlForm): DefineReconciliationControlInput['accountSet'] {
  if (form.accountMode === 'explicit') {
    const accountIds = form.accountIds
      .split(/[\s,]+/)
      .map((id) => id.trim().toLowerCase())
      .filter((id) => id !== '');
    return { mode: 'explicit', accountIds };
  }
  return {
    mode: 'query',
    ...(form.ownerType ? { ownerType: form.ownerType } : {}),
    ...(form.ownerIdPrefix.trim() ? { ownerIdPrefix: form.ownerIdPrefix.trim() } : {}),
    ...(form.accountKind ? { kind: form.accountKind } : {}),
    ...(form.purpose.trim() ? { purpose: form.purpose.trim() } : {}),
    ...(form.assetId.trim() ? { assetId: form.assetId.trim() } : {}),
  };
}

/** The fields define and update share, with only what the founder filled in. */
function policyOf(form: ControlForm): { value: Omit<DefineReconciliationControlInput, 'template' | 'reason'> } | { why: string } {
  const schedule = scheduleOf(form);
  if ('why' in schedule) return schedule;
  const toleranceByAsset = parseByAsset(form.toleranceByAsset, 'Tolerance by asset');
  if ('why' in toleranceByAsset) return toleranceByAsset;
  const thresholdByAsset = parseByAsset(form.thresholdByAsset, 'Threshold by asset');
  if ('why' in thresholdByAsset) return thresholdByAsset;
  if (thresholdByAsset.value && form.thresholdBound === '')
    return { why: 'Threshold: choose whether each amount is a minimum or a maximum.' };
  const toleranceDefault = form.toleranceDefault.trim();
  const tolerance =
    toleranceDefault !== '' || toleranceByAsset.value
      ? {
          ...(toleranceDefault !== '' ? { default: toleranceDefault } : {}),
          ...(toleranceByAsset.value ? { byAsset: toleranceByAsset.value } : {}),
        }
      : null;
  const labels = form.labels
    .split(',')
    .map((label) => label.trim())
    .filter((label) => label !== '');
  return {
    value: {
      ...(form.explanation.trim() ? { explanation: form.explanation.trim() } : {}),
      ...(labels.length > 0 ? { labels } : {}),
      ...(schedule.value ? { schedule: schedule.value } : {}),
      ...(form.severity ? { severity: form.severity } : {}),
      ...(tolerance ? { tolerance } : {}),
      ...(form.margin.trim() !== '' ? { margin: form.margin.trim() } : {}),
      accountSet: accountSetOf(form),
      ...(thresholdByAsset.value && form.thresholdBound
        ? { threshold: { bound: form.thresholdBound, byAsset: thresholdByAsset.value } }
        : {}),
      ...(form.activate ? { activate: true } : {}),
    },
  };
}

/** The contract's first complaint, in words. Its own refusal code stays visible beside them. */
function contractWhy(error: {
  readonly issues: ReadonlyArray<{ readonly path: ReadonlyArray<PropertyKey>; readonly message: string }>;
}): string {
  const issue = error.issues[0];
  if (!issue) return 'The contract refused this control.';
  const where = issue.path.map(String).join('.');
  if (where === 'reason') return 'Write the reason first (12 to 500 characters).';
  if (issue.message === 'ops.control_policy_unset')
    return `${where === 'accountSet' ? 'Account set' : where || 'Policy'}: ops.control_policy_unset. Name at least one account or one account filter.`;
  return `${where || 'Control'}: ${issue.message}`;
}

export function buildDefineBody(form: ControlForm): Built<DefineReconciliationControlInput> {
  const policy = policyOf(form);
  if ('why' in policy) return { ok: false, why: policy.why };
  const parsed = defineReconciliationControlInputSchema.safeParse({ template: form.template, ...policy.value, reason: form.reason });
  return parsed.success ? { ok: true, body: parsed.data } : { ok: false, why: contractWhy(parsed.error) };
}

/**
 * svc-ledger's update keeps every value the body leaves out, so a blanked field would be reported saved and stay as it was.
 * Explanation and labels can be emptied (an empty text and an empty list are values); a set schedule, severity, tolerance,
 * margin or threshold cannot be taken back to blank, and the form says so instead of sending.
 */
function cleared(control: ReconciliationControlView, form: ControlForm): string | null {
  const blanked = [
    control.schedule.status === 'set' && form.cadence === '' && 'schedule',
    control.severity.status === 'set' && form.severity === '' && 'severity',
    control.tolerance.status === 'set' && form.toleranceDefault.trim() === '' && 'tolerance',
    control.margin.status === 'set' && form.margin.trim() === '' && 'margin',
    control.threshold.status === 'set' && form.thresholdByAsset.trim() === '' && 'threshold',
  ].filter(Boolean);
  return blanked.length === 0
    ? null
    : `svc-ledger cannot take a set ${blanked.join(', ')} back to blank. Put the value back, or define a new control without it.`;
}

export function buildUpdateBody(control: ReconciliationControlView, form: ControlForm): Built<UpdateReconciliationControlInput> {
  const blanked = cleared(control, form);
  if (blanked) return { ok: false, why: blanked };
  const policy = policyOf(form);
  if ('why' in policy) return { ok: false, why: policy.why };
  const parsed = updateReconciliationControlInputSchema.safeParse({
    controlId: control.id,
    ...policy.value,
    explanation: form.explanation.trim(),
    labels: policy.value.labels ?? [],
    reason: form.reason,
  });
  return parsed.success ? { ok: true, body: parsed.data } : { ok: false, why: contractWhy(parsed.error) };
}

/**
 * The instant a run reads at: `now` when the field is blank, else the typed UTC date and time as svc-ledger writes it
 * (`toISOString`), because that exact text is what both founders sign. Null when it is not a date and time.
 */
export function runInstant(typed: string): string | null {
  const text = typed.trim();
  if (text === '') return 'now';
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!match) return null;
  const full = text.length === 16 ? `${text}:00` : text;
  const date = new Date(`${full}.000Z`);
  // `Date` rolls an impossible day over (30 February becomes 2 March); only a time that reads back as typed is signed.
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 19) !== full) return null;
  return date.toISOString();
}

/**
 * The margin a run is signed with, as svc-ledger will choose it: `unset` for a run now; for a past instant the typed margin,
 * else the control's own. Null when neither is set: svc-ledger refuses that with `ops.control_margin_unset`, so it is not proposed.
 */
export function runMargin(asOf: string, typed: string, control: ReconciliationControlView): string | null {
  if (asOf === 'now') return 'unset';
  const chosen = typed.trim() !== '' ? typed.trim() : control.margin.status === 'set' ? control.margin.value : '';
  return isMargin(chosen) ? chosen : null;
}

/** A margin as the contract writes it: seconds, a decimal with no sign and no exponent. */
export function isMargin(text: string): boolean {
  return reconciliationDecimalSchema.safeParse(text).success;
}

export function describeSchedule(view: ReconciliationControlView): string {
  if (view.schedule.status === 'unset') return 'Not set';
  const s = view.schedule.value;
  const at = (hour: number, minute: number) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} UTC`;
  if (s.cadence === 'hourly') return `Hourly at minute ${s.minute}`;
  if (s.cadence === 'daily') return `Daily at ${at(s.hour, s.minute)}`;
  if (s.cadence === 'weekly') return `Weekly on day ${s.isoWeekday} at ${at(s.hour, s.minute)}`;
  return `Monthly on day ${s.day} at ${at(s.hour, s.minute)}`;
}

export function describeAccountSet(view: ReconciliationControlView): string {
  const set = view.accountSet;
  if (set.mode === 'all') return 'The whole book';
  if (set.mode === 'explicit') return `${set.accountIds.length} named account${set.accountIds.length === 1 ? '' : 's'}`;
  const parts = [
    set.ownerType && `owner type ${set.ownerType}`,
    set.ownerIdPrefix && `owner id starts ${set.ownerIdPrefix}`,
    set.kind && `kind ${set.kind}`,
    set.purpose && `purpose ${set.purpose}`,
    set.assetId && `asset ${set.assetId}`,
  ].filter(Boolean);
  return `Every account with ${parts.join(', ')}, matched at each run`;
}

export function describeTolerance(view: ReconciliationControlView): string {
  if (view.tolerance.status === 'unset') return 'Not set';
  const extra = byAssetText(view.tolerance.byAsset);
  return extra ? `${view.tolerance.default} (${extra})` : view.tolerance.default;
}

export function describeThreshold(view: ReconciliationControlView): string | null {
  if (view.threshold.status === 'unset') return view.template === 'threshold' ? 'Not set' : null;
  return `${view.threshold.bound === 'min' ? 'At least' : 'At most'} ${byAssetText(view.threshold.byAsset)}`;
}

/** What a refused control step means, in words. The code is shown beside it. */
export function controlRefusal(code: string | null, status: number): string {
  switch (code) {
    case 'ops.control_policy_unset':
      return 'The control is missing a policy value (tolerance, schedule and severity; a threshold control also needs a threshold per asset), so it was not activated or resumed. A new control asked to activate is not stored at all.';
    case 'ops.control_margin_unset':
      return 'A run at a past instant needs a margin: type one, or set it on the control. Typed 0 is accepted.';
    case 'ops.control_state_illegal':
      return 'The control’s state does not allow this step: only an active control runs, a paused one must be resumed first, and a retired one is final.';
    case 'ops.control_reason_required':
      return 'A reason of 12 to 500 characters is required.';
    case 'ledger.reconcile_asof_invalid':
      return 'The instant is in the future, or is not a date and time. A run reads only the past.';
    case 'ledger.reconcile_builtin_immutable':
      return 'This is a built-in control. It cannot be changed or removed.';
    case 'ledger.reconcile_control_not_found':
      return 'No control has that id.';
    case 'ledger.reconcile_source_unavailable':
      return 'svc-ledger could not reach its own book for controls. A run may already have stored its result row: read the controls again before repeating anything.';
    case 'ledger.idempotency_conflict':
      return 'This approval was already used for a different run. Ask for a new approval.';
    case 'ledger.operator_request_failed':
    case 'edge.invalid_reconciliation_control':
      return 'The control was refused for its shape before anything was stored.';
    case 'edge.ledger_unreachable':
      return 'This console’s edge has no ledger address, so nothing was sent.';
    case 'admin.ledger_unconfigured':
      return 'This console holds no treasury credential, so it cannot define, change or run a control.';
    case 'mfa.required':
      return 'This needs a sign-in with a second factor.';
    case 'scope.denied':
    case 'admin.authority_refused':
      return 'This credential does not carry what the step needs: listing takes the compliance or treasury permission, and define, change and run take the treasury permission.';
    case 'token.invalid':
      return 'The session behind this credential is not live. Sign in again.';
    case 'admin.upstream_invalid':
      return 'svc-ledger answered with a shape this console does not recognise, so nothing is shown rather than a guess.';
    case 'admin.upstream_unavailable':
      return 'svc-ledger did not answer in time. Read the controls again before repeating anything.';
    default:
      return `The step was refused (${status}).`;
  }
}

/** A run as one line for the desk's reply: what it found and the as-of of each source. Decimal strings stay strings. */
export function describeRun(run: ReconciliationControlRunView): string {
  const outside = run.sources.outside.asOf === 'unset' ? 'unset' : run.sources.outside.asOf;
  const parity = run.sources.parity.asOf === 'unset' ? 'unset' : run.sources.parity.asOf;
  return [
    `Run ${run.id}: ${run.status}.`,
    `As of ${run.asOf}; balances read at ${run.readAt}${run.margin.status === 'set' ? ` (margin ${run.margin.value} s)` : ''}.`,
    `Sources: ledger as of ${run.sources.ledger.asOf}; outside ${outside}; parity ${parity}. Outside side: ${run.outsideSide}.`,
    `${run.accounts.length} account${run.accounts.length === 1 ? '' : 's'} and ${run.assets.length} asset${run.assets.length === 1 ? '' : 's'} read.`,
    ...(run.errorCode.status === 'set'
      ? [`Error: ${run.errorCode.value}${run.phase.status === 'set' ? ` at ${run.phase.value}` : ''}.`]
      : []),
    ...run.assets.map(describeEvidence),
  ].join(' ');
}

/** One asset's evidence (OPS-reconciliation-02): what was observed, what was expected, the difference and the tolerance. */
export function describeEvidence(asset: ReconciliationControlRunView['assets'][number]): string {
  return `${asset.assetId}: observed ${asset.observed}, expected ${asset.expected}, difference ${asset.difference}, tolerance ${asset.tolerance}.`;
}

/** What each move is called on screen. Where it may go from, and to, is the contract's one table. */
export const LIFECYCLE_LABELS: Record<ReconciliationLifecycle, string> = { pause: 'Pause', resume: 'Resume', retire: 'Retire' };

/** The lifecycle moves svc-ledger accepts from a control's state, in the order the console shows them. */
export function lifecycleMoves(control: ReconciliationControlView): ReconciliationLifecycle[] {
  if (control.builtin) return [];
  return RECONCILIATION_LIFECYCLE.filter((move) => RECONCILIATION_LIFECYCLE_MOVES[move].from.includes(control.state));
}

export const STATE_LABELS: Record<ReconciliationControlView['state'], string> = {
  draft: 'Draft',
  active: 'Active',
  paused: 'Paused',
  retired: 'Retired',
};
