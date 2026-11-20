/**
 * Who someone is on INTAFACED, as svc-identity answers it: the caller's own handle (`identity.me`), an exact @handle
 * lookup (`identity.users.resolveHandle`), the payee card (`identity.users.payeeCard`) and signed pay codes
 * (`identity.qr.mine`, `identity.qr.resolve`). Browser-safe (zod only).
 */
import { z } from 'zod';

/** `identity.me`, as a screen reads it. */
export const meSchema = z.object({
  userId: z.string().guid(),
  handle: z.string().min(1),
  /** Absent on a server that does not yet report confirmation. */
  emailVerified: z.boolean().optional(),
});

/** `identity.users.resolveHandle`, as a screen reads it. */
export const resolveHandleSchema = z.discriminatedUnion('found', [
  z.object({ found: z.literal(false) }),
  z.object({ found: z.literal(true), userId: z.string().guid(), handle: z.string().min(1), self: z.boolean() }),
]);

/** `identity.users.payeeCard`: the service's own output. The name is null when the person has none; the month is `YYYY-MM`. */
export const payeeCardSchema = z.discriminatedUnion('found', [
  z.object({ found: z.literal(false) }),
  z.object({ found: z.literal(true), name: z.string().nullable(), memberSince: z.string().regex(/^\d{4}-\d{2}$/) }),
]);

/** `identity.qr.mine`: the caller's signed pay code. */
export const payQrSchema = z.object({ payload: z.string().min(1) });
/** `identity.qr.resolve`: who a scanned code pays. */
export const payQrPreviewSchema = z.object({ userId: z.string().guid(), handle: z.string().min(1), self: z.boolean() });
