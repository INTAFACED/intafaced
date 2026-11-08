/**
 * Pure model of the card disputes desk (J-bank-27; BK-cdisp-02, BK-cdisp-03). Strict readers of svc-bank's answers and of
 * what the browser posts, the words for each state and typed refusal, and how a loss and a credit read. Nothing here sums,
 * counts or fills in a figure: every number is svc-bank's own, and an unknown reads "not known", never a guess.
 */

export const DISPUTE_STATES = ['opened', 'representment', 'arbitration', 'closed'] as const;
export type DisputeState = (typeof DISPUTE_STATES)[number];
export const DISPUTE_OUTCOMES = ['cardholder', 'merchant'] as const;
export type DisputeOutcome = (typeof DISPUTE_OUTCOMES)[number];
const EVENT_KINDS = ['opened', 'evidence', 'representment', 'arbitration', 'provisional_credit', 'closed'] as const;
type EventKind = (typeof EVENT_KINDS)[number];
const BEARERS = ['partner', 'programme', 'cardholder'] as const;
type Bearer = (typeof BEARERS)[number];

export const STATE_LABEL: Readonly<Record<DisputeState, string>> = {
  opened: 'Opened',
  representment: 'Representment submitted',
  arbitration: 'In arbitration',
  closed: 'Closed',
};
export const EVENT_LABEL: Readonly<Record<EventKind, string>> = {
  opened: 'Case opened',
  evidence: 'Evidence added',
  representment: 'Representment submitted',
  arbitration: 'Escalated to arbitration',
  provisional_credit: 'Provisional credit (the partner’s)',
  closed: 'Decided and closed',
};
export const OUTCOME_LABEL: Readonly<Record<DisputeOutcome, string>> = {
  cardholder: 'For the cardholder',
  merchant: 'For the merchant',
};
const BEARER_WORDS: Readonly<Record<Bearer, string>> = {
  partner: 'The partner',
  programme: 'The programme (INTAFACED)',
  cardholder: 'The cardholder',
};
export const NOT_KNOWN = 'not known';

export const REFUSAL_WORDS: Readonly<Record<string, string>> = {
  'bank.card_dispute_not_found': 'No such dispute. Read the queue again.',
  'bank.card_dispute_invalid': 'That request was not accepted. Nothing was changed.',
  'bank.card_dispute_state': 'That step is not open to this case in its state. Read the case again.',
  'bank.card_dispute_not_disputable': 'That card payment has no settled capture to dispute, or the amount is above what was captured.',
  'bank.card_dispute_cap_unset':
    'The owner has not published the dispute cap for this asset, so no credit or decision for the cardholder can be made. Nothing was changed.',
  'bank.card_dispute_cap_exceeded': 'This dispute is above the owner’s dispute cap. Nothing was credited or decided for the cardholder.',
  'bank.card_dispute_partner_unset': 'The card partner does not take this through the programme. Nothing was changed.',
  'bank.no_card_issuer': 'This deployment has no card partner to ask. Nothing was changed.',
  'bank.card_sim_not_live': 'The TEST card partner is not a live partner here. Nothing was changed.',
};
export const refusalWords = (code: string | null): string | null =>
  code !== null && Object.hasOwn(REFUSAL_WORDS, code) ? REFUSAL_WORDS[code]! : null;

/** svc-bank names its refusal at the end of its message, `(...code)`, where the wire carries no typed cause. */
export function refusalCode(code: string | null, message: string): string | null {
  if (code !== null) return code;
  return /\((bank\.[a-z0-9_]+)\)\s*$/.exec(message)?.[1] ?? null;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const DECIMAL = /^\d+(\.\d{1,18})?$/;
const dec = (v: unknown): v is string => str(v) && DECIMAL.test(v);
const decOrNull = (v: unknown): v is string | null => v === null || dec(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => str(v) && (list as readonly string[]).includes(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DisputeSummary {
  readonly id: string;
  readonly cardId: string;
  readonly userId: string;
  readonly authorizationRef: string;
  readonly assetId: string;
  readonly amount: string;
  readonly reason: string;
  readonly state: DisputeState;
  readonly test: boolean;
  readonly credit: { state: 'none' | 'asked' | 'credited'; amount: string | null; partnerRef: string | null; at: string | null };
  readonly decision: {
    outcome: DisputeOutcome;
    lossStatus: 'reported' | 'not_known';
    lossBearer: Bearer | null;
    lossTerms: string | null;
    creditSettlement: 'final' | 'reversed' | null;
    creditSettlementPartnerRef: string | null;
    closedAt: string;
  } | null;
  readonly createdAt: string;
}
export interface DisputeEvent {
  readonly sequence: number;
  readonly kind: EventKind;
  readonly fromState: DisputeState | null;
  readonly toState: DisputeState;
  readonly actor: string;
  readonly detail: string | null;
  readonly afterSubmission: boolean;
  readonly at: string;
}
export interface DisputeCase extends DisputeSummary {
  readonly cap: string | null;
  readonly events: readonly DisputeEvent[];
}

export function parseSummary(raw: unknown): DisputeSummary | null {
  const r = rec(raw);
  const c = rec(r?.provisionalCredit);
  if (!r || !c) return null;
  if (!(str(r.id) && UUID.test(r.id) && str(r.cardId) && str(r.userId) && str(r.authorizationRef) && str(r.assetId))) return null;
  if (!(dec(r.amount) && str(r.reason) && oneOf(DISPUTE_STATES, r.state) && typeof r.test === 'boolean' && str(r.createdAt))) return null;
  if (!(oneOf(['none', 'asked', 'credited'] as const, c.state) && decOrNull(c.amount) && strOrNull(c.partnerRef) && strOrNull(c.at)))
    return null;
  let decision: DisputeSummary['decision'] = null;
  if (r.decision !== null) {
    const d = rec(r.decision);
    if (!d) return null;
    if (!(oneOf(DISPUTE_OUTCOMES, d.outcome) && oneOf(['reported', 'not_known'] as const, d.lossStatus))) return null;
    if (!(d.lossBearer === null || oneOf(BEARERS, d.lossBearer)) || !strOrNull(d.lossTerms) || !str(d.closedAt)) return null;
    if (
      !(d.creditSettlement === null || oneOf(['final', 'reversed'] as const, d.creditSettlement)) ||
      !strOrNull(d.creditSettlementPartnerRef)
    )
      return null;
    // A reported loss names its bearer and the terms; "not known" names neither. Anything else is not shown.
    if (d.lossStatus === 'reported' ? d.lossBearer === null || d.lossTerms === null : d.lossBearer !== null || d.lossTerms !== null)
      return null;
    decision = {
      outcome: d.outcome,
      lossStatus: d.lossStatus,
      lossBearer: d.lossBearer as Bearer | null,
      lossTerms: d.lossTerms,
      creditSettlement: d.creditSettlement as 'final' | 'reversed' | null,
      creditSettlementPartnerRef: d.creditSettlementPartnerRef,
      closedAt: d.closedAt,
    };
  }
  return {
    id: r.id,
    cardId: r.cardId,
    userId: r.userId,
    authorizationRef: r.authorizationRef,
    assetId: r.assetId,
    amount: r.amount,
    reason: r.reason,
    state: r.state,
    test: r.test,
    credit: { state: c.state, amount: c.amount, partnerRef: c.partnerRef, at: c.at },
    decision,
    createdAt: r.createdAt,
  };
}

export function parseQueue(raw: unknown): DisputeSummary[] | null {
  if (!Array.isArray(raw)) return null;
  const rows = raw.map(parseSummary);
  return rows.every((r): r is DisputeSummary => r !== null) ? rows : null;
}

/** The queue page svc-bank sends: its rows, and whether the list was cut at its limit. */
export function parseQueuePage(raw: unknown): { rows: DisputeSummary[]; more: boolean } | null {
  const r = rec(raw);
  const rows = parseQueue(r?.rows);
  return r && rows && typeof r.more === 'boolean' ? { rows, more: r.more } : null;
}

export function parseCase(raw: unknown): DisputeCase | null {
  const base = parseSummary(raw);
  const r = rec(raw);
  if (!base || !r || !decOrNull(r.cap) || !Array.isArray(r.events)) return null;
  const events: DisputeEvent[] = [];
  for (const e of r.events) {
    const x = rec(e);
    if (
      !x ||
      typeof x.sequence !== 'number' ||
      !oneOf(EVENT_KINDS, x.kind) ||
      !(x.fromState === null || oneOf(DISPUTE_STATES, x.fromState))
    )
      return null;
    if (!oneOf(DISPUTE_STATES, x.toState) || !str(x.actor) || !strOrNull(x.detail) || typeof x.afterSubmission !== 'boolean' || !str(x.at))
      return null;
    events.push({
      sequence: x.sequence,
      kind: x.kind,
      fromState: x.fromState as DisputeState | null,
      toState: x.toState,
      actor: x.actor,
      detail: x.detail,
      afterSubmission: x.afterSubmission,
      at: x.at,
    });
  }
  return { ...base, cap: r.cap, events };
}

/** Who bears the fraud loss, as the case recorded it: the partner's terms, or "not known". Never the partner by default. */
export function lossWords(decision: NonNullable<DisputeSummary['decision']>): string {
  if (decision.lossStatus === 'not_known' || decision.lossBearer === null || decision.lossTerms === null) return NOT_KNOWN;
  return `${BEARER_WORDS[decision.lossBearer]}, under the partner’s terms: ${decision.lossTerms}`;
}

export function creditWords(d: DisputeSummary): string {
  if (d.credit.state === 'credited' && d.credit.amount) return `${d.credit.amount} ${d.assetId}, the partner’s credit`;
  if (d.credit.state === 'asked') return 'Asked of the partner; no answer recorded yet';
  return 'None';
}

/** The state filter from the address bar: one of the states, or none (every case). Anything else is none. */
export function readStateFilter(raw: string | string[] | undefined): DisputeState | null {
  return oneOf(DISPUTE_STATES, raw) ? raw : null;
}

export const isDisputeId = (v: string | null | undefined): v is string => typeof v === 'string' && UUID.test(v);

export type DisputeAction =
  | { action: 'evidence'; disputeId: string; stepKey: string; description: string }
  | { action: 'representment'; disputeId: string; stepKey: string; description: string }
  | { action: 'arbitration'; disputeId: string; stepKey: string }
  | { action: 'credit'; disputeId: string }
  | { action: 'decide'; disputeId: string; outcome: DisputeOutcome };

const KEY = /^[A-Za-z0-9:_-]{8,128}$/;
const words = (v: unknown, max: number): string | null => {
  if (!str(v)) return null;
  const s = v.trim();
  return s.length >= 1 && s.length <= max ? s : null;
};

/** Strict reader of what the browser posts; anything off-shape is null and nothing is sent. */
export function readDisputeAction(raw: unknown): DisputeAction | null {
  const r = rec(raw);
  if (!r || !isDisputeId(r.disputeId as string)) return null;
  const disputeId = r.disputeId as string;
  const keys = Object.keys(r).sort().join(',');
  const stepKey = str(r.stepKey) && KEY.test(r.stepKey) ? r.stepKey : null;
  switch (r.action) {
    case 'evidence':
    case 'representment': {
      const description = words(r.description, 2000);
      return description && stepKey && keys === 'action,description,disputeId,stepKey'
        ? { action: r.action, disputeId, stepKey, description }
        : null;
    }
    case 'arbitration':
      return stepKey && keys === 'action,disputeId,stepKey' ? { action: 'arbitration', disputeId, stepKey } : null;
    case 'credit':
      return keys === 'action,disputeId' ? { action: 'credit', disputeId } : null;
    case 'decide':
      return oneOf(DISPUTE_OUTCOMES, r.outcome) && keys === 'action,disputeId,outcome'
        ? { action: 'decide', disputeId, outcome: r.outcome }
        : null;
    default:
      return null;
  }
}

/** The svc-bank procedure and body for one action. */
export function procedureFor(a: DisputeAction): { procedure: string; body: Record<string, unknown> } {
  const { action, ...body } = a;
  const procedure = {
    evidence: 'ops.cardDisputeEvidence',
    representment: 'ops.cardDisputeRepresentment',
    arbitration: 'ops.cardDisputeArbitration',
    credit: 'ops.cardDisputeCredit',
    decide: 'ops.cardDisputeDecide',
  }[action];
  return { procedure, body };
}

/** A fresh key for one step form; kept until the step is stored, so a lost reply is safe to send again. */
export const newStepKey = (random: () => string = () => crypto.randomUUID()): string => `console-dispute-${random()}`;
