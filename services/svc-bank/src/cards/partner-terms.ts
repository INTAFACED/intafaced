import { isExplicitDevOrTest } from '@intafaced/config';
import { z } from 'zod';
import { BankError } from '../errors.js';

/**
 * THE CARD PARTNER'S UNKNOWNS (CUSTODY-DELTA §1.3 and §4, row "TEST partner card"), and they are the partner's.
 *
 * INTAFACED holds no customer money (OWNER 226): the card and its money sit with Phantom's partner, who is not named yet.
 * Four things only that partner can answer, so each is a fact the issuer adapter REPORTS, never one this service decides:
 *
 *   · `custodyMode`: does the partner hold the person's crypto to spend it (`partner_holds`), or does the card pull from the
 *     person's own wallet (`wallet_pull`)? J-bank-29 runs in both modes.
 *   · `spendFrom`: the assets the partner can spend from. Any other asset reads "not offered by the partner" (J-bank-29 #2).
 *   · `lossLiability`: who bears a lost chargeback or a card fraud loss, under the partner's terms (J-bank-15, J-bank-27 #4).
 *   · `reserve` and `funder`: any reserve or pre-funding the partner requires of the programme, and who funds the
 *     programme (J-bank-26 #6).
 *
 * `null` is "not known", and it stays "not known" on every surface. It is never read as the partner bearing the loss, never
 * as a reserve of zero and never as an empty asset list: an unknown is not an answer (CUSTODY-DELTA §1.3, "Unknown, never
 * zero").
 */
export const CARD_CUSTODY_MODES = ['partner_holds', 'wallet_pull'] as const;
export type CardCustodyMode = (typeof CARD_CUSTODY_MODES)[number];
export const LOSS_BEARERS = ['partner', 'programme', 'cardholder'] as const;
export type LossBearer = (typeof LOSS_BEARERS)[number];

export interface CardPartnerTerms {
  /** True on the TEST partner card adapter: every surface that shows these says TEST. */
  readonly test: boolean;
  readonly custodyMode: CardCustodyMode | null;
  readonly spendFrom: readonly string[] | null;
  readonly lossLiability: { readonly bearer: LossBearer; readonly terms: string } | null;
  readonly reserve: { readonly required: false } | { readonly required: true; readonly amount: string; readonly assetId: string } | null;
  readonly funder: string | null;
  /**
   * What the partner reports a cardholder can spend, per asset (J-bank-29 #2), as decimal strings in the partner's own
   * figures. `null` is "not known"; an asset the map leaves out is "not known" too, never 0. The TEST adapter reports the
   * same TEST figures for every cardholder.
   */
  readonly balances: Readonly<Record<string, string>> | null;
}

/** Nothing reported: what a partner that has answered none of the four looks like. */
export const NOTHING_REPORTED: CardPartnerTerms = {
  test: true,
  custodyMode: null,
  spendFrom: null,
  lossLiability: null,
  reserve: null,
  funder: null,
  balances: null,
};

const assetId = z.string().regex(/^[A-Z0-9]{2,16}$/);
const positiveDecimal = z
  .string()
  .regex(/^\d+(\.\d{1,18})?$/)
  .refine((v) => /[1-9]/.test(v), 'a required reserve has an amount above zero; a partner that requires none says required: false');

const simShape = z
  .object({
    custodyMode: z.enum(CARD_CUSTODY_MODES).nullable(),
    spendFrom: z.array(assetId).min(1).max(50).nullable(),
    lossLiability: z
      .object({ bearer: z.enum(LOSS_BEARERS), terms: z.string().trim().min(1).max(500) })
      .strict()
      .nullable(),
    reserve: z
      .union([
        z.object({ required: z.literal(false) }).strict(),
        z.object({ required: z.literal(true), amount: positiveDecimal, assetId }).strict(),
      ])
      .nullable(),
    funder: z.string().trim().min(1).max(200).nullable(),
    balances: z
      .record(assetId, z.string().regex(/^\d+(\.\d{1,18})?$/))
      .refine((m) => Object.keys(m).length <= 50, 'at most 50 assets')
      .nullable(),
  })
  .strict();

/**
 * THE TEST PARTNER CARD ADAPTER'S SWITCHES (`BANK_CARD_SIM_PARTNER_JSON`), on the local test stack only.
 *
 * Every one of the six keys must be present, as a value or as `null` (not known), so a missing key can never quietly
 * become a default. Unset is `NOTHING_REPORTED`. Set anywhere but `APP_ENV` dev or test, or under `NODE_ENV=production`,
 * it refuses to start: these are a stand-in partner's answers, and no deployment may carry them as a real partner's.
 * Malformed refuses to start too, naming the variable.
 */
export const BANK_CARD_SIM_PARTNER_ENV = 'BANK_CARD_SIM_PARTNER_JSON';

export function cardSimPartnerFor(
  raw: string | undefined | null,
  env: { APP_ENV?: string | undefined; NODE_ENV?: string | undefined },
): CardPartnerTerms {
  if (raw === undefined || raw === null || raw.trim() === '') return NOTHING_REPORTED;
  if (!isExplicitDevOrTest(env.APP_ENV) || env.NODE_ENV === 'production') {
    throw new Error(
      `${BANK_CARD_SIM_PARTNER_ENV} is the TEST partner card adapter's switches and refuses to start outside APP_ENV=dev or test, or under NODE_ENV=production`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${BANK_CARD_SIM_PARTNER_ENV} is not JSON`);
  }
  const checked = simShape.safeParse(parsed);
  if (!checked.success) {
    throw new Error(
      `${BANK_CARD_SIM_PARTNER_ENV} is not in shape: ${checked.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const d = checked.data;
  if (d.spendFrom && new Set(d.spendFrom).size !== d.spendFrom.length) {
    throw new Error(`${BANK_CARD_SIM_PARTNER_ENV} lists an asset twice in spendFrom`);
  }
  return { test: true, ...d };
}

/** The words every surface shows for an unknown. One constant so no surface can print a 0 or a guess instead. */
export const NOT_KNOWN = 'not known' as const;
export const NOT_OFFERED_BY_PARTNER = 'not offered by the partner' as const;

const BEARER_WORDS: Record<LossBearer, string> = {
  partner: 'the partner',
  programme: 'the programme (INTAFACED)',
  cardholder: 'the cardholder',
};
/** For an operator: whose crypto, said in the third person. The customer's own words live in the customer app's copy. */
const MODE_WORDS: Record<CardCustodyMode, string> = {
  partner_holds: 'The partner holds the cardholder’s crypto and spends it',
  wallet_pull: 'The card pulls from the cardholder’s own wallet',
};

/** The partner's terms as an operator reads them (J-bank-26 #6, J-bank-27 #4). Each unknown is "not known". */
export interface CardPartnerTermsView {
  readonly test: boolean;
  readonly custodyMode: string;
  readonly funder: string;
  readonly reserve: string;
  readonly lossLiability: string;
  readonly lossLiabilityStatus: 'reported' | 'not_known';
  readonly reserveStatus: 'reported' | 'not_known';
}

export function partnerTermsView(terms: CardPartnerTerms): CardPartnerTermsView {
  const r = terms.reserve;
  return {
    test: terms.test,
    custodyMode: terms.custodyMode ? MODE_WORDS[terms.custodyMode] : NOT_KNOWN,
    funder: terms.funder ?? NOT_KNOWN,
    reserve:
      r === null ? NOT_KNOWN : r.required ? `${r.amount} ${r.assetId}, as the partner reports` : 'None required, as the partner reports',
    reserveStatus: r === null ? 'not_known' : 'reported',
    lossLiability: terms.lossLiability
      ? `${BEARER_WORDS[terms.lossLiability.bearer]}, under the partner's terms: ${terms.lossLiability.terms}`
      : NOT_KNOWN,
    lossLiabilityStatus: terms.lossLiability ? 'reported' : 'not_known',
  };
}

/**
 * THE OWNER'S SPENDABLE-ASSET LIST (BK-ccrypto-01, J-bank-29 #1): `BANK_CARD_SPEND_ASSETS`, comma separated. NO DEFAULT.
 * Blank or malformed refuses `bank.card_spend_assets_unset`: Pay from lists nothing without it. (The pay-from order and
 * the authorisation that follows it, J-bank-29 #2 to #8, are not built yet; when they are, they read this same list.)
 */
export const BANK_CARD_SPEND_ASSETS_ENV = 'BANK_CARD_SPEND_ASSETS';

export function parseSpendAssets(raw: string | undefined | null): readonly string[] | null {
  if (raw === undefined || raw === null || raw.trim() === '') return null;
  const ids = raw.split(',').map((s) => s.trim());
  if (ids.some((id) => !assetId.safeParse(id).success) || new Set(ids).size !== ids.length) return null;
  return ids;
}

export function requireSpendAssets(list: readonly string[] | null): readonly string[] {
  if (!list) {
    throw new BankError(
      'The list of assets a card may pay from is not published: it is the owner’s to set (bank.card_spend_assets_unset).',
      'bank.card_spend_assets_unset',
    );
  }
  return list;
}

export type PayFromAssetState = 'offered' | 'not_offered' | 'not_known' | 'not_listed';
export interface PayFromAsset {
  readonly assetId: string;
  readonly state: PayFromAssetState;
}

/**
 * Pay from (J-bank-29 #2): every asset on the owner's list, then every other asset the person's cards draw on. Each
 * surface words the state itself (the customer app's copy): `not_offered` is "not offered by the partner" and `not_known`
 * is "not known".
 *
 * An asset is `offered` only when the owner lists it AND the partner reports it can spend from it. One the partner's list
 * leaves out is `not_offered`, whatever the owner listed: the partner's answer is the one that binds. Where the partner has
 * reported no list at all, an owner-listed asset is `not_known` (an unanswered list is not an empty one), and an asset the
 * owner never listed is `not_listed`, because the owner's answer is already final for it. One the partner offers that
 * the owner has not listed is `not_listed` too.
 */
export function payFromAssets(owner: readonly string[], terms: CardPartnerTerms, held: readonly string[]): PayFromAsset[] {
  const seen = new Set<string>();
  const out: PayFromAsset[] = [];
  for (const assetId of [...owner, ...held]) {
    if (seen.has(assetId)) continue;
    seen.add(assetId);
    const listed = owner.includes(assetId);
    let state: PayFromAssetState;
    if (terms.spendFrom === null) state = listed ? 'not_known' : 'not_listed';
    else if (!terms.spendFrom.includes(assetId)) state = 'not_offered';
    else state = listed ? 'offered' : 'not_listed';
    out.push({ assetId, state });
  }
  return out;
}

/** The two kinds of account a card never pays from (J-bank-29 #2 and its Money line), whatever the order says. */
export const NOT_USED_FOR_CARDS = ['trading', 'agent'] as const;

/** One row of Pay from, with the partner's balance and the rate (J-bank-29 #2). Each null is "not known". */
export interface PayFromRow extends PayFromAsset {
  /** The partner's reported spendable balance, only for an asset it can spend from. */
  readonly partnerBalance: string | null;
  /** One unit of the asset in the card's settlement asset, from the rate source, and the time the source stamped it. */
  readonly rate: string | null;
  readonly rateAsOf: string | null;
}

/**
 * A pay-from order to save (J-bank-29 #2): at least one asset, none twice, each one the partner can spend from and the owner
 * lists. Anything else refuses by name; nothing is saved.
 */
export function assertPayFromOrder(order: readonly string[], rows: readonly PayFromAsset[]): void {
  if (order.length === 0 || new Set(order).size !== order.length) {
    throw new BankError(
      'A pay-from order names each asset once, and at least one (bank.card_pay_from_order_invalid)',
      'bank.card_pay_from_order_invalid',
    );
  }
  for (const assetId of order) {
    const row = rows.find((r) => r.assetId === assetId);
    if (!row || row.state !== 'offered') {
      throw new BankError(
        `${assetId} is not an asset the card partner can spend from for this card programme (bank.card_pay_from_not_offered)`,
        'bank.card_pay_from_not_offered',
      );
    }
  }
}
