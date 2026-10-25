/**
 * THE PAYER-NAME CHECK ON A BANK TRANSFER (RC-merchant-09, J-merchant-04 step 6).
 *
 * A payer paying by bank transfer gives the name on their bank account; the bank reports the name on the account the
 * money came from. The owner sets the rule the two are compared under (`PAY_PAYER_NAME_MATCH_RULE`). Pure: no reads, no
 * writes. A crash anywhere around it re-runs it on the same inputs and gets the same answer.
 */

/** The owner's choices. `exact_normalised`: the same letters and digits, in the same order, after case, accents,
 * punctuation and spacing are set aside. Nothing fuzzier is offered: a looser rule is the owner's to add. */
export const PAYER_NAME_MATCH_RULES = ['exact_normalised'] as const;
export type PayerNameMatchRule = (typeof PAYER_NAME_MATCH_RULES)[number];

/** Why a bank transfer is held instead of captured. */
export type PayerNameHoldReason = 'pay.payer_name_mismatch' | 'pay.payer_name_missing' | 'pay.name_match_rule_unset';

export type PayerNameVerdict = { readonly outcome: 'match' } | { readonly outcome: 'hold'; readonly reason: PayerNameHoldReason };

/** The longest name a payer may give, as a bank's remitter field holds it. */
export const PAYER_NAME_MAX = 140;

export const PAYER_NAME_RULE_ENV = 'PAY_PAYER_NAME_MATCH_RULE';

/**
 * The owner's rule, read at boot. Blank is no rule: every bank transfer is then held, never matched by a guessed rule.
 * Anything else that is not a rule this build has refuses boot rather than being read as blank.
 */
export function readPayerNameMatchRule(env: Record<string, string | undefined>): PayerNameMatchRule | null {
  const raw = env[PAYER_NAME_RULE_ENV]?.trim() ?? '';
  if (!raw) return null;
  if ((PAYER_NAME_MATCH_RULES as readonly string[]).includes(raw)) return raw as PayerNameMatchRule;
  throw new Error(
    `${PAYER_NAME_RULE_ENV} "${raw}" is not a rule this build has. Set one of: ${PAYER_NAME_MATCH_RULES.join(', ')}, or leave it blank.`,
  );
}

/** A name with case, accents, punctuation and spacing set aside: `Adá  Lovelace-King` and `ADA LOVELACE KING` read alike. */
export function normalisePayerName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** A name a payer gave, trimmed; null when it is blank or longer than a bank holds. */
export function givenPayerName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // A control character is never part of a name (and Postgres text cannot hold NUL): refused, not cleaned up.
  if (/\p{Cc}/u.test(raw.replace(/[\t\n\r]/g, ' '))) return null;
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name || name.length > PAYER_NAME_MAX || !normalisePayerName(name)) return null;
  return name;
}

/**
 * Compare the name the payer gave with the one the bank reported, under the owner's rule. With no rule, or with a name
 * missing on either side (the bank reported none, or the payment was made somewhere no name was asked for), there is
 * nothing to compare and the transfer is held.
 */
export function checkPayerName(rule: PayerNameMatchRule | null, given: string | null, received: string | undefined): PayerNameVerdict {
  if (rule === null) return { outcome: 'hold', reason: 'pay.name_match_rule_unset' };
  const reported = received === undefined ? '' : normalisePayerName(received);
  const expected = given === null ? '' : normalisePayerName(given);
  if (!reported || !expected) return { outcome: 'hold', reason: 'pay.payer_name_missing' };
  return expected === reported ? { outcome: 'match' } : { outcome: 'hold', reason: 'pay.payer_name_mismatch' };
}

/**
 * Every transfer counted towards a payment, checked under the owner's rule: all must match the given name. One that
 * does not holds the whole payment (a mismatch is named before a missing name). Nothing counted yet is nothing to hold.
 */
export function checkPayerNames(
  rule: PayerNameMatchRule | null,
  given: string | null,
  received: readonly (string | null)[],
): PayerNameVerdict {
  if (received.length === 0) return { outcome: 'match' };
  const holds = received
    .map((name) => checkPayerName(rule, given, name ?? undefined))
    .filter((v): v is Extract<PayerNameVerdict, { outcome: 'hold' }> => v.outcome === 'hold');
  if (holds.length === 0) return { outcome: 'match' };
  return holds.find((v) => v.reason === 'pay.payer_name_mismatch') ?? holds[0]!;
}
