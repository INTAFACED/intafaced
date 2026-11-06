import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BankError } from '../errors.js';

/**
 * THE OWNER'S CARD PROGRAMME TERMS (BK-cissue-01 to -03), and they are the owner's.
 *
 * `BANK_CARD_PROGRAMME_JSON`: the card network's name, the countries whose residents may get a card, how many active
 * virtual and physical cards one person may hold, the cardholder terms (version and text), the card designs, the delivery
 * speeds with the days each is expected to take, and the countries a physical card is delivered to. Every one is an owner,
 * lawyer or issuer value: NO DEFAULT. Blank, unreadable or not in shape refuses `bank.card_eligibility_unset` and the card
 * room says the programme is not published, never that everyone is eligible. On a test stack the bank profile publishes a
 * labelled TEST set (`tooling/profiles/test-owner-values/bank.json`).
 *
 * `cards.order` (the card room) refuses without them. The older direct `cards.issue` door keeps its behaviour, with the
 * count limit added when the terms are published.
 */
export const BANK_CARD_PROGRAMME_ENV = 'BANK_CARD_PROGRAMME_JSON';

export const DELIVERY_SPEEDS = ['standard', 'express', 'signed'] as const;
export type DeliverySpeed = (typeof DELIVERY_SPEEDS)[number];

const country = z
  .string()
  .regex(/^[A-Za-z]{2}$/)
  .transform((value) => value.toUpperCase());
const cap = z.number().int().min(0).max(1000);

const shape = z
  .object({
    network: z.string().trim().min(1).max(80),
    countries: z.array(country).min(1).max(250),
    limits: z.object({ virtual: cap, physical: cap }).strict(),
    terms: z.object({ version: z.string().trim().min(1).max(64), text: z.string().trim().min(1).max(20_000) }).strict(),
    designs: z
      .array(
        z
          .object({
            id: z
              .string()
              .regex(/^[a-z0-9-]{1,32}$/)
              .min(1),
            name: z.string().trim().min(1).max(80),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    speeds: z
      .array(z.object({ speed: z.enum(DELIVERY_SPEEDS), days: z.number().int().min(1).max(90) }).strict())
      .min(1)
      .max(DELIVERY_SPEEDS.length),
    deliveryCountries: z.array(country).min(1).max(250),
  })
  .strict();

export type CardProgrammeTerms = z.infer<typeof shape>;

/** The published terms, or null for blank, unreadable or out of shape (each refuses where it is read). */
export function parseCardProgramme(raw: string | undefined | null): CardProgrammeTerms | null {
  if (raw === undefined || raw === null || raw.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const checked = shape.safeParse(parsed);
  if (!checked.success) return null;
  const designs = new Set(checked.data.designs.map((d) => d.id));
  const speeds = new Set(checked.data.speeds.map((s) => s.speed));
  if (designs.size !== checked.data.designs.length || speeds.size !== checked.data.speeds.length) return null;
  return checked.data;
}

export function requireProgramme(terms: CardProgrammeTerms | null): CardProgrammeTerms {
  if (!terms) {
    throw new BankError(
      'The card programme is not published: which countries may get a card, the card limits and the cardholder terms are the owner’s to set.',
      'bank.card_eligibility_unset',
    );
  }
  return terms;
}

/** sha256 of the exact terms text the person is shown, prefixed so the algorithm travels with it. */
export function termsTextHash(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * THE OWNER'S CASHBACK RATES BY RANK CARD TIER (RC-bank-02), paid in one asset (the platform token, IFC).
 *
 * `BANK_CARD_CASHBACK_RATES_JSON`: `{ "assetId": "IFC", "rates": { "<tier>": <bps> } }` over the rank perks' card tiers.
 * NO DEFAULT. Blank or out of shape refuses `bank.cashback_rate_unset`; a tier with no rate refuses the same for that tier.
 * A rate applies to spend on a card funded in that asset, so the reward is a share of what left the person's balance in
 * the same asset: nothing is converted and no price is consulted.
 */
export const BANK_CARD_CASHBACK_RATES_ENV = 'BANK_CARD_CASHBACK_RATES_JSON';
export const CARD_TIERS = ['none', 'standard', 'metal', 'obsidian'] as const;
export type CardTier = (typeof CARD_TIERS)[number];

const ratesShape = z
  .object({
    assetId: z.string().regex(/^[A-Z0-9]{2,16}$/),
    rates: z.partialRecord(z.enum(CARD_TIERS), z.number().int().min(0).max(10_000)),
  })
  .strict();
export type CashbackRates = { readonly assetId: string; readonly rates: Partial<Record<CardTier, number>> };

export function parseCashbackRates(raw: string | undefined | null): CashbackRates | null {
  if (raw === undefined || raw === null || raw.trim() === '') return null;
  try {
    const checked = ratesShape.safeParse(JSON.parse(raw));
    if (!checked.success || Object.keys(checked.data.rates).length === 0) return null;
    return checked.data;
  } catch {
    return null;
  }
}

/**
 * THE SIMULATOR'S CASHBACK STAND-IN, AND IT IS A TEST FIXTURE (J-bank-13 #7).
 *
 * A simulated card pays no cashback (`bank.rewards_issuer_unset`): a reward for a purchase no issuer saw would be platform
 * money paid for nothing. `BANK_CARD_SIM_CASHBACK=test` lets the local test stack's card simulator pay it anyway, from the
 * same reward pot, through the same `rewardPay`, so the journey can show cashback on card spend. Like the payout stand-in,
 * it is refused at boot in any process whose raw `APP_ENV` is not exactly `dev` or `test`, or with `NODE_ENV=production`.
 * Unset (the default) is `off`.
 */
export const CARD_SIM_CASHBACK_SETTINGS = ['off', 'test'] as const;
export type CardSimCashbackSetting = (typeof CARD_SIM_CASHBACK_SETTINGS)[number];

export function cardSimCashbackFor(
  setting: CardSimCashbackSetting,
  env: { APP_ENV?: string | undefined; NODE_ENV?: string | undefined },
): boolean {
  if (setting === 'off') return false;
  const devOrTest = env.APP_ENV === 'dev' || env.APP_ENV === 'test';
  if (!devOrTest || env.NODE_ENV === 'production') {
    throw new Error(
      'BANK_CARD_SIM_CASHBACK=test is the local test stack’s stand-in and refuses to start outside APP_ENV=dev or test, or under NODE_ENV=production',
    );
  }
  return true;
}
