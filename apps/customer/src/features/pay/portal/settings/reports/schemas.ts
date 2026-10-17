import { z } from 'zod';
import { stamp } from '../b-shared';

// mirrors services/svc-pay/src/merchant-ops/exports.ts on main (#4826): seven kinds, columns, generatedAt, expired.
export const exportKinds = ['payments', 'settlements', 'payouts', 'refunds', 'ledger_statement', 'disputes', 'fees'] as const;
export type ExportKind = (typeof exportKinds)[number];
export const exportStatuses = ['queued', 'running', 'ready', 'failed', 'expired'] as const;
export type ExportStatus = (typeof exportStatuses)[number];

export const exportJobSchema = z.object({
  jobId: z.string(),
  // An unknown kind from a newer service is kept as text rather than failing the whole list.
  kind: z.string(),
  filters: z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    status: z.string().optional(),
    assetId: z.string().optional(),
  }),
  columns: z.array(z.string()).optional(),
  status: z.enum(exportStatuses),
  failureCode: z.string().nullish(),
  fileName: z.string().nullish(),
  sizeBytes: z.string().nullish(),
  rowCount: z.number().int().nullish(),
  sha256: z.string().nullish(),
  requestedBy: z.string(),
  asOf: stamp.nullish(),
  generatedAt: stamp.nullish(),
  expiresAt: stamp.nullish(),
  createdAt: stamp,
  completedAt: stamp.nullish(),
});
export type ExportJob = z.infer<typeof exportJobSchema>;

export const exportDownloadSchema = z.object({
  fileName: z.string(),
  contentType: z.string(),
  content: z.string(),
  sha256: z.string(),
  rowCount: z.number().int(),
});

export const memberLabelSchema = z.object({ userId: z.string(), label: z.string().nullish(), role: z.string().optional() });
