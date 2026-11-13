import { z } from 'zod';
import { academyCertIdSchema } from './academy-certificates.js';

/**
 * AC-certificates-03: the design a published certificate prints, and the issued-certificates list with its counts and a
 * stored export.
 *
 * A design is saved as numbered revisions (`certdesign:<cert>:<revision>`): staff send the revision they read, so a retry
 * answers the revision it made and a stale form refuses `academy.cert_design_stale`. Activation is an explicit move and
 * refuses a revision with no signatory (`academy.cert_signatory_missing`) or with a blank disclaimer
 * (`academy.cert_disclaimer_unset`; the wording is the owner's, never filled in here). Saving an active design keeps it
 * active under the new revision, which certificates issued from then on print; a certificate already issued keeps the
 * revision it was issued under, so the save answers how many issued certificates keep an earlier revision. A certificate
 * carries no value and no money moves.
 */
const isoInstant = z.string().datetime({ offset: true });

export const ACADEMY_CERT_DESIGN_SIZES = ['a4', 'letter'] as const;
export type AcademyCertDesignSize = (typeof ACADEMY_CERT_DESIGN_SIZES)[number];

export const academyCertSignatorySchema = z
  .object({ name: z.string().trim().min(1).max(120), role: z.string().trim().min(1).max(120) })
  .strict();
export type AcademyCertSignatory = z.infer<typeof academyCertSignatorySchema>;

/** What one revision prints. The disclaimer may be saved blank (a draft) but a blank one never activates. */
export const academyCertDesignContentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(2000),
  signatories: z.array(academyCertSignatorySchema).max(4),
  disclaimer: z.string().trim().max(2000).nullable(),
  language: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/),
  size: z.enum(ACADEMY_CERT_DESIGN_SIZES),
  /** Hours of effort as a decimal string (`12.5`), or none. */
  effortHours: z
    .string()
    .regex(/^\d{1,4}(\.\d{1,2})?$/)
    .nullable(),
});
export type AcademyCertDesignContent = z.infer<typeof academyCertDesignContentSchema>;

export const academyCertDesignRevisionSchema = academyCertDesignContentSchema.extend({
  revision: z.number().int().positive(),
  savedBy: z.string().guid(),
  savedAt: isoInstant,
  reason: z.string(),
});
export type AcademyCertDesignRevision = z.infer<typeof academyCertDesignRevisionSchema>;

/** `admin.certDesign`: one certificate's design, or `design: null` while none is drafted. */
export const academyCertDesignSchema = z.object({
  certId: academyCertIdSchema,
  /** The published certificate's own name, which the design's title may differ from. */
  title: z.string(),
  design: z
    .object({
      /** The newest revision, the one the form edits. */
      current: academyCertDesignRevisionSchema,
      /** The revision certificates are issued under now, or null while the design is a draft. */
      activeRevision: z.number().int().positive().nullable(),
      activatedAt: isoInstant.nullable(),
      activatedBy: z.string().guid().nullable(),
    })
    .nullable(),
  /** Issued certificates by the design revision they print (null: issued before any design was active). */
  issuedByRevision: z.array(z.object({ revision: z.number().int().positive().nullable(), count: z.number().int().min(0) })),
});
export type AcademyCertDesign = z.infer<typeof academyCertDesignSchema>;

/** `admin.certDesigns`: every published certificate with its design. */
export const academyCertDesignsSchema = z.object({ items: z.array(academyCertDesignSchema) });
export type AcademyCertDesigns = z.infer<typeof academyCertDesignsSchema>;

export const academyCertDesignInputSchema = z.object({ certId: academyCertIdSchema }).strict();

/** `admin.saveCertDesign`: `revision` is the one the form read (0 for a first save). */
export const academySaveCertDesignInputSchema = academyCertDesignContentSchema
  .extend({
    certId: academyCertIdSchema,
    revision: z.number().int().min(0),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type AcademySaveCertDesignInput = z.infer<typeof academySaveCertDesignInputSchema>;

/** The saved design, and when it is active, how many issued certificates keep printing an earlier revision. */
export const academySaveCertDesignResultSchema = z.object({
  design: academyCertDesignSchema,
  warning: z.object({ issuedKeepingEarlier: z.number().int().positive(), activeRevision: z.number().int().positive() }).nullable(),
});
export type AcademySaveCertDesignResult = z.infer<typeof academySaveCertDesignResultSchema>;

/** `admin.activateCertDesign`: make the revision staff read the one certificates are issued under. */
export const academyActivateCertDesignInputSchema = z
  .object({ certId: academyCertIdSchema, revision: z.number().int().positive(), reason: z.string().trim().min(1).max(500) })
  .strict();
export type AcademyActivateCertDesignInput = z.infer<typeof academyActivateCertDesignInputSchema>;

/** `admin.deactivateCertDesign`: take the design out of use; issued certificates keep their revision. */
export const academyDeactivateCertDesignInputSchema = z
  .object({ certId: academyCertIdSchema, reason: z.string().trim().min(1).max(500) })
  .strict();

/** What an issued certificate prints: its design revision, or null when it was issued before any design was active. */
export const academyIssuedCertDesignSchema = academyCertDesignContentSchema.extend({ revision: z.number().int().positive() });
export type AcademyIssuedCertDesign = z.infer<typeof academyIssuedCertDesignSchema>;

/** One issued certificate on the staff list. */
export const academyIssuedCertSchema = z.object({
  publicId: z.string().regex(/^[0-9a-f]{32}$/),
  accountId: z.string().guid(),
  certId: z.string(),
  status: z.enum(['valid', 'revoked']),
  grantedAt: isoInstant,
  designRevision: z.number().int().positive().nullable(),
});
export type AcademyIssuedCert = z.infer<typeof academyIssuedCertSchema>;

/** Counts of every issued certificate, by certificate and status: the whole list, never only the page shown. */
export const academyIssuedCertCountSchema = z.object({
  certId: z.string(),
  valid: z.number().int().min(0),
  revoked: z.number().int().min(0),
});

/** `admin.issuedCerts`: newest first, optionally for one certificate. `limit` is capped by the owner's list size. */
export const academyIssuedCertsInputSchema = z
  .object({ certificate: academyCertIdSchema.nullish(), limit: z.number().int().positive().nullish() })
  .strict();
export const academyIssuedCertsSchema = z.object({
  counts: z.array(academyIssuedCertCountSchema),
  total: z.number().int().min(0),
  items: z.array(academyIssuedCertSchema),
});
export type AcademyIssuedCerts = z.infer<typeof academyIssuedCertsSchema>;

/** A stored export of the issued list: one CSV row per issued certificate, the time it was made and its SHA-256. */
export const academyCertExportSchema = z.object({
  n: z.number().int().positive(),
  madeAt: isoInstant,
  madeBy: z.string().guid(),
  rows: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type AcademyCertExport = z.infer<typeof academyCertExportSchema>;
export const academyCertExportsSchema = z.object({ exports: z.array(academyCertExportSchema) });
export type AcademyCertExports = z.infer<typeof academyCertExportsSchema>;

/** `admin.makeCertExport`: `n` is the number the desk read as next (`certexport:<n>`). */
export const academyMakeCertExportInputSchema = z.object({ n: z.number().int().positive() }).strict();
export const academyCertExportFileSchema = academyCertExportSchema.extend({ csv: z.string() });
export type AcademyCertExportFile = z.infer<typeof academyCertExportFileSchema>;
