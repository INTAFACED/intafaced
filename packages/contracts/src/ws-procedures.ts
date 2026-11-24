import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';

/**
 * svc-ws's one call another service makes: svc-edge's read of the SBE L2 tape's consumers for the founder console
 * (J-cex-spot-20 #3). svc-ws serves the door from this record (`sbe-consumers.ts`) and svc-edge calls it through it
 * (`adapter-status-door.ts`). svc-ws's other doors are reached by browsers over plain HTTP and sockets, not by a call.
 *
 * Its refusals are the door's own `{ ok: false, error: { code, message } }` bodies, by status.
 */

const text = z.string().min(1);

export const sbeConsumerSchema = z.object({
  /** This process's own counter (`sbe-<n>`): it names no customer and no address. */
  id: text,
  marketId: text,
  connectedAt: text,
  framesSent: z.number().int().min(0),
  /** The tape sequence of the last frame sent; null until one is. */
  lastSequence: text.nullable(),
});

export const WS_SBE_CONSUMERS = defineProcedure({
  name: 'ws.sbe.consumers',
  service: 'svc-ws',
  transport: 'http',
  method: 'GET',
  path: '/internal/sbe/consumers',
  access: { caller: 'service', callers: ['svc-edge'] },
  refusals: {
    ws_status_unconfigured: 'SERVICE_UNAVAILABLE',
    unauthenticated: 'UNAUTHORIZED',
    forbidden: 'FORBIDDEN',
  },
  input: NO_INPUT,
  output: z.object({
    service: z.literal('svc-ws'),
    codecLinked: z.boolean(),
    consumers: z.array(sbeConsumerSchema),
    asOf: text,
  }),
  samples: [{ verdict: 'accept' }],
});
