import { z } from 'zod';
import { defineProcedure } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `streamCredential.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/**
 * A credential for the audio/video stream, for a caller already seated.
 *
 * Fails with `academy.stream_unavailable` when no SFU is configured, rather
 * than returning a token that cannot connect (SOCKET §13
 * `socket.stream-provider`). A lobby with no stream still runs.
 */
export const ACADEMY_STREAM_CREDENTIAL = defineProcedure({
  ...base,
  name: 'academy.streamCredential',
  kind: 'mutation',
  path: 'streamCredential',
  access: { caller: 'scope', scope: 'academy:write', module: 'academy' },
  refusals: { 'academy.session_not_found': 'NOT_FOUND', 'academy.session_not_live': 'CONFLICT' },
  input: z.object({ sessionId: z.string().guid() }),
  output: z.object({ url: z.string(), token: z.string(), expiresAt: z.iso.datetime({ offset: true }) }),
  samples: [
    { verdict: 'accept', input: { sessionId: '33333333-3333-4333-8333-333333333333' } },
    { verdict: 'refuse', input: 42 },
  ],
});
