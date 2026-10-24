import { z } from 'zod';

/**
 * AC-certificates-02: how a published certificate is issued. `manual` is the learner claiming it once every required
 * item is recorded (what Academy did before any rule was set, and what a certificate with no rule still does);
 * `automatic` issues it the moment the last required item is recorded; `delayed` issues it once the owner's delay has
 * passed after that. The delay is an owner value with no default: `delayed` without one refuses `academy.cert_delay_unset`.
 * A certificate never moves money: issuing one publishes an XP event for the rank ladder and nothing else.
 */
export const ACADEMY_CERT_ISSUE_MODES = ['manual', 'automatic', 'delayed'] as const;
export type AcademyCertIssueMode = (typeof ACADEMY_CERT_ISSUE_MODES)[number];
/** The longest delay staff may set: one year, in minutes. */
export const ACADEMY_CERT_DELAY_MAX_MINUTES = 525_600;

export const academyCertIdSchema = z.string().min(1).max(64);

/** `admin.setCertIssueRule`: the issue rule for one certificate, with the reason staff give. A delay belongs to `delayed` only. */
export const academySetCertIssueRuleInputSchema = z
  .object({
    certId: academyCertIdSchema,
    mode: z.enum(ACADEMY_CERT_ISSUE_MODES),
    delayMinutes: z.number().int().min(1).max(ACADEMY_CERT_DELAY_MAX_MINUTES).nullable(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict()
  .refine((rule) => rule.mode === 'delayed' || rule.delayMinutes === null, {
    message: 'only a delayed rule has a delay',
    path: ['delayMinutes'],
  });
export type AcademySetCertIssueRuleInput = z.infer<typeof academySetCertIssueRuleInputSchema>;

/** One certificate's stored issue rule. Each change is a new revision with its own history row. */
export const academyCertIssueRuleSchema = z.object({
  certId: academyCertIdSchema,
  mode: z.enum(ACADEMY_CERT_ISSUE_MODES),
  delayMinutes: z.number().int().positive().nullable(),
  revision: z.number().int().positive(),
  updatedAt: z.coerce.date(),
});
export type AcademyCertIssueRule = z.infer<typeof academyCertIssueRuleSchema>;

/**
 * How the caller's certificate is issued, beside its progress: the rule (null when staff have set none, so the learner
 * claims it) and, while a delayed certificate waits, the time it is issued.
 */
export const academyCertIssueSchema = z.object({
  mode: z.enum(ACADEMY_CERT_ISSUE_MODES),
  delayMinutes: z.number().int().positive().nullable(),
  issuesAt: z.coerce.date().nullable(),
});
export type AcademyCertIssue = z.infer<typeof academyCertIssueSchema>;

/**
 * `admin.revokeCert`: staff revoke one issued certificate by its public verification code, with a reason, under
 * two-person approval (action `academy.cert.revoke`, payload `{publicId, reason}`). The public check then says revoked.
 */
export const academyRevokeCertInputSchema = z
  .object({
    publicId: z.string().regex(/^[0-9a-f]{32}$/),
    reason: z.string().trim().min(1).max(500),
    approvalId: z.string().max(128).nullish(),
    operationId: z.string().max(128).nullish(),
  })
  .strict();
export type AcademyRevokeCertInput = z.infer<typeof academyRevokeCertInputSchema>;

/** One revocation as Academy recorded it: which certificate, who proposed, approved and carried it out, why and when. */
export const academyCertRevocationSchema = z.object({
  publicId: z.string(),
  certId: z.string(),
  proposedBy: z.string(),
  approvedBy: z.string(),
  revokedBy: z.string(),
  reason: z.string(),
  revokedAt: z.coerce.date(),
});
export type AcademyCertRevocation = z.infer<typeof academyCertRevocationSchema>;
