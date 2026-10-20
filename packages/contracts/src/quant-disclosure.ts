/**
 * Quant risk disclosure contract (AL-risk-02): the current versioned disclosure, an account's acceptance of it for one
 * strategy version, and the operator publish and counts views.
 *
 * Browser safe: nothing here imports Node. The wording is owner and lawyer content supplied through the operator
 * publish call; nothing in this repository writes it. Blank means unpublished: the read answers `published: false`
 * and the deploy and publish doors refuse with `quant.disclosure_unset`.
 *
 * Rules carried by the shapes below:
 * - An acceptance is for one strategy version and one disclosure version. A new strategy version or a new disclosure
 *   version needs a new acceptance.
 * - The write key is a business key, `quant.disclose:<strategyId>:v<version>:<disclosureVersion>`, so a lost reply is
 *   read back or replayed under the same key and never creates a second row.
 * - An acceptance row holds ids, versions and a time only. The counts view carries no personal text.
 */
import { z } from 'zod';

export const QUANT_DISCLOSURE_ERROR_CODES = [
  'quant.disclosure_unset',
  'quant.disclosure_version_stale',
  'quant.disclosure_not_accepted',
  'quant.studio_not_found',
] as const;
export type QuantDisclosureErrorCode = (typeof QUANT_DISCLOSURE_ERROR_CODES)[number];

/** Wording is owner content; this bound only keeps one row from carrying a document. */
export const QUANT_DISCLOSURE_TEXT_MAX = 20_000;
export const QUANT_DISCLOSURE_REASON_MAX = 500;

const positiveInt = z.number().int().min(1).max(2_147_483_647);
const strategyId = z.string().trim().min(1).max(128);
const idempotencyKey = z.string().trim().min(1).max(128);

/** The disclosure the owner published last. `null` wording is not representable: unpublished is `published: false`. */
export const quantDisclosureCurrentSchema = z.discriminatedUnion('published', [
  z.object({ published: z.literal(false) }),
  z.object({
    published: z.literal(true),
    version: positiveInt,
    text: z.string().min(1).max(QUANT_DISCLOSURE_TEXT_MAX),
    publishedAt: z.string().datetime(),
  }),
]);
export type QuantDisclosureCurrent = z.infer<typeof quantDisclosureCurrentSchema>;

/** The key an acceptance is written under. The caller never invents one. */
export function quantDisclosureAcceptKey(strategy: string, strategyVersion: number, disclosureVersion: number): string {
  return `quant.disclose:${strategy}:v${strategyVersion}:${disclosureVersion}`;
}

export const quantDisclosureStatusInputSchema = z.object({
  strategyId,
  strategyVersion: positiveInt,
});
export type QuantDisclosureStatusInput = z.infer<typeof quantDisclosureStatusInputSchema>;

export const quantDisclosureStatusOutputSchema = z.object({
  strategyId,
  strategyVersion: positiveInt,
  disclosure: quantDisclosureCurrentSchema,
  /** True only when this account accepted this exact strategy version against the current disclosure version. */
  accepted: z.boolean(),
  acceptedAt: z.string().datetime().nullable(),
});
export type QuantDisclosureStatusOutput = z.infer<typeof quantDisclosureStatusOutputSchema>;

export const quantDisclosureAcceptInputSchema = z.object({
  strategyId,
  strategyVersion: positiveInt,
  disclosureVersion: positiveInt,
});
export type QuantDisclosureAcceptInput = z.infer<typeof quantDisclosureAcceptInputSchema>;

export const quantDisclosureAcceptOutputSchema = z.object({
  strategyId,
  strategyVersion: positiveInt,
  disclosureVersion: positiveInt,
  acceptedAt: z.string().datetime(),
  key: z.string().min(1).max(256),
});
export type QuantDisclosureAcceptOutput = z.infer<typeof quantDisclosureAcceptOutputSchema>;

export const quantDisclosurePublishInputSchema = z.object({
  text: z.string().trim().min(1).max(QUANT_DISCLOSURE_TEXT_MAX),
  reason: z.string().trim().min(1).max(QUANT_DISCLOSURE_REASON_MAX),
  idempotencyKey,
});
export type QuantDisclosurePublishInput = z.infer<typeof quantDisclosurePublishInputSchema>;

export const quantDisclosurePublishOutputSchema = z.object({
  version: positiveInt,
  publishedAt: z.string().datetime(),
});
export type QuantDisclosurePublishOutput = z.infer<typeof quantDisclosurePublishOutputSchema>;

/** Compliance view: versions and how many acceptances each has. No account, strategy or text. */
export const quantDisclosureCountsOutputSchema = z.object({
  versions: z.array(
    z.object({
      version: positiveInt,
      publishedAt: z.string().datetime(),
      acceptances: z.number().int().min(0),
    }),
  ),
  asOf: z.string().datetime(),
});
export type QuantDisclosureCountsOutput = z.infer<typeof quantDisclosureCountsOutputSchema>;
