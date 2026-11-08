import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { z } from 'zod';
import { BankError } from '../errors.js';
import type { CardIssuerAdapter } from './issuer.js';
import { LOSS_BEARERS, NOT_KNOWN, type CardPartnerTerms, type LossBearer } from './partner-terms.js';

/**
 * CARD DISPUTES, AS SUPPORT WORKS THEM (J-bank-27; BK-cdisp-02, BK-cdisp-03).
 *
 * A case is one cardholder's dispute of one settled card capture. Support files it, adds evidence, submits a representment,
 * escalates to arbitration (an explicit state, never implied), asks the card partner for a provisional credit, and decides
 * the case. Every step is a row in the case's timeline with who did it and when; evidence added after the representment was
 * submitted is kept with its own time and marked so.
 *
 * The money is the partner's (OWNER 226). A provisional credit is the partner's credit to its own cardholder: the partner
 * answers with its reference and the amount it credited, and the cardholder's available, as the partner reports it, rises
 * by that amount. Who bears a fraud loss is the partner's terms at the moment of the decision, or "not known"; it is never
 * assumed to be the partner. Nothing here posts to the ledger, and no figure here is summed into a balance.
 *
 * The dispute cap is the owner's (`BANK_CARD_DISPUTE_CAP_JSON`): the most one dispute may be credited or decided for the
 * cardholder, per asset. Blank refuses `bank.card_dispute_cap_unset`; above it refuses `bank.card_dispute_cap_exceeded`.
 * A decision for the merchant needs no cap: nothing is given to the cardholder.
 */

export const DISPUTE_STATES = ['opened', 'representment', 'arbitration', 'closed'] as const;
export type DisputeState = (typeof DISPUTE_STATES)[number];
export const DISPUTE_OUTCOMES = ['cardholder', 'merchant'] as const;
export type DisputeOutcome = (typeof DISPUTE_OUTCOMES)[number];
export const DISPUTE_EVENT_KINDS = ['opened', 'evidence', 'representment', 'arbitration', 'provisional_credit', 'closed'] as const;
export type DisputeEventKind = (typeof DISPUTE_EVENT_KINDS)[number];

/** The owner's dispute cap per asset, as decimal strings; null is "not published". */
export type DisputeCap = ReadonlyMap<string, string> | null;

export const BANK_CARD_DISPUTE_CAP_ENV = 'BANK_CARD_DISPUTE_CAP_JSON';

const assetId = z.string().regex(/^[A-Z0-9]{2,16}$/);
const positive = z
  .string()
  .regex(/^\d+(\.\d{1,18})?$/)
  .refine((v) => /[1-9]/.test(v), 'a cap is above zero');

/** `{"USDC":"100.00"}`. Blank is null (not published). Malformed refuses to start, naming the variable. */
export function parseDisputeCap(raw: string | undefined | null): DisputeCap {
  if (raw === undefined || raw === null || raw.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${BANK_CARD_DISPUTE_CAP_ENV} is not JSON`);
  }
  const checked = z
    .record(assetId, positive)
    .refine((m) => Object.keys(m).length >= 1 && Object.keys(m).length <= 50, 'one to fifty assets')
    .safeParse(parsed);
  if (!checked.success) {
    throw new Error(`${BANK_CARD_DISPUTE_CAP_ENV} is not in shape: ${checked.error.issues.map((i) => i.message).join('; ')}`);
  }
  return new Map(Object.entries(checked.data));
}

/** The cap for this asset, or a typed refusal: not published, or the amount above it. */
export function assertUnderDisputeCap(cap: DisputeCap, asset: string, amount: string): string {
  const limit = cap?.get(asset);
  if (limit === undefined) {
    throw new BankError(
      `The dispute cap for ${asset} is not published: it is the owner's to set (bank.card_dispute_cap_unset)`,
      'bank.card_dispute_cap_unset',
    );
  }
  if (parseAmount(amount) > parseAmount(limit)) {
    throw new BankError(
      `The disputed ${amount} ${asset} is above the dispute cap of ${limit} ${asset} (bank.card_dispute_cap_exceeded)`,
      'bank.card_dispute_cap_exceeded',
    );
  }
  return limit;
}

/** Who bears the loss, as the partner's terms say at the decision, or "not known". Never the partner by default. */
export function lossFromTerms(
  terms: CardPartnerTerms,
): { status: 'reported'; bearer: LossBearer; terms: string } | { status: 'not_known'; bearer: null; terms: null } {
  const l = terms.lossLiability;
  if (!l || !(LOSS_BEARERS as readonly string[]).includes(l.bearer) || l.terms.trim() === '') {
    return { status: 'not_known', bearer: null, terms: null };
  }
  return { status: 'reported', bearer: l.bearer, terms: l.terms };
}

export interface DisputeEvent {
  readonly sequence: number;
  readonly kind: DisputeEventKind;
  readonly fromState: DisputeState | null;
  readonly toState: DisputeState;
  readonly actor: string;
  readonly detail: string | null;
  readonly afterSubmission: boolean;
  readonly at: string;
}

export interface DisputeSummary {
  readonly id: string;
  readonly caseKey: string;
  readonly cardId: string;
  readonly userId: string;
  readonly authorizationRef: string;
  readonly assetId: string;
  readonly amount: string;
  readonly reason: string;
  readonly state: DisputeState;
  readonly test: boolean;
  readonly provisionalCredit: {
    readonly state: 'none' | 'asked' | 'credited';
    readonly amount: string | null;
    readonly partnerRef: string | null;
    readonly at: string | null;
  };
  readonly decision: {
    readonly outcome: DisputeOutcome;
    readonly lossStatus: 'reported' | 'not_known';
    readonly lossBearer: LossBearer | null;
    readonly lossTerms: string | null;
    readonly creditSettlement: 'final' | 'reversed' | null;
    readonly creditSettlementPartnerRef: string | null;
    readonly closedAt: string;
  } | null;
  readonly createdAt: string;
}

export interface DisputeCase extends DisputeSummary {
  readonly events: DisputeEvent[];
  /** The owner's cap for this case's asset, or null (not published). */
  readonly cap: string | null;
}

interface DisputeRow {
  id: string;
  case_key: string;
  card_id: string;
  user_id: string;
  authorization_ref: string;
  asset_id: string;
  amount: string;
  reason: string;
  state: DisputeState;
  test: boolean;
  credit_requested_at: Date | null;
  credit_amount: string | null;
  credit_partner_ref: string | null;
  credited_at: Date | null;
  outcome: DisputeOutcome | null;
  loss_status: 'reported' | 'not_known' | null;
  loss_bearer: LossBearer | null;
  loss_terms: string | null;
  credit_settlement: 'final' | 'reversed' | null;
  credit_settlement_partner_ref: string | null;
  closed_at: Date | null;
  created_at: Date;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const dec = (v: string | null): string | null => (v === null ? null : formatAmount(parseAmount(v)));

function summary(r: DisputeRow): DisputeSummary {
  return {
    id: r.id,
    caseKey: r.case_key,
    cardId: r.card_id,
    userId: r.user_id,
    authorizationRef: r.authorization_ref,
    assetId: r.asset_id,
    amount: formatAmount(parseAmount(r.amount)),
    reason: r.reason,
    state: r.state,
    test: r.test,
    provisionalCredit: {
      state: r.credit_partner_ref ? 'credited' : r.credit_requested_at ? 'asked' : 'none',
      amount: dec(r.credit_amount),
      partnerRef: r.credit_partner_ref,
      at: iso(r.credited_at),
    },
    decision:
      r.state === 'closed' && r.outcome && r.loss_status && r.closed_at
        ? {
            outcome: r.outcome,
            lossStatus: r.loss_status,
            lossBearer: r.loss_bearer,
            lossTerms: r.loss_terms,
            creditSettlement: r.credit_settlement,
            creditSettlementPartnerRef: r.credit_settlement_partner_ref,
            closedAt: r.closed_at.toISOString(),
          }
        : null,
    createdAt: r.created_at.toISOString(),
  };
}

const text = (v: string, min: number, max: number, what: string): string => {
  const s = v.trim();
  if (s.length < min || s.length > max) {
    throw new BankError(`${what} must be ${min} to ${max} characters (bank.card_dispute_invalid)`, 'bank.card_dispute_invalid');
  }
  return s;
};
const key = (v: string): string => {
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(v)) {
    throw new BankError(
      'A step key is 8 to 128 letters, digits, colons, dashes or underscores (bank.card_dispute_invalid)',
      'bank.card_dispute_invalid',
    );
  }
  return v;
};

/** The opened case id is derived from its key, so the same key always names the same case. */
const caseId = (caseKey: string): string => {
  const h = createHash('sha256').update(`card-dispute:${caseKey}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export interface CardDisputeOptions {
  readonly issuer: CardIssuerAdapter;
  readonly partnerTerms: () => CardPartnerTerms;
  readonly simulated: () => boolean;
  readonly cap: DisputeCap;
  readonly clock?: () => Date;
}

const LIST_LIMIT = 200;

export class CardDisputeService {
  private readonly clock: () => Date;
  constructor(
    private readonly sql: Sql,
    private readonly options: CardDisputeOptions,
  ) {
    this.clock = options.clock ?? (() => new Date());
  }

  /** The queue, newest first, optionally one state. */
  async list(state?: DisputeState): Promise<DisputeSummary[]> {
    const rows = await this.sql<DisputeRow[]>`
      SELECT d.*, a.authorization_ref FROM bank.card_disputes d
        JOIN bank.card_authorizations a ON a.id = d.authorization_id
       WHERE ${state === undefined ? this.sql`TRUE` : this.sql`d.state = ${state}`}
       ORDER BY d.created_at DESC, d.id
       LIMIT ${LIST_LIMIT}
    `;
    return rows.map(summary);
  }

  async get(id: string): Promise<DisputeCase> {
    const row = await this.row(this.sql, id);
    const events = await this.sql<
      Array<{
        sequence: number;
        kind: DisputeEventKind;
        from_state: DisputeState | null;
        to_state: DisputeState;
        actor: string;
        detail: string | null;
        after_submission: boolean;
        at: Date;
      }>
    >`
      SELECT sequence, kind, from_state, to_state, actor, detail, after_submission, at
        FROM bank.card_dispute_events WHERE dispute_id = ${id} ORDER BY sequence
    `;
    return {
      ...summary(row),
      cap: this.options.cap?.get(row.asset_id) ?? null,
      events: events.map((e) => ({
        sequence: e.sequence,
        kind: e.kind,
        fromState: e.from_state,
        toState: e.to_state,
        actor: e.actor,
        detail: e.detail,
        afterSubmission: e.after_submission,
        at: e.at.toISOString(),
      })),
    };
  }

  /**
   * File a case for one settled capture of one card (support, on the cardholder's word). The amount may not be above what
   * was captured on that authorisation. The same case key with the same figures returns the case; with other figures, or a
   * second case for the same payment, it refuses.
   */
  async open(input: {
    caseKey: string;
    cardId: string;
    authorizationRef: string;
    amount: string;
    reason: string;
    actor: string;
  }): Promise<DisputeCase> {
    const caseKey = key(input.caseKey);
    const reason = text(input.reason, 1, 500, 'A dispute reason');
    if (!/^\d+(\.\d{1,18})?$/.test(input.amount) || parseAmount(input.amount) <= 0n) {
      throw new BankError('A disputed amount is a positive decimal (bank.card_dispute_invalid)', 'bank.card_dispute_invalid');
    }
    const amount = parseAmount(input.amount);
    const id = caseId(caseKey);
    await transaction(this.sql, async (tx) => {
      const [auth] = await tx<Array<{ id: string; user_id: string; asset_id: string; captured: string }>>`
        SELECT a.id, k.user_id, k.asset_id,
               COALESCE((SELECT SUM(s.amount) FROM bank.card_settlements s
                          WHERE s.authorization_id = a.id AND s.kind = 'capture' AND s.status = 'settled'), 0)::text AS captured
          FROM bank.card_authorizations a JOIN bank.cards k ON k.id = a.card_id
         WHERE a.card_id = ${input.cardId} AND a.authorization_ref = ${input.authorizationRef} AND a.decision = 'approved'
      `;
      if (!auth || parseAmount(auth.captured) === 0n) {
        throw new BankError(
          'That card payment has no settled capture to dispute (bank.card_dispute_not_disputable)',
          'bank.card_dispute_not_disputable',
        );
      }
      if (amount > parseAmount(auth.captured)) {
        throw new BankError(
          `The disputed amount is above the ${formatAmount(parseAmount(auth.captured))} captured (bank.card_dispute_not_disputable)`,
          'bank.card_dispute_not_disputable',
        );
      }
      const [prior] = await tx<Array<{ id: string; case_key: string; amount: string; reason: string; authorization_id: string }>>`
        SELECT id, case_key, amount::text, reason, authorization_id FROM bank.card_disputes
         WHERE case_key = ${caseKey} OR authorization_id = ${auth.id} FOR UPDATE
      `;
      if (prior) {
        const same =
          prior.case_key === caseKey &&
          prior.authorization_id === auth.id &&
          parseAmount(prior.amount) === amount &&
          prior.reason === reason;
        if (!same) {
          throw new BankError(
            'That case key or that payment already has a different dispute (bank.card_dispute_invalid)',
            'bank.card_dispute_invalid',
          );
        }
        return;
      }
      await tx`
        INSERT INTO bank.card_disputes (id, case_key, card_id, user_id, authorization_id, asset_id, amount, reason, state, test)
        VALUES (${id}, ${caseKey}, ${input.cardId}, ${auth.user_id}, ${auth.id}, ${auth.asset_id}, ${formatAmount(amount)},
                ${reason}, 'opened', ${this.options.simulated()})
      `;
      await this.event(tx, id, `${caseKey}:opened`, 'opened', null, 'opened', input.actor, reason, false);
    });
    return this.get(id);
  }

  /** Evidence, kept with its time. After the representment was submitted it is still kept, and marked as after submission. */
  async addEvidence(input: { disputeId: string; stepKey: string; description: string; actor: string }): Promise<DisputeCase> {
    const description = text(input.description, 1, 2000, 'Evidence');
    await this.step(input.disputeId, input.stepKey, async (tx, row) => {
      if (row.state === 'closed') this.wrongState('add evidence to', row.state);
      await this.event(tx, row.id, input.stepKey, 'evidence', row.state, row.state, input.actor, description, row.state !== 'opened');
    });
    return this.get(input.disputeId);
  }

  /** The representment: from opened only, and only with evidence on the case. */
  async submitRepresentment(input: { disputeId: string; stepKey: string; description: string; actor: string }): Promise<DisputeCase> {
    const description = text(input.description, 1, 2000, 'A representment');
    await this.step(input.disputeId, input.stepKey, async (tx, row) => {
      if (row.state !== 'opened') this.wrongState('submit a representment on', row.state);
      const [evidence] = await tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM bank.card_dispute_events WHERE dispute_id = ${row.id} AND kind = 'evidence'
      `;
      if (!evidence || evidence.n === 0) {
        throw new BankError('A representment needs evidence on the case first (bank.card_dispute_state)', 'bank.card_dispute_state');
      }
      await this.transition(tx, row.id, 'representment');
      await this.event(tx, row.id, input.stepKey, 'representment', 'opened', 'representment', input.actor, description, false);
    });
    return this.get(input.disputeId);
  }

  /** Arbitration, an explicit state: only after a representment. */
  async escalateToArbitration(input: { disputeId: string; stepKey: string; actor: string }): Promise<DisputeCase> {
    await this.step(input.disputeId, input.stepKey, async (tx, row) => {
      if (row.state !== 'representment') this.wrongState('escalate to arbitration', row.state);
      await this.transition(tx, row.id, 'arbitration');
      await this.event(tx, row.id, input.stepKey, 'arbitration', 'representment', 'arbitration', input.actor, null, false);
    });
    return this.get(input.disputeId);
  }

  /**
   * Ask the partner for its provisional credit, once per case, under the cap. The ask is written first, so a crash leaves
   * it; a retry asks the partner again under the same key (`card-dispute-credit:<case id>`), which it deduplicates. The case
   * records the amount and reference the partner answers with. Nothing posts.
   */
  async grantProvisionalCredit(input: { disputeId: string; actor: string }): Promise<DisputeCase> {
    const credit = this.options.issuer.provisionalCredit;
    if (!credit) {
      throw new BankError(
        'The card partner takes no provisional credit through this programme (bank.card_dispute_partner_unset)',
        'bank.card_dispute_partner_unset',
      );
    }
    const row = await this.row(this.sql, input.disputeId);
    if (row.credit_partner_ref) return this.get(row.id);
    if (row.state === 'closed') this.wrongState('credit', row.state);
    assertUnderDisputeCap(this.options.cap, row.asset_id, formatAmount(parseAmount(row.amount)));
    await this.sql`
      UPDATE bank.card_disputes SET credit_requested_at = COALESCE(credit_requested_at, ${this.clock()}), updated_at = now()
       WHERE id = ${row.id}
    `;
    const answer = await credit({
      requestId: creditKey(row.id),
      userId: row.user_id,
      assetId: row.asset_id,
      amount: formatAmount(parseAmount(row.amount)),
    });
    if (!/^\d+(\.\d{1,18})?$/.test(answer.amount) || parseAmount(answer.amount) <= 0n || !answer.partnerRef) {
      throw new BankError(
        'The card partner answered the credit in a shape this service cannot record (bank.card_dispute_partner_unset)',
        'bank.card_dispute_partner_unset',
      );
    }
    await transaction(this.sql, async (tx) => {
      const [locked] = await tx<Array<{ credit_partner_ref: string | null; state: DisputeState }>>`
        SELECT credit_partner_ref, state FROM bank.card_disputes WHERE id = ${row.id} FOR UPDATE
      `;
      if (locked?.credit_partner_ref) return;
      await tx`
        UPDATE bank.card_disputes
           SET credit_amount = ${formatAmount(parseAmount(answer.amount))}, credit_partner_ref = ${answer.partnerRef},
               credited_at = ${this.clock()}, updated_at = now()
         WHERE id = ${row.id}
      `;
      await this.event(
        tx,
        row.id,
        creditKey(row.id),
        'provisional_credit',
        locked!.state,
        locked!.state,
        input.actor,
        `${formatAmount(parseAmount(answer.amount))} ${row.asset_id}, the partner's credit, reference ${answer.partnerRef}`,
        false,
      );
    });
    return this.get(row.id);
  }

  /**
   * Decide and close. For the cardholder: under the cap, and any provisional credit becomes final. For the merchant: any
   * provisional credit is reversed by the partner. Who bears the fraud loss is read from the partner's terms now, or "not
   * known". A closed case returns as it is.
   */
  async decide(input: { disputeId: string; outcome: DisputeOutcome; actor: string }): Promise<DisputeCase> {
    const row = await this.row(this.sql, input.disputeId);
    if (row.state === 'closed') {
      if (row.outcome !== input.outcome) this.wrongState('decide again', row.state);
      return this.get(row.id);
    }
    if (input.outcome === 'cardholder') assertUnderDisputeCap(this.options.cap, row.asset_id, formatAmount(parseAmount(row.amount)));
    const loss = lossFromTerms(this.options.partnerTerms());
    let settlement: { kind: 'final' | 'reversed'; partnerRef: string } | null = null;
    if (row.credit_partner_ref) {
      const settle = this.options.issuer.settleProvisionalCredit;
      if (!settle) {
        throw new BankError(
          'The card partner takes no dispute decision through this programme (bank.card_dispute_partner_unset)',
          'bank.card_dispute_partner_unset',
        );
      }
      const kind = input.outcome === 'cardholder' ? 'final' : 'reversed';
      const answer = await settle({ requestId: `card-dispute-decision:${row.id}`, creditRequestId: creditKey(row.id), settlement: kind });
      settlement = { kind, partnerRef: answer.partnerRef };
    } else if (row.credit_requested_at) {
      // A credit asked and never answered: the outcome is not known, so the case cannot close on a guess.
      throw new BankError(
        'The partner has not answered the provisional credit asked on this case; grant it again to read its answer first (bank.card_dispute_state)',
        'bank.card_dispute_state',
      );
    }
    await transaction(this.sql, async (tx) => {
      const [locked] = await tx<Array<{ state: DisputeState }>>`SELECT state FROM bank.card_disputes WHERE id = ${row.id} FOR UPDATE`;
      if (!locked || locked.state === 'closed') return;
      await tx`
        UPDATE bank.card_disputes
           SET state = 'closed', outcome = ${input.outcome}, loss_status = ${loss.status}, loss_bearer = ${loss.bearer},
               loss_terms = ${loss.terms}, credit_settlement = ${settlement?.kind ?? null},
               credit_settlement_partner_ref = ${settlement?.partnerRef ?? null}, closed_at = ${this.clock()}, updated_at = now()
         WHERE id = ${row.id}
      `;
      const who = input.outcome === 'cardholder' ? 'Decided for the cardholder' : 'Decided for the merchant';
      const bears =
        loss.status === 'reported'
          ? `${loss.bearer} bears the fraud loss under the partner's terms: ${loss.terms}`
          : `who bears the fraud loss is ${NOT_KNOWN}`;
      const credited = settlement ? `; the partner's provisional credit is ${settlement.kind}, reference ${settlement.partnerRef}` : '';
      await this.event(
        tx,
        row.id,
        `card-dispute-decision:${row.id}`,
        'closed',
        locked.state,
        'closed',
        input.actor,
        `${who}; ${bears}${credited}`,
        false,
      );
    });
    return this.get(row.id);
  }

  private async row(sql: Sql, id: string, lock = false): Promise<DisputeRow & { id: string }> {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new BankError('No such card dispute (bank.card_dispute_not_found)', 'bank.card_dispute_not_found');
    const [r] = await sql<DisputeRow[]>`
      SELECT d.*, a.authorization_ref FROM bank.card_disputes d JOIN bank.card_authorizations a ON a.id = d.authorization_id
       WHERE d.id = ${id} ${lock ? sql`FOR UPDATE OF d` : sql``}
    `;
    if (!r) throw new BankError('No such card dispute (bank.card_dispute_not_found)', 'bank.card_dispute_not_found');
    return r;
  }

  /** One step under its key: a retried key that already ran returns without running again. */
  private async step(id: string, stepKey: string, fn: (tx: Sql, row: DisputeRow) => Promise<void>): Promise<void> {
    const k = key(stepKey);
    await transaction(this.sql, async (tx) => {
      const row = await this.row(tx, id, true);
      const [done] = await tx<Array<{ dispute_id: string }>>`SELECT dispute_id FROM bank.card_dispute_events WHERE event_key = ${k}`;
      if (done) {
        if (done.dispute_id !== row.id)
          throw new BankError('That step key was used on another case (bank.card_dispute_invalid)', 'bank.card_dispute_invalid');
        return;
      }
      await fn(tx, row);
    });
  }

  private async transition(tx: Sql, id: string, to: DisputeState): Promise<void> {
    await tx`UPDATE bank.card_disputes SET state = ${to}, updated_at = now() WHERE id = ${id}`;
  }

  private async event(
    tx: Sql,
    id: string,
    eventKey: string,
    kind: DisputeEventKind,
    from: DisputeState | null,
    to: DisputeState,
    actor: string,
    detail: string | null,
    afterSubmission: boolean,
  ): Promise<void> {
    await tx`
      INSERT INTO bank.card_dispute_events (dispute_id, sequence, kind, from_state, to_state, actor, detail, after_submission, event_key, at)
      VALUES (${id}, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM bank.card_dispute_events WHERE dispute_id = ${id}), ${kind},
              ${from}, ${to}, ${actor}, ${detail}, ${afterSubmission}, ${eventKey}, ${this.clock()})
    `;
  }

  private wrongState(what: string, state: DisputeState): never {
    throw new BankError(`A case that is ${state} cannot ${what} (bank.card_dispute_state)`, 'bank.card_dispute_state');
  }
}

const creditKey = (id: string): string => `card-dispute-credit:${id}`;
