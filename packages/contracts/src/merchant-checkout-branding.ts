import { z } from 'zod';
import { PRODUCT_IMAGE_TYPES } from './merchant-catalog.js';

/**
 * The look of a business's hosted checkout (M-payments-core-08, J-merchant-04 step 1): `merchantCheckout.branding.*`
 * on svc-pay.
 *
 * A business that never saved a look has the default one (`status: 'default'`): the hosted page's own colours and no
 * logo. A save stores a brand colour and an optional logo, which every payment link of the business then shows on its
 * hosted page. The logo is checked against the owner's published size (`logoMaxBytes`); while no size is published a
 * logo refuses `pay.checkout_logo_rules_unset` and a colour can still be saved. Every team role reads the look; the
 * owner and admins change it, from an interactive session. Nothing here moves money.
 */
export const CHECKOUT_LOGO_TYPES = PRODUCT_IMAGE_TYPES;
export const checkoutLogoTypeSchema = z.enum(CHECKOUT_LOGO_TYPES);

/** The colour the hosted page uses for its button and links when the business saved none (its light theme's accent). */
export const CHECKOUT_DEFAULT_BRAND_COLOR = '#1a5fd0';

/**
 * The button text that reads on a brand colour (`#rrggbb`): #101820 on a light colour, white on a dark one, by WCAG
 * relative luminance. 0.198 is where both have the same contrast. The hosted page and the portal's preview both use it.
 */
export function checkoutButtonTextColor(color: string): '#101820' | '#ffffff' {
  const channel = (at: number) => {
    const v = parseInt(color.slice(at, at + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5) > 0.198 ? '#101820' : '#ffffff';
}

/** A colour as six hex digits after `#`, kept in lower case. */
export const checkoutBrandColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'a colour like #1a5fd0')
  .transform((value) => value.toLowerCase());

/**
 * The largest logo rule a request can carry. The hosted page shows the logo inline (it loads nothing from elsewhere),
 * so every page view carries it; 200 000 bytes keeps a page small and well under one request's 1 MiB.
 */
export const CHECKOUT_LOGO_MAX_BYTES_CEILING = 200_000;

export const checkoutLogoRulesSchema = z
  .object({
    /** Null: no size is published and every logo refuses. */
    logoMaxBytes: z.number().int().positive().max(CHECKOUT_LOGO_MAX_BYTES_CEILING).nullable(),
    logoTypes: z.array(checkoutLogoTypeSchema),
  })
  .strict();
export type CheckoutLogoRules = z.infer<typeof checkoutLogoRulesSchema>;

export const checkoutLogoSchema = z
  .object({
    contentType: checkoutLogoTypeSchema,
    byteSize: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    dataBase64: z.string().min(1),
  })
  .strict();
export type CheckoutLogo = z.infer<typeof checkoutLogoSchema>;

export const checkoutBrandingLookSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('default') }).strict(),
  z
    .object({
      status: z.literal('saved'),
      brandColor: z.string().regex(/^#[0-9a-f]{6}$/),
      logo: checkoutLogoSchema.nullable(),
      version: z.number().int().positive(),
      updatedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
]);
export type CheckoutBrandingLook = z.infer<typeof checkoutBrandingLookSchema>;

export const checkoutBrandingSchema = z
  .object({
    rules: checkoutLogoRulesSchema,
    look: checkoutBrandingLookSchema,
  })
  .strict();
export type CheckoutBranding = z.infer<typeof checkoutBrandingSchema>;

export const checkoutBrandingGetInputSchema = z.object({}).strict();

export const checkoutBrandingSaveInputSchema = z
  .object({
    requestId: z.string().guid(),
    /** The version this save was made from: 0 when the look is the default. An older one refuses `pay.checkout_branding_stale`. */
    expectedVersion: z.number().int().min(0),
    brandColor: checkoutBrandColorSchema,
    /**
     * A new logo (base64, at most the ceiling as 266 668 characters), null to take the logo off, or left out to keep the
     * one saved.
     */
    logo: z
      .object({
        contentType: z.string().trim().min(1).max(100),
        dataBase64: z.string().min(1).max(266_668),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
export type CheckoutBrandingSaveInput = z.infer<typeof checkoutBrandingSaveInputSchema>;

export const checkoutBrandingSavedSchema = z
  .object({
    branding: checkoutBrandingSchema,
    replayed: z.boolean(),
  })
  .strict();
