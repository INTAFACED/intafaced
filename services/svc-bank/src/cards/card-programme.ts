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
