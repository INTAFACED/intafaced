/**
 * A key's call log (DV-keys-06, J-developer-08): the edge tells identity about each call it answered for an API key.
 *
 * The report is sent just before the reply leaves (`onSend`), when the status is final, and carries what was called
 * (method, path without its query), the status, the edge's request id and the key's SHA-256, never the key, a body or a
 * header value. The caller's address goes with it only so identity can say whether it was outside the key's IP list;
 * identity does not keep it. A report that fails is logged and the call is answered as it would have been: the log is
 * a record of calls, never a gate on them.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { API_CALL_ERROR_CODE, type ApiKeyCallRecordInput } from '@intafaced/contracts/api-keys';
import { identityCallHeaders, type EdgeS2s } from './s2s.js';
import { looksLikeApiKey } from './principal-exchange.js';

/** How long a report may hold the reply. Identity is local to the edge; a slower answer is dropped and logged. */
export const KEY_CALL_REPORT_TIMEOUT_MS = 1_000;

/** The presented `ifc_…` key's hash, or null when the request carried no API key. */
export function presentedKeyHash(authorization: string | string[] | undefined): string | null {
  const raw = Array.isArray(authorization) ? authorization[0] : authorization;
  const match = raw ? /^Bearer\s+(.+)$/i.exec(raw.trim()) : null;
  const token = match?.[1];
  if (!token || !looksLikeApiKey(token)) return null;
  return createHash('sha256').update(token).digest('hex');
}

/** Longest error reply the edge reads a code from; a longer body is not parsed and its call logs no code. */
export const ERROR_CODE_BODY_MAX = 64 * 1024;

const JsonObject = z.record(z.string(), z.unknown());

function objectAt(value: unknown): Record<string, unknown> | undefined {
  const parsed = JsonObject.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function codeAt(value: unknown): string | null {
  return typeof value === 'string' && API_CALL_ERROR_CODE.test(value) ? value : null;
}

/**
 * The typed error code of an error reply (status 400 or above), as a developer's client reads it: the body's
 * `intafacedCode` (a REST error's own code beside its error class, `PermissionDenied`), else its `code` (every edge
 * error), else a tRPC error's named code (`error.data.cause.code`, `error.data.intafacedCode`,
 * `error.data.appCode`, `error.code`), and only last tRPC's status word (`error.data.code`, `FORBIDDEN`). Null on a
 * success, a body that is not a JSON object, or one with no code. Only the code leaves this function.
 */
export function replyErrorCode(status: number, payload: unknown): string | null {
  if (status < 400) return null;
  const text = typeof payload === 'string' ? payload : Buffer.isBuffer(payload) ? payload.toString('utf8') : null;
  if (text === null || text.length > ERROR_CODE_BODY_MAX) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const record = objectAt(body);
  if (record === undefined) return null;
  const error = objectAt(record.error);
  const data = objectAt(error?.data);
  return (
    codeAt(record.intafacedCode) ??
    codeAt(record.code) ??
    codeAt(objectAt(data?.cause)?.code) ??
    codeAt(data?.intafacedCode) ??
    codeAt(data?.appCode) ??
    codeAt(error?.code) ??
    codeAt(data?.code)
  );
}

export function keyCallReport(input: {
  readonly keyHash: string;
  readonly requestId: string;
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly errorCode?: string | null;
  readonly clientIp: string | null;
  readonly at: Date;
}): ApiKeyCallRecordInput {
  return {
    keyHash: input.keyHash,
    requestId: input.requestId.slice(0, 128),
    method: input.method.toUpperCase().slice(0, 16),
    path: (input.url.split('?')[0] || '/').slice(0, 512),
    status: input.status,
    errorCode: input.errorCode ?? null,
    clientIp: input.clientIp ? input.clientIp.slice(0, 64) : null,
    at: input.at.toISOString(),
  };
}

/** Sends one report. Resolves true when identity took it; never throws. */
export async function reportKeyCall(options: {
  readonly identityUrl: string;
  readonly identityOwnershipSecret: string;
  readonly s2s?: EdgeS2s | undefined;
  readonly fetch?: typeof globalThis.fetch;
  readonly report: ApiKeyCallRecordInput;
}): Promise<boolean> {
  const target = `${options.identityUrl.replace(/\/+$/, '')}/trpc/developerKeys.recordCall`;
  const body = JSON.stringify(options.report);
  try {
    const response = await (options.fetch ?? globalThis.fetch)(target, {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        ...identityCallHeaders(options.identityOwnershipSecret, options.s2s, {
          method: 'POST',
          target,
          body,
          contentType: 'application/json',
        }),
      },
      signal: AbortSignal.timeout(KEY_CALL_REPORT_TIMEOUT_MS),
    });
    await response.arrayBuffer().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}
