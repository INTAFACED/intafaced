/**
 * Operator door from the console onto svc-matching controls.
 *
 * Matching stays out of the catch-all proxy. Each procedure below is one
 * named path. Writes are signed as `svc-edge` with `MATCHING_EDGE_SIGNING_SECRET`.
 * The audit row names the human requester and the human approver from the
 * identity approval. A typed-in second name is not that approval.
 *
 * Matching consumes the approval on its own halt routes. This door does not
 * consume first: a second consume would burn the approval and leave the
 * market unhalted. It refuses, before any upstream call, when the approval
 * is missing, already consumed, the same person, or for a different action.
 *
 * Surveillance cases are `GET /surveillance/cases` on svc-matching. svc-trade
 * does not mount that path. Adjudicate and fine are not registered here.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthError, bearerToken, requireScope, verifyAccessToken, type Principal, type TokenConfig } from '@intafaced/auth';
import { actionApprovalSchema, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { sendOperatorAuthFailure } from './admin-api.js';
import { MATCHING_OPERATOR_EDGE_PATHS } from './routes.js';

export const MATCHING_SERVICE_NAME = 'svc-edge' as const;

export type MatchingControlResult =
  | { readonly kind: 'answered'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'unknown'; readonly error: string }
  | { readonly kind: 'unavailable'; readonly error: string };

export interface MatchingControlRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
}

export type MatchingControlCall = (req: MatchingControlRequest) => Promise<MatchingControlResult>;

export interface MatchingApprovalRow {
  readonly status: string;
  readonly actionType: string;
  readonly targetService: string;
  readonly targetId: string;
  readonly requesterId: string;
  readonly approverId: string | null;
  readonly operationId: string;
}

export type MatchingApprovalRead = (approvalId: string, bearer: string) => Promise<MatchingApprovalRow>;

export class MatchingApprovalUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MatchingApprovalUnavailable';
  }
}

export interface MatchingDoorBlock {
  readonly code: 'matching_unconfigured' | 'matching_credential_unconfigured';
  readonly key: 'MATCHING_URL' | 'MATCHING_EDGE_SIGNING_SECRET';
}

export interface MatchingOperatorRouteDeps {
  readonly tokens: TokenConfig;
  readonly authenticateWrite: (header: string | undefined) => Promise<Principal>;
  readonly sessionLive?: (principal: Principal) => Promise<void>;
  /** Null when the upstream URL or the signing secret is blank. */
  readonly matching: MatchingControlCall | null;
  readonly blocked: MatchingDoorBlock | null;
  readonly readApproval: MatchingApprovalRead;
  readonly now?: () => number;
}

interface WriteSpec {
  readonly edge: string;
  readonly action: string;
  readonly market: boolean;
  readonly upstream: (marketId: string) => string;
  readonly targetId: (marketId: string) => string;
}

const WRITES: readonly WriteSpec[] = [
  {
    edge: MATCHING_OPERATOR_EDGE_PATHS.halt,
    action: 'matching.halt',
    market: true,
    upstream: (id) => `/markets/${encodeURIComponent(id)}/halt`,
    targetId: (id) => `halt:${id}`,
  },
  {
    edge: MATCHING_OPERATOR_EDGE_PATHS.resume,
    action: 'matching.resume',
    market: true,
    upstream: (id) => `/markets/${encodeURIComponent(id)}/resume`,
    targetId: (id) => `resume:${id}`,
  },
  {
    edge: MATCHING_OPERATOR_EDGE_PATHS.reduceOnlyOn,
    action: 'matching.reduce_only',
    market: true,
    upstream: (id) => `/markets/${encodeURIComponent(id)}/reduce-only`,
    targetId: (id) => `reduce_only:${id}`,
  },
  {
    edge: MATCHING_OPERATOR_EDGE_PATHS.reduceOnlyOff,
    action: 'matching.reduce_only_resume',
    market: true,
    upstream: (id) => `/markets/${encodeURIComponent(id)}/reduce-only/resume`,
    targetId: (id) => `reduce_only_resume:${id}`,
  },
  {
    edge: MATCHING_OPERATOR_EDGE_PATHS.postOnlyOn,
    action: 'matching.post_only',
    market: true,
    upstream: (id) => `/markets/${encodeURIComponent(id)}/post-only`,
    targetId: (id) => `post_only:${id}`,
  },
  {
    edge: MATCHING_OPERATOR_EDGE_PATHS.postOnlyOff,
    action: 'matching.post_only_resume',
    market: true,
    upstream: (id) => `/markets/${encodeURIComponent(id)}/post-only/resume`,
    targetId: (id) => `post_only_resume:${id}`,
  },
  {
    edge: MATCHING_OPERATOR_EDGE_PATHS.delist,
    action: 'matching.delist',
    market: true,
    upstream: (id) => `/markets/${encodeURIComponent(id)}/delist`,
    targetId: (id) => `delist:${id}`,
  },
  {
    edge: MATCHING_OPERATOR_EDGE_PATHS.haltAll,
    action: 'matching.halt_all',
    market: false,
    upstream: () => '/halt-all',
    targetId: () => 'halt_all',
  },
  {
    edge: MATCHING_OPERATOR_EDGE_PATHS.resumeAll,
    action: 'matching.resume_all',
    market: false,
    upstream: () => '/resume-all',
    targetId: () => 'resume_all',
  },
];

interface StoredResult {
  readonly fingerprint: string;
  readonly status: number;
  readonly body: unknown;
}

interface AuditRow {
  readonly at: string;
  readonly action: string;
  readonly marketId: string | null;
  readonly requesterId: string;
  readonly approverId: string;
  readonly idempotencyKey: string;
  readonly outcome: 'accepted';
}

function isTimeout(err: unknown): boolean {
  if (!err || typeof err !== 'object' || !('name' in err)) return false;
  const name = String((err as { name: unknown }).name);
  return name === 'TimeoutError' || name === 'AbortError';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'matching upstream failed';
}

/**
 * Signed call. `secret` is `MATCHING_EDGE_SIGNING_SECRET`, and the service name is
 * `svc-edge`. The body carries the human operator ids; the signature does not
 * rename them to this service.
 */
export function httpMatchingControl(
  baseUrl: string,
  secret: string,
  timeoutMs: number,
  fetchFn: typeof fetch = globalThis.fetch,
): MatchingControlCall {
  const base = baseUrl.replace(/\/$/, '');
  return async (req) => {
    const payload = req.body === undefined ? '' : JSON.stringify(req.body);
    try {
      const res = await fetchFn(`${base}${req.path}`, {
        method: req.method,
        headers: {
          ...serviceAuthHeadersForBody(MATCHING_SERVICE_NAME, secret, payload),
          ...(payload === '' ? {} : { 'content-type': 'application/json' }),
        },
        body: payload === '' ? undefined : payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let body: unknown = {};
      if (text.length > 0) {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          body = { error: 'matching upstream body was not JSON' };
        }
      }
      return { kind: 'answered', status: res.status, body };
    } catch (err) {
      if (isTimeout(err)) return { kind: 'unknown', error: `svc-matching did not answer before ${timeoutMs}ms` };
      return { kind: 'unavailable', error: `svc-matching did not answer: ${errorMessage(err)}` };
    }
  };
}

function unwrapTrpc(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const root = body as { result?: { data?: unknown }; error?: unknown };
  const data = root.result?.data;
  if (data && typeof data === 'object' && 'json' in data) return (data as { json: unknown }).json;
  return data ?? body;
}

/** Identity `actionApproval.get` with the operator's own bearer. Does not consume. */
export function httpMatchingApprovalRead(
  identityUrl: string,
  timeoutMs: number,
  fetchFn: typeof fetch = globalThis.fetch,
): MatchingApprovalRead {
  const base = identityUrl.replace(/\/$/, '');
  return async (approvalId, bearer) => {
    const input = encodeURIComponent(JSON.stringify({ approvalId }));
    let res: Response;
    try {
      res = await fetchFn(`${base}/trpc/actionApproval.get?input=${input}`, {
        method: 'GET',
        headers: { authorization: bearer },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new MatchingApprovalUnavailable(`identity did not answer: ${errorMessage(err)}`);
    }
    const text = await res.text();
    let parsed: unknown = {};
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw new MatchingApprovalUnavailable('identity approval body was not JSON');
      }
    }
    if (!res.ok) {
      throw new MatchingApprovalUnavailable(`identity refused the approval read (${res.status})`);
    }
    const row = actionApprovalSchema.safeParse(unwrapTrpc(parsed));
    if (!row.success) throw new MatchingApprovalUnavailable('identity approval body did not match the approval contract');
    return {
      status: row.data.status,
      actionType: row.data.actionType,
      targetService: row.data.targetService,
      targetId: row.data.targetId,
      requesterId: row.data.requesterId,
      approverId: row.data.approverId,
      operationId: row.data.operationId,
    };
  };
}

function textField(body: unknown, field: string): string {
  if (!body || typeof body !== 'object') return '';
  const raw = (body as Record<string, unknown>)[field];
  return typeof raw === 'string' ? raw.trim() : '';
}

function fingerprint(action: string, marketId: string | null, approvalId: string, operationId: string): string {
  return JSON.stringify({ action, marketId, approvalId, operationId });
}

function sendJson(reply: FastifyReply, status: number, body: unknown) {
  return reply.code(status).send(body);
}

export function registerMatchingOperatorRoutes(app: FastifyInstance, deps: MatchingOperatorRouteDeps): void {
  const idempotency = new Map<string, StoredResult>();
  const spent = new Set<string>();
  const clock = deps.now ?? Date.now;

  const blockedBody = () => {
    const block = deps.blocked ?? { code: 'matching_unconfigured' as const, key: 'MATCHING_URL' as const };
    return {
      outcome: 'refused' as const,
      error: `${block.key} is unpublished. This edge does not call matching and does not invent a book.`,
      code: block.code,
      key: block.key,
    };
  };

  const authenticateRead = async (header: string | undefined): Promise<Principal> => {
    const token = bearerToken(header ?? null);
    if (!token) throw new AuthError('An operator token is required', 'token.invalid');
    const principal = await verifyAccessToken(token, deps.tokens);
    requireScope(principal, 'admin:read');
    if (deps.sessionLive) await deps.sessionLive(principal);
    return principal;
  };

  const authError = (err: unknown, reply: FastifyReply): boolean => sendOperatorAuthFailure(reply, err);

  const openMatching = (): MatchingControlCall | null => (deps.blocked !== null || !deps.matching ? null : deps.matching);

  app.get(MATCHING_OPERATOR_EDGE_PATHS.health, async (req, reply) => {
    try {
      await authenticateRead(req.headers.authorization);
    } catch (err) {
      if (authError(err, reply)) return reply;
      throw err;
    }
    const matching = openMatching();
    if (!matching) return sendJson(reply, 503, blockedBody());
    const started = clock();
    const res = await matching({ method: 'GET', path: '/health' });
    if (res.kind === 'unknown') {
      return sendJson(reply, 504, {
        outcome: 'unknown',
        code: 'matching_upstream_unknown',
        error: res.error,
      });
    }
    if (res.kind === 'unavailable' || res.status < 200 || res.status >= 300) {
      const reason = res.kind === 'unavailable' ? res.error : `svc-matching health returned ${res.status}`;
      return sendJson(reply, 502, {
        outcome: 'upstream_error',
        code: 'matching_upstream_unavailable',
        error: reason,
      });
    }
    const body = res.body;
    const rec = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
    const venueHalted = rec?.venueHalted;
    const restingOrders = rec?.restingOrders;
    const journalRecords = rec?.journalRecords;
    if (typeof venueHalted !== 'boolean' || typeof restingOrders !== 'number' || typeof journalRecords !== 'number') {
      return sendJson(reply, 502, {
        outcome: 'upstream_error',
        code: 'matching_health_unreadable',
        error: 'matching health did not include venueHalted, restingOrders, and journalRecords',
      });
    }
    const receivedAt = clock();
    return sendJson(reply, 200, {
      venueHalted,
      restingOrders,
      journalRecords,
      asOf: new Date(receivedAt).toISOString(),
      ageMs: Math.max(0, receivedAt - started),
    });
  });

  app.get(MATCHING_OPERATOR_EDGE_PATHS.surveillanceCases, async (req, reply) => {
    try {
      await authenticateRead(req.headers.authorization);
    } catch (err) {
      if (authError(err, reply)) return reply;
      throw err;
    }
    const limit = textField({ limit: (req.query as { limit?: unknown } | undefined)?.limit }, 'limit');
    if (!/^\d+$/.test(limit)) {
      return sendJson(reply, 400, {
        outcome: 'refused',
        code: 'surveillance_limit_unset',
        key: 'limit',
        error: 'limit is unpublished. This edge does not invent a page size.',
      });
    }
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 500) {
      return sendJson(reply, 400, {
        outcome: 'refused',
        code: 'surveillance_limit_unset',
        key: 'limit',
        error: 'limit must be an integer from 1 to 500. This edge does not invent a page size.',
      });
    }
    const matching = openMatching();
    if (!matching) return sendJson(reply, 503, blockedBody());
    const res = await matching({ method: 'GET', path: `/surveillance/cases?limit=${n}` });
    if (res.kind === 'unknown') {
      return sendJson(reply, 504, { outcome: 'unknown', code: 'matching_upstream_unknown', error: res.error });
    }
    if (res.kind === 'unavailable' || res.status < 200 || res.status >= 300) {
      const reason = res.kind === 'unavailable' ? res.error : `svc-matching surveillance returned ${res.status}`;
      return sendJson(reply, 502, { outcome: 'upstream_error', code: 'matching_upstream_unavailable', error: reason });
    }
    const rec = res.body && typeof res.body === 'object' ? (res.body as Record<string, unknown>) : null;
    if (!rec || !Array.isArray(rec.cases)) {
      return sendJson(reply, 502, {
        outcome: 'upstream_error',
        code: 'surveillance_unreadable',
        error: 'matching surveillance did not return a cases array',
      });
    }
    return sendJson(reply, 200, { cases: rec.cases, limit: n, upstream: res.body });
  });

  const onWrite = (spec: WriteSpec) => async (req: FastifyRequest, reply: FastifyReply) => {
    let principal: Principal;
    try {
      principal = await deps.authenticateWrite(req.headers.authorization);
    } catch (err) {
      if (authError(err, reply)) return reply;
      throw err;
    }
    const matching = openMatching();
    if (!matching) return sendJson(reply, 503, blockedBody());
    const marketId = spec.market ? textField(req.params, 'marketId') : null;
    if (spec.market && !marketId) {
      return sendJson(reply, 400, {
        outcome: 'refused',
        code: 'matching.market_id_unset',
        key: 'marketId',
        error: 'marketId is unpublished. This edge does not invent a market.',
      });
    }
    const idempotencyKey = textField(req.body, 'idempotencyKey');
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      return sendJson(reply, 400, {
        outcome: 'refused',
        code: 'matching.idempotency_key_unset',
        key: 'idempotencyKey',
        error: 'idempotencyKey is the client request id and must be 8 to 200 characters.',
      });
    }
    const approvalId = textField(req.body, 'approvalId');
    const operationId = textField(req.body, 'operationId');
    if (!approvalId || !operationId) {
      return sendJson(reply, 400, {
        outcome: 'refused',
        code: 'action_approval.missing',
        key: approvalId ? 'operationId' : 'approvalId',
        error: 'approvalId and operationId are required. Two operator id strings are not an approval.',
      });
    }
    const fp = fingerprint(spec.action, marketId, approvalId, operationId);
    const prior = idempotency.get(idempotencyKey);
    if (prior) {
      if (prior.fingerprint !== fp) {
        return sendJson(reply, 409, {
          outcome: 'refused',
          code: 'matching.idempotency_conflict',
          key: 'idempotencyKey',
          error: 'This client request id was already used for a different matching control.',
        });
      }
      return sendJson(reply, prior.status, prior.body);
    }
    if (spent.has(approvalId)) {
      return sendJson(reply, 409, {
        outcome: 'refused',
        code: 'action_approval.reused',
        key: 'approvalId',
        error: 'This approval was already used for a matching control.',
      });
    }
    const bearer = req.headers.authorization;
    if (!bearer) return sendJson(reply, 401, { error: 'An operator token is required', code: 'token.invalid' });

    let row: MatchingApprovalRow;
    try {
      row = await deps.readApproval(approvalId, bearer);
    } catch (err) {
      if (err instanceof MatchingApprovalUnavailable) {
        return sendJson(reply, 503, {
          outcome: 'unknown',
          code: 'action_approval.identity_unreadable',
          error: err.message,
        });
      }
      throw err;
    }
    const targetId = spec.targetId(marketId ?? '');
    const refusal = approvalRefusal(row, {
      action: spec.action,
      targetId,
      operationId,
      requesterId: principal.userId,
    });
    if (refusal) return sendJson(reply, refusal.status, refusal.body);

    const upstreamBody = {
      operatorId: row.requesterId,
      confirmOperatorId: row.approverId,
      approvalId,
      operationId,
    };
    const res = await matching({
      method: 'POST',
      path: spec.upstream(marketId ?? ''),
      body: upstreamBody,
    });
    if (res.kind === 'unknown') {
      const body = { outcome: 'unknown' as const, code: 'matching_upstream_unknown' as const, error: res.error };
      idempotency.set(idempotencyKey, { fingerprint: fp, status: 504, body });
      return sendJson(reply, 504, body);
    }
    if (res.kind === 'unavailable') {
      const body = { outcome: 'upstream_error' as const, code: 'matching_upstream_unavailable' as const, error: res.error };
      idempotency.set(idempotencyKey, { fingerprint: fp, status: 502, body });
      return sendJson(reply, 502, body);
    }
    const upstream = res.body && typeof res.body === 'object' ? (res.body as Record<string, unknown>) : null;
    const accepted = res.status >= 200 && res.status < 300 && upstream?.accepted === true;
    if (!accepted) {
      const body = {
        outcome: 'upstream_error' as const,
        code: 'matching_upstream_error' as const,
        error: 'svc-matching did not accept the control. The market is not claimed changed.',
        status: res.status,
        upstream: res.body,
      };
      idempotency.set(idempotencyKey, { fingerprint: fp, status: 502, body });
      return sendJson(reply, 502, body);
    }
    const audit: AuditRow = {
      at: new Date(clock()).toISOString(),
      action: spec.action,
      marketId,
      requesterId: row.requesterId,
      approverId: row.approverId as string,
      idempotencyKey,
      outcome: 'accepted',
    };
    spent.add(approvalId);
    const body = { outcome: 'accepted' as const, audit, upstream: res.body };
    idempotency.set(idempotencyKey, { fingerprint: fp, status: 200, body });
    return sendJson(reply, 200, body);
  };

  for (const spec of WRITES) app.post(spec.edge, onWrite(spec));
}

function approvalRefusal(
  row: MatchingApprovalRow,
  expected: { readonly action: string; readonly targetId: string; readonly operationId: string; readonly requesterId: string },
): { readonly status: number; readonly body: Record<string, unknown> } | null {
  if (row.status === 'CONSUMED') {
    return {
      status: 409,
      body: {
        outcome: 'refused',
        code: 'action_approval.reused',
        key: 'approvalId',
        error: 'This approval is already consumed.',
      },
    };
  }
  if (row.status !== 'APPROVED') {
    return {
      status: 400,
      body: {
        outcome: 'refused',
        code: 'action_approval.not_approved',
        key: 'approvalId',
        error: `The approval status is ${row.status}. A pending or rejected approval does not run the control.`,
      },
    };
  }
  if (row.approverId === null || row.approverId === row.requesterId) {
    return {
      status: 400,
      body: {
        outcome: 'refused',
        code: 'action_approval.same_person',
        key: 'approvalId',
        error: 'The approver must be a different operator. One person does not approve their own matching control.',
      },
    };
  }
  if (row.requesterId !== expected.requesterId) {
    return {
      status: 403,
      body: {
        outcome: 'refused',
        code: 'action_approval.not_requester',
        key: 'approvalId',
        error: 'The signed-in operator is not the person who proposed this approval.',
      },
    };
  }
  if (row.actionType !== expected.action || row.targetService !== 'svc-matching' || row.targetId !== expected.targetId) {
    return {
      status: 400,
      body: {
        outcome: 'refused',
        code: 'action_approval.wrong_action',
        key: 'approvalId',
        error: `The approval is not for ${expected.action} on ${expected.targetId}.`,
      },
    };
  }
  if (row.operationId !== expected.operationId) {
    return {
      status: 400,
      body: {
        outcome: 'refused',
        code: 'action_approval.operation_mismatch',
        key: 'operationId',
        error: 'operationId does not match the approval.',
      },
    };
  }
  return null;
}
