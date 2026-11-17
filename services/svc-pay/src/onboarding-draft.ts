import type { Sql } from 'postgres';
import { z } from 'zod';

/**
 * THE BUSINESS STEP'S SAVED DRAFT (M-plat-org-13; J-merchant-02 #1).
 *
 * What a person typed on the onboarding business step, kept by svc-pay for that person before their account exists, so
 * leaving, signing out or another browser never drops it. One row per signed-in person, keyed by the session's user id
 * (never a body field). It is the person's own unsent text: it opens no account, holds no fee and moves no money, and the
 * row is removed once the account is opened. All-blank fields read as no draft.
 *
 * Each save carries the page's `seq`, rising with every change; a save whose `seq` is not above the stored one (a late or
 * repeated request) changes nothing, so the newest text always wins and a retry stores nothing twice.
 */

/** The step's text fields, with the same limits the form puts on them. A field left out is stored blank. */
export const onboardingDraftFieldsSchema = z
  .object({
    legalName: z.string().max(120).default(''),
    displayName: z.string().max(120).default(''),
    country: z.string().max(2).default(''),
    businessType: z.string().max(80).default(''),
    website: z.string().max(300).default(''),
    contactEmail: z.string().max(320).default(''),
    expectedVolume: z.string().max(200).default(''),
  })
  .strict();
export type OnboardingDraftFields = z.infer<typeof onboardingDraftFieldsSchema>;

export const onboardingDraftSaveInputSchema = z
  .object({ fields: onboardingDraftFieldsSchema, seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) })
  .strict();

export const onboardingDraftSchema = z.object({ fields: onboardingDraftFieldsSchema, updatedAt: z.string() }).nullable();
export type OnboardingDraft = z.infer<typeof onboardingDraftSchema>;

interface DraftRow {
  fields: unknown;
  updated_at: Date;
}

const view = (row: DraftRow | undefined): OnboardingDraft => {
  const parsed = onboardingDraftFieldsSchema.safeParse(row?.fields);
  // A stored row the current shape cannot read is no draft, never a half-filled form; nor is an all-blank one.
  if (!row || !parsed.success || Object.values(parsed.data).every((value) => value.trim() === '')) return null;
  return { fields: parsed.data, updatedAt: row.updated_at.toISOString() };
};

export class OnboardingDraftStore {
  constructor(private readonly sql: Sql) {}

  async get(userId: string): Promise<OnboardingDraft> {
    const [row] = await this.sql<DraftRow[]>`
      SELECT fields, updated_at FROM pay.merchant_onboarding_drafts WHERE user_id = ${userId}`;
    return view(row);
  }

  /** Stores these fields as the person's draft when `seq` is newer than the stored save; answers what is stored. */
  async save(userId: string, fields: OnboardingDraftFields, seq: number): Promise<OnboardingDraft> {
    const [row] = await this.sql<DraftRow[]>`
      INSERT INTO pay.merchant_onboarding_drafts (user_id, fields, client_seq, updated_at)
      VALUES (${userId}, ${this.sql.json(fields)}, ${seq}, now())
      ON CONFLICT (user_id) DO UPDATE SET fields = EXCLUDED.fields, client_seq = EXCLUDED.client_seq, updated_at = now()
        WHERE pay.merchant_onboarding_drafts.client_seq < EXCLUDED.client_seq
      RETURNING fields, updated_at`;
    return row ? view(row) : this.get(userId);
  }

  async clear(userId: string): Promise<void> {
    await this.sql`DELETE FROM pay.merchant_onboarding_drafts WHERE user_id = ${userId}`;
  }
}
