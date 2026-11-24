/**
 * The getting-started checklist's reads: only the fields it reads, each open to extra fields, so a field a service
 * adds never makes a done step look undone. The full screens (Verification, Security, Price alerts, History) hold the
 * strict answers. Browser-safe (zod only).
 */
import { z } from 'zod';

/** svc-identity `webauthn.list`: one row per passkey. */
export const startedPasskeysSchema = z.array(z.object({ credentialId: z.string() }).passthrough());
/** svc-notify `notify.alerts`: each alert's kind and status. */
export const startedAlertsSchema = z
  .object({ items: z.array(z.object({ kind: z.string(), status: z.string() }).passthrough()) })
  .passthrough();
/** svc-bank `activity.list`: one page of the history, read for whether it holds a line. */
export const startedHistorySchema = z
  .object({ items: z.array(z.object({ id: z.string() }).passthrough()), nextCursor: z.string().nullable().optional() })
  .passthrough();
