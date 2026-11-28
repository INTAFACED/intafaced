/**
 * An account's call line: one log line for each reply the edge sent to a signed-in person's call, so the
 * beta's own logs can show where one tester is stuck (tooling/beta/beta-testers.mjs reads them).
 *
 * The line names the account by its id only, never an email, a name, a token, a body or a header value: the account
 * id, whether it came through an API key, the method, the path without its query (a query can carry an address), the
 * status and the typed error code an error reply names (`replyErrorCode`). A refusal from the trading venue
 * (`/api/v1/venue/*`, status 400 or above) also carries the refusal's own words, the body's `message`, cut to
 * VENUE_REFUSAL_TEXT_MAX: they are what a tester read, and the one thing that says why the venue said no. The line is a
 * record, never a gate: it is written after the reply's status is final and changes nothing in the reply.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { replyErrorCode, ERROR_CODE_BODY_MAX } from './key-call-log.js';

/** The message the line is logged under; the beta's reader matches it exactly. */
export const ACCOUNT_CALL_MSG = 'edge.account_call';
/** Longest venue refusal text a line carries. */
export const VENUE_REFUSAL_TEXT_MAX = 300;
const VENUE_PATH = /^\/api\/v1\/venue(\/|$)/;

export interface AccountCallLine {
  readonly accountId: string;
  readonly viaKey: boolean;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly code: string | null;
  readonly refusal?: string;
}

const MessageBody = z.object({ message: z.string() });

function payloadText(payload: unknown): string | null {
  if (typeof payload === 'string') return payload;
  if (Buffer.isBuffer(payload)) return payload.toString('utf8');
  return null;
}

/** The venue's refusal words in an error reply's body (`venueRefusalReply`'s `message`), or null. */
export function venueRefusalText(path: string, status: number, payload: unknown): string | null {
  if (status < 400 || !VENUE_PATH.test(path)) return null;
  const text = payloadText(payload);
  if (text === null || text.length > ERROR_CODE_BODY_MAX) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = MessageBody.safeParse(body);
  if (!parsed.success) return null;
  const words = parsed.data.message.replace(/\s+/g, ' ').trim();
  return words === '' ? null : words.slice(0, VENUE_REFUSAL_TEXT_MAX);
}

/** The line for one reply, or null when the call was not a signed-in person's. */
export function accountCallLine(input: {
  readonly principal: { readonly userId?: string | null; readonly kid?: string | null } | null | undefined;
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly payload: unknown;
}): AccountCallLine | null {
  const accountId = input.principal?.userId;
  if (!accountId) return null;
  const path = (input.url.split('?')[0] || '/').slice(0, 512);
  const refusal = venueRefusalText(path, input.status, input.payload);
  return {
    accountId: accountId.slice(0, 64),
    viaKey: Boolean(input.principal?.kid),
    method: input.method.toUpperCase().slice(0, 16),
    path,
    status: input.status,
    code: replyErrorCode(input.status, input.payload),
    ...(refusal === null ? {} : { refusal }),
  };
}

type Caller = { readonly userId?: string | null; readonly kid?: string | null };
const callerOf = new WeakMap<FastifyRequest, Caller>();

/** Marks the request as answered for this signed-in person; the hook logs its line once the reply's status is final. */
export function rememberCaller(req: FastifyRequest, principal: Caller | null | undefined): void {
  if (principal) callerOf.set(req, principal);
}

/** Logs each remembered person's reply under ACCOUNT_CALL_MSG, just before it leaves; the reply is unchanged. */
export function registerAccountCallLog(app: FastifyInstance): void {
  app.addHook('onSend', async (req, reply, payload) => {
    const line = accountCallLine({ principal: callerOf.get(req), method: req.method, url: req.url, status: reply.statusCode, payload });
    if (line) req.log.info(line, ACCOUNT_CALL_MSG);
    return payload;
  });
}
