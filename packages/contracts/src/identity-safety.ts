import { z } from 'zod';

/**
 * svc-identity `account.safety.*` (BK-safe-01, J-bank-18 #4): the person's own step-up extras and location signal.
 *
 * - Step-up extras: opt-in controls a send to another person must pass above an allowance the person sets. The owner
 *   publishes the least number of controls (`IDENTITY_EXTRA_CONTROLS_MIN`); while it is blank, setting extras refuses
 *   `identity.extra_controls_unset`. Fewer controls than that refuse `identity.extra_controls_too_few`. Known locations
 *   need the location consent on (`identity.location_consent_required`). Every change and the removal take the person's
 *   password (`auth.invalid_credentials`). svc-bank reads the extras on `GET /internal/extra-controls/:userId` and, above
 *   the allowance, a send waits while a control cannot be checked: it never passes (`bank.extra_controls_pending`). No
 *   control has a check yet (a trusted contact, a QR code or a video call needs an outside rail; a known location is
 *   compared with the kept sign-in regions only once that check is built), so today every send above it waits.
 * - Location signal: an optional consent, recorded with its time each time it changes. Only while it is on does a new
 *   sign-in keep the region the edge resolved for it; turning it off deletes the kept regions. Nothing else is stored.
 *
 * An API key or sub-account is refused (`auth.mfa_required`); the person signs in themselves.
 */
export const EXTRA_CONTROLS = ['known_locations', 'trusted_contacts', 'secret_qr', 'video_fallback'] as const;
export type ExtraControl = (typeof EXTRA_CONTROLS)[number];

/** The assets an allowance may be written in. */
export const EXTRA_CONTROLS_ASSETS = ['USDT', 'USDC'] as const;

/** A positive decimal string, at most 18 digits before and 8 after the point. */
const allowanceAmount = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d{0,17})(?:\.\d{1,8})?$/, 'a decimal amount')
  .refine((v) => /[1-9]/.test(v), 'more than zero');

export const extraControlsAllowanceSchema = z.object({ amount: allowanceAmount, assetId: z.enum(EXTRA_CONTROLS_ASSETS) }).strict();

export const extraControlsSchema = z.object({
  /** The owner's least number of controls, or null while it is not published. */
  minimum: z.number().int().positive().nullable(),
  controls: z.array(z.enum(EXTRA_CONTROLS)),
  /** Null while the person has no extras set. */
  allowance: extraControlsAllowanceSchema.nullable(),
  updatedAt: z.string().nullable(),
});

export const locationSignalSchema = z.object({ region: z.string(), at: z.string() });

export const locationConsentSchema = z.object({
  consent: z.boolean(),
  /** When the consent last changed, or null while it was never given. */
  changedAt: z.string().nullable(),
  /** The newest sign-in regions kept under the consent, newest first; empty while it is off. */
  signals: z.array(locationSignalSchema),
});

export const safetyReadOutputSchema = z.object({ extraControls: extraControlsSchema, location: locationConsentSchema });
export type SafetyRead = z.infer<typeof safetyReadOutputSchema>;

export const setExtraControlsInputSchema = z
  .object({
    controls: z.array(z.enum(EXTRA_CONTROLS)).max(EXTRA_CONTROLS.length),
    allowance: extraControlsAllowanceSchema,
    password: z.string().min(1).max(200),
  })
  .strict();

export const clearExtraControlsInputSchema = z.object({ password: z.string().min(1).max(200) }).strict();

export const setLocationConsentInputSchema = z.object({ consent: z.boolean() }).strict();

export const safetyChangeOutputSchema = safetyReadOutputSchema.extend({ changed: z.boolean() });

/** `GET /internal/extra-controls/:userId` (service credentials): what svc-bank needs to hold a send. */
export const extraControlsForSchema = z
  .object({
    userId: z.string().uuid(),
    controls: z.array(z.enum(EXTRA_CONTROLS)),
    allowance: extraControlsAllowanceSchema.nullable(),
  })
  .strict();
export type ExtraControlsFor = z.infer<typeof extraControlsForSchema>;
