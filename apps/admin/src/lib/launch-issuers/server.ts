import 'server-only';
import type { ExecuteFn } from '@/lib/desk/approval-steps';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import { partFrom, type Part } from '@/lib/desk/part';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { failureRefusal } from '@/lib/ops-desk/execute';
import {
  createInputFor,
  readEventRow,
  readEvents,
  readIssuer,
  readIssuers,
  readLaunchEventPayload,
  readMoves,
  type LaunchEventRow,
  type LaunchIssuer,
  type LaunchMove,
} from './model';

/**
 * The launch issuer lens (J-more-catalogue-14), read and written as the signed-in founder through svc-token `launch.*`. Each
 * write spends a two-founder identity approval bound to its exact fields; svc-token refuses the approver as the one who runs
 * it. This console adds no authority and keeps no state.
 */

const LABELS = {
  service: 'svc-token',
  forbiddenMessage: 'svc-token did not accept this founder session for the launch lens (admin:read).',
};
/** The newest launches this lens lists, and so the most it reads moves for. */
const PAGE = 100;

export interface IssuerLensRead {
  readonly issuers: Part<LaunchIssuer[]>;
  readonly events: Part<LaunchEventRow[]>;
  /** Audit trail per issuer id and per launch id; a failed read says why for that row only. */
  readonly issuerMoves: Readonly<Record<string, Part<LaunchMove[]>>>;
  readonly eventMoves: Readonly<Record<string, Part<LaunchMove[]>>>;
  readonly asOf: string;
}

async function movesOf(ctx: FounderCallContext, kind: 'issuer' | 'event', ids: readonly string[]) {
  const reads = await Promise.all(
    ids.map(
      async (id) =>
        [id, partFrom(await founderCall(ctx, 'token', 'launch.admin.moves', 'GET', { kind, id }, readMoves), (m) => m, LABELS)] as const,
    ),
  );
  return Object.fromEntries(reads);
}

export async function readIssuerLens(ctx: FounderCallContext): Promise<IssuerLensRead> {
  const [issuers, events] = await Promise.all([
    founderCall(ctx, 'token', 'launch.admin.issuers', 'GET', undefined, readIssuers),
    founderCall(ctx, 'token', 'launch.admin.events', 'GET', { limit: PAGE }, readEvents),
  ]);
  const issuerPart = partFrom(issuers, (d) => d, LABELS);
  const eventPart = partFrom(events, (d) => d, LABELS);
  const [issuerMoves, eventMoves] = await Promise.all([
    movesOf(ctx, 'issuer', issuerPart.kind === 'ok' ? issuerPart.data.map((i) => i.id) : []),
    movesOf(ctx, 'event', eventPart.kind === 'ok' ? eventPart.data.map((e) => e.id) : []),
  ]);
  return { issuers: issuerPart, events: eventPart, issuerMoves, eventMoves, asOf: new Date().toISOString() };
}

/** Runs an approved issuer change, draft or launch move once, spending the approval at svc-token. */
export function launchLensExecute(ctx: FounderCallContext): ExecuteFn {
  return async (request, ids) => {
    const approval = { approvalId: ids.approvalId, operationId: ids.operationId };
    if (request.kind === 'token.launch.issuer.set') {
      const result = await founderCall(
        ctx,
        'token',
        'launch.issuer.set',
        'POST',
        { id: request.issuerId, name: request.name, state: request.state, expectedRevision: Number(request.revision), ...approval },
        readIssuer,
      );
      if (result.kind !== 'ok') return failureRefusal('svc-token', 'token', result);
      if (result.data.id !== request.issuerId || result.data.state !== request.state)
        return { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };
      return { ok: true, detail: `Issuer ${result.data.id} is ${result.data.state}, at revision ${result.data.revision}.` };
    }
    if (request.kind === 'token.launch.event.create') {
      const payload = readLaunchEventPayload(request.event);
      if (!payload) return { ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) };
      const result = await founderCall(
        ctx,
        'token',
        'launch.events.create',
        'POST',
        { ...createInputFor(payload), ...approval },
        readCreated,
      );
      if (result.kind !== 'ok') return failureRefusal('svc-token', 'token', result);
      if (result.data.id !== payload.id) return { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };
      return { ok: true, detail: `Launch ${result.data.id} is saved as a ${result.data.status}, at revision ${result.data.revision}.` };
    }
    if (request.kind === 'token.launch.event.move') {
      const result = await founderCall(
        ctx,
        'token',
        'launch.events.move',
        'POST',
        { id: request.eventId, to: request.to, expectedRevision: Number(request.revision), ...approval },
        readEventRow,
      );
      if (result.kind !== 'ok') return failureRefusal('svc-token', 'token', result);
      if (result.data.id !== request.eventId) return { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };
      return { ok: true, detail: `Launch ${result.data.id} is ${result.data.status}, at revision ${result.data.revision}.` };
    }
    return { ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) };
  };
}

function readCreated(raw: unknown): { id: string; status: string; revision: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.status === 'string' && Number.isInteger(r.revision)
    ? { id: r.id, status: r.status, revision: r.revision as number }
    : null;
}
