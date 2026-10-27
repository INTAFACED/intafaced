import { z } from 'zod';

/** The scheme's job bodies (`/internal/jobs/dd-sim/*`). Ids are the scheme's references, never generated here. */
// No ':' in a scheme id: a collection's ledger key joins two of them with ':', so one may never read as the other.
const schemeId = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);

export const ddSimMandateBody = z
  .object({
    mandateId: schemeId,
    userId: z.string().uuid(),
    creditorId: schemeId,
    reference: z.string().trim().min(1).max(140),
    assetId: z.string().regex(/^[A-Z0-9]{2,16}$/),
  })
  .strict();

export const ddSimCollectionBody = z
  .object({
    mandateId: schemeId,
    collectionId: schemeId,
    amount: z.string().regex(/^\d+(\.\d{1,18})?$/),
    dueAt: z.string().datetime({ offset: true }),
  })
  .strict();

/** The collection run's batch is the caller's to name: an omitted one refuses, never a borrowed default. */
export const ddRunBody = z.object({ limit: z.number().int().min(1).max(1000) }).strict();
