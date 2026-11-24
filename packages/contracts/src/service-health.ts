import { z } from 'zod';

/**
 * A service's public liveness answer on `GET /health`: `{ ok: true, service }`, as svc-market and svc-token send it. It says
 * only that the process answers; it is never evidence of any record, balance or configuration.
 */
export const serviceHealthSchema = z.object({ ok: z.literal(true), service: z.string().min(1) });
export type ServiceHealth = z.infer<typeof serviceHealthSchema>;
