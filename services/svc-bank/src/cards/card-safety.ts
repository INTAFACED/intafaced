import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import type { CardIssuerAdapter } from './issuer.js';

/**
 * 3D SECURE CHALLENGES AND CARD FRAUD REPORTS (J-bank-14 #5, #7; BK-cpay-01).
 *
 * A 3D Secure challenge is the card partner asking the cardholder to confirm an online purchase before it is authorised.
 * The partner's access control server holds the code and sends it to the cardholder; this module never stores it. It
 * keeps one row per challenge with how many wrong codes were typed. The owner's count (`BANK_CARD_3DS_TRY_LIMIT`) of
 * wrong codes locks the challenge, and no authorisation is made. The right code approves it, and the purchase's
 * authorisation is driven once, under the business key `3ds:<challenge ref>`: a second answer, a retry after a crash
 * between the approval and the authorisation, or two answers at once all reach the same authorisation (`authorize` is
 * idempotent on its reference, and the row is locked while it is answered). An approved challenge whose authorisation
 * was never written (a crash, or `authorize` refusing) is finished by `answer` with no code. The authorisation's own
 * decision is shown with the challenge: an approved code is not a purchase that went through. Money moves only inside
 * `authorize`, on whichever book holds this person's card money (OWNER 226); nothing here posts.
 *
 * A fraud report is the cardholder saying they did not make one approved card payment. Filing it freezes the card, as
 * the person's own lock, and opens one case for that payment: the payment is the business key, so filing again returns
 * the same case. Nothing here moves money: what the partner does with the payment is a dispute, which support works
 * (`card-disputes.ts`).
 */

export type ThreeDSState = 'open' | 'approved' | 'locked';

export interface ThreeDSChallengeView {
  readonly id: string;
  readonly cardId: string;
  readonly challengeRef: string;
  /** The purchase's amount in the card's settlement asset, a decimal string. */
  readonly amount: string;
  readonly merchant: string | null;
  readonly merchantCountry: string | null;
  readonly state: ThreeDSState;
  /** Wrong codes left before the challenge locks; 0 once it is decided; null while the owner has not set the count. */
  readonly triesLeft: number | null;
  /** The authorisation this challenge completed, once approved. */
  readonly authorizationId: string | null;
  /** That authorisation's decision: an approved code can still meet a declined purchase (a limit, a block, the balance). */
  readonly decision: 'approved' | 'declined' | null;
  readonly declineCode: string | null;
  readonly createdAt: string;
  /**
   * The TEST partner's code for this challenge, while it is open, so the TEST stack can be answered: a real partner sends
   * its code to the cardholder itself, and this is always null for one. Every screen that shows it says TEST.
   */
  readonly testCode: string | null;
}

export interface FraudReportView {
  readonly id: string;
  readonly cardId: string;
  readonly authorizationId: string;
  readonly state: 'open';
  readonly createdAt: string;
}

interface ChallengeRow {
  id: string;
  card_id: string;
  user_id: string;
  challenge_ref: string;
  amount: string;
  merchant: string | null;
  merchant_country: string | null;
  merchant_category: string | null;
  state: ThreeDSState;
  wrong_codes: number;
  authorization_id: string | null;
  created_at: Date;
}

const CHALLENGE_COLUMNS =
  'id, card_id, user_id, challenge_ref, amount, merchant, merchant_country, merchant_category, state, wrong_codes, authorization_id, created_at';

/** The business key of the authorisation a challenge completes. */
export function threeDSAuthorizationRef(challengeRef: string): string {
  return `3ds:${challengeRef}`;
}

function sameCode(typed: string, expected: string): boolean {
  const a = Buffer.from(typed);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const notFound = () => new BankError('No such 3D Secure challenge on this card', 'bank.card_3ds_not_found');

export interface CardSafetyDeps {
  readonly sql: Sql;
  readonly issuer: CardIssuerAdapter;
  /** The owner's count of wrong codes that lock a challenge, or null (not set). */
  readonly tryLimit: number | null;
  /** The card, read as this person's (`bank.card_not_found` otherwise). */
  readonly ownedCard: (cardId: string, userId: string) => Promise<{ id: string; userId: string; issuerRef: string; status: string }>;
  readonly card: (cardId: string) => Promise<{ id: string; userId: string; issuerRef: string; status: string }>;
  /** Whether the card can authorise now (active, activated, uses left). */
  readonly usable: (card: { id: string; status: string }) => Promise<boolean>;
  /** `CardService.authorize`, idempotent on its reference. */
  readonly authorize: (input: {
    cardId: string;
    authorizationRef: string;
    amount: Amount;
    merchant?: string;
    merchantCountry?: string;
    merchantCategory?: string;
    channel: 'online';
  }) => Promise<{ id: string }>;
  readonly authorization: (
    authorizationId: string,
  ) => Promise<{ cardId: string; decision: 'approved' | 'declined'; declineCode: string | null } | null>;
  /** `CardService.setStatus(cardId, 'frozen', userId)`: the person's own lock. */
  readonly freeze: (cardId: string, userId: string) => Promise<void>;
}

export class CardSafety {
  constructor(private readonly deps: CardSafetyDeps) {}

  private codeSource(): NonNullable<CardIssuerAdapter['threeDSCode']> {
    const source = this.deps.issuer.threeDSCode;
    if (!source) throw new BankError('No card partner can send a 3D Secure code for this card', 'bank.card_3ds_issuer_unset');
    return source.bind(this.deps.issuer);
  }

  private async view(row: ChallengeRow, issuerRef: string): Promise<ThreeDSChallengeView> {
    const limit = this.deps.tryLimit;
    const testCode =
      row.state === 'open' && this.deps.issuer.testSecrets && this.deps.issuer.threeDSCode
        ? (await this.deps.issuer.threeDSCode({ cardId: row.card_id, issuerRef, challengeId: row.id })).code
        : null;
    const authorization = row.authorization_id ? await this.deps.authorization(row.authorization_id) : null;
    return {
      id: row.id,
      cardId: row.card_id,
      challengeRef: row.challenge_ref,
      amount: row.amount,
      merchant: row.merchant,
      merchantCountry: row.merchant_country,
      state: row.state,
      triesLeft: row.state !== 'open' ? 0 : limit === null ? null : Math.max(limit - row.wrong_codes, 0),
      authorizationId: row.authorization_id,
      decision: authorization?.decision ?? null,
      declineCode: authorization?.declineCode ?? null,
      createdAt: new Date(row.created_at).toISOString(),
      testCode,
    };
  }

  private async row(sql: Sql, challengeId: string, cardId: string, lock = false): Promise<ChallengeRow | undefined> {
    const rows = await sql.unsafe<ChallengeRow[]>(
      `SELECT ${CHALLENGE_COLUMNS} FROM bank.card_3ds_challenges WHERE id = $1 AND card_id = $2${lock ? ' FOR UPDATE' : ''}`,
      [challengeId, cardId],
    );
    return rows[0];
  }

  /**
   * THE ISSUER'S SIDE: the partner asks the cardholder to confirm an online purchase. One challenge per card and
   * reference; the same reference again returns it, and with different terms, or a challenge id already used for another
   * purchase, refuses `bank.card_3ds_conflict`. A card that cannot authorise now is not asked (`bank.card_not_active`).
   */
  async open(input: {
    challengeId: string;
    cardId: string;
    challengeRef: string;
    amount: Amount;
    merchant?: string;
    merchantCountry?: string;
    merchantCategory?: string;
  }): Promise<ThreeDSChallengeView> {
    this.codeSource();
    const card = await this.deps.card(input.cardId);
    const amount = formatAmount(input.amount);
    const merchant = input.merchant ?? null;
    const country = input.merchantCountry?.toUpperCase() ?? null;
    const category = input.merchantCategory ?? null;
    const conflict = () => new BankError('This challenge was already opened for a different purchase', 'bank.card_3ds_conflict');
    const existing = await this.deps.sql.unsafe<ChallengeRow[]>(
      `SELECT ${CHALLENGE_COLUMNS} FROM bank.card_3ds_challenges WHERE card_id = $1 AND challenge_ref = $2`,
      [card.id, input.challengeRef],
    );
    if (!existing[0] && !(await this.deps.usable(card))) throw new BankError('This card is not active', 'bank.card_not_active');
    await this.deps.sql`
      INSERT INTO bank.card_3ds_challenges (id, card_id, user_id, challenge_ref, amount, merchant, merchant_country, merchant_category)
      VALUES (${input.challengeId}, ${card.id}, ${card.userId}, ${input.challengeRef}, ${amount}, ${merchant}, ${country}, ${category})
      ON CONFLICT DO NOTHING
    `;
    const rows = await this.deps.sql.unsafe<ChallengeRow[]>(
      `SELECT ${CHALLENGE_COLUMNS} FROM bank.card_3ds_challenges WHERE card_id = $1 AND challenge_ref = $2`,
      [card.id, input.challengeRef],
    );
    const row = rows[0];
    // No row under this reference: the challenge id was already taken by another purchase.
    if (!row) throw conflict();
    if (row.amount !== amount || row.merchant !== merchant || row.merchant_country !== country || row.merchant_category !== category) {
      throw conflict();
    }
    return this.view(row, card.issuerRef);
  }

  /** The person's challenges on one card, newest first. */
  async list(input: { cardId: string; userId: string; limit?: number }): Promise<ThreeDSChallengeView[]> {
    const card = await this.deps.ownedCard(input.cardId, input.userId);
    const rows = await this.deps.sql.unsafe<ChallengeRow[]>(
      `SELECT ${CHALLENGE_COLUMNS} FROM bank.card_3ds_challenges WHERE card_id = $1 ORDER BY created_at DESC, id LIMIT $2`,
      [card.id, Math.min(Math.max(input.limit ?? 20, 1), 100)],
    );
    return Promise.all(rows.map((r) => this.view(r, card.issuerRef)));
  }

  /**
   * The person answers a challenge. A wrong code counts once and, at the owner's count, locks it; a decided challenge
   * checks no more codes. The right code approves it and completes the purchase's authorisation once. With no code, an
   * approved challenge whose authorisation was never written is finished; an open one refuses `bank.card_3ds_code_missing`.
   */
  async answer(input: { cardId: string; userId: string; challengeId: string; code?: string }): Promise<ThreeDSChallengeView> {
    const card = await this.deps.ownedCard(input.cardId, input.userId);
    const seen = await this.row(this.deps.sql, input.challengeId, card.id);
    if (!seen) throw notFound();

    let decided = seen;
    if (seen.state === 'open') {
      const limit = this.deps.tryLimit;
      if (limit === null) {
        throw new BankError(
          'The owner has not set how many wrong 3D Secure codes lock a challenge (BANK_CARD_3DS_TRY_LIMIT)',
          'bank.card_3ds_try_limit_unset',
        );
      }
      if (input.code === undefined) throw new BankError('Enter the code the card partner sent you', 'bank.card_3ds_code_missing');
      const typed = input.code;
      const { code: expected } = await this.codeSource()({ cardId: card.id, issuerRef: card.issuerRef, challengeId: seen.id });
      decided = await transaction(this.deps.sql, async (tx) => {
        const row = await this.row(tx, seen.id, card.id, true);
        if (!row) throw notFound();
        if (row.state !== 'open') return row;
        if (sameCode(typed, expected)) {
          const [approved] = await tx.unsafe<ChallengeRow[]>(
            `UPDATE bank.card_3ds_challenges SET state = 'approved', decided_at = now() WHERE id = $1 RETURNING ${CHALLENGE_COLUMNS}`,
            [row.id],
          );
          return approved!;
        }
        const wrong = row.wrong_codes + 1;
        const [counted] = await tx.unsafe<ChallengeRow[]>(
          `UPDATE bank.card_3ds_challenges
              SET wrong_codes = $2, state = $3, decided_at = CASE WHEN $3 = 'locked' THEN now() ELSE decided_at END
            WHERE id = $1 RETURNING ${CHALLENGE_COLUMNS}`,
          [row.id, wrong, wrong >= limit ? 'locked' : 'open'],
        );
        return counted!;
      });
    }

    if (decided.state !== 'approved' || decided.authorization_id !== null) return this.view(decided, card.issuerRef);

    // Approved and not yet authorised: drive the purchase's authorisation, once, under the challenge's business key. If
    // it throws, the challenge stays approved with no authorisation, and the next answer (with no code) finishes it.
    const authorization = await this.deps.authorize({
      cardId: card.id,
      authorizationRef: threeDSAuthorizationRef(decided.challenge_ref),
      amount: parseAmount(decided.amount),
      channel: 'online',
      ...(decided.merchant === null ? {} : { merchant: decided.merchant }),
      ...(decided.merchant_country === null ? {} : { merchantCountry: decided.merchant_country }),
      ...(decided.merchant_category === null ? {} : { merchantCategory: decided.merchant_category }),
    });
    const [done] = await this.deps.sql.unsafe<ChallengeRow[]>(
      `UPDATE bank.card_3ds_challenges SET authorization_id = COALESCE(authorization_id, $2) WHERE id = $1 RETURNING ${CHALLENGE_COLUMNS}`,
      [decided.id, authorization.id],
    );
    return this.view(done!, card.issuerRef);
  }

  /**
   * The person reports an approved card payment they did not make: the card is frozen as their own lock and one case
   * opens for that payment. Reporting the same payment again returns the same case (and freezes again if it was unfrozen).
   * A declined payment moved nothing and is not reported (`bank.card_authorization_declined`).
   */
  async reportFraud(input: { cardId: string; userId: string; authorizationId: string }): Promise<FraudReportView> {
    const card = await this.deps.ownedCard(input.cardId, input.userId);
    const payment = await this.deps.authorization(input.authorizationId);
    if (payment?.cardId !== card.id) throw new BankError('No such card payment on this card', 'bank.card_authorization_not_found');
    if (payment.decision !== 'approved') {
      throw new BankError('A declined payment moved nothing, so there is no fraud to report on it', 'bank.card_authorization_declined');
    }
    await this.deps.sql`
      INSERT INTO bank.card_fraud_reports (id, card_id, user_id, authorization_id)
      VALUES (${randomUUID()}, ${card.id}, ${input.userId}, ${input.authorizationId})
      ON CONFLICT (authorization_id) DO NOTHING
    `;
    if (card.status === 'active') await this.deps.freeze(card.id, input.userId);
    const [row] = await this.deps.sql<Array<{ id: string; card_id: string; authorization_id: string; created_at: Date }>>`
      SELECT id, card_id, authorization_id, created_at FROM bank.card_fraud_reports WHERE authorization_id = ${input.authorizationId}
    `;
    return {
      id: row!.id,
      cardId: row!.card_id,
      authorizationId: row!.authorization_id,
      state: 'open',
      createdAt: new Date(row!.created_at).toISOString(),
    };
  }

  /** The person's fraud reports on one card, newest first. */
  async fraudReports(input: { cardId: string; userId: string }): Promise<FraudReportView[]> {
    const card = await this.deps.ownedCard(input.cardId, input.userId);
    const rows = await this.deps.sql<Array<{ id: string; card_id: string; authorization_id: string; created_at: Date }>>`
      SELECT id, card_id, authorization_id, created_at FROM bank.card_fraud_reports WHERE card_id = ${card.id}
       ORDER BY created_at DESC, id LIMIT 50
    `;
    return rows.map((r) => ({
      id: r.id,
      cardId: r.card_id,
      authorizationId: r.authorization_id,
      state: 'open' as const,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }
}
