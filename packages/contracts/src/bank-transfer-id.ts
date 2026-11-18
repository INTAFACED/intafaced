import { z } from 'zod';

/**
 * svc-bank's own transfer id, as the person's transfer record shows it. Its own module, with nothing but zod, because the
 * customer app reads it through `support-safety.ts`: the signed bank door in `bank-scam-transfer.ts` carries Node-only
 * signing code, and a browser bundle that imports it fails at load (`Buffer is not defined`, every public room down).
 */
export const bankTransferIdSchema = z
  .string()
  .trim()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9._:-]+$/);
