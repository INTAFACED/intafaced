/**
 * Founder desks that svc-ops owns: custody posture, joint-restore watermarks,
 * idempotency keys.
 *
 * Blank config refuses with a typed code. This module does not invent a
 * balance, a key, an alert, or a completed restore.
 */
import { createHash } from 'node:crypto';
import {
  createIdentityApprovalClient,
  founderAttestationVerdict,
  type ActionApproval,
  type ServiceAuthMode,
  type ServiceSigner,
  type ActionApprovalConsumeInput,
} from '@intafaced/contracts';
import {
  OPS_APPROVAL_MISSING,
  OPS_APPROVAL_NOT_FOUNDERS,
  OPS_APPROVAL_UNWIRED,
  OPS_APPROVAL_WRONG,
  OPS_CUSTODY_KEYS_UNPUBLISHED,
  OPS_CUSTODY_LEDGER_UNWIRED,
  OPS_IDEMPOTENCY_CONFLICT,
  OPS_IDEMPOTENCY_KEY_INVALID,
  OPS_RESTORE_ARCHIVE_UNCONFIGURED,
  OPS_RESTORE_ARCHIVE_UNPROBED,
  OPS_RESTORE_WATERMARK_REQUIRED,
  OpsError,
} from './codes.js';
import type { CustodyResult } from './ops-service.js';

export interface ApprovalConsumer {
  consume(input: ActionApprovalConsumeInput): Promise<ActionApproval>;
}

export function configuredUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function custodyOpsStatus(listed: CustodyResult, asOf: string) {
  return {
    asOf,
    wrap: listed.wrap,
    freeze: listed.freeze,
    tiers: listed.tiers.map((tier) => ({
      id: tier.id,
      keyCount: null,
      code: OPS_CUSTODY_KEYS_UNPUBLISHED,
    })),
    pendingApprovals: listed.approvals.map((row) => ({ ...row })),
    balances: { status: 'unconfigured' as const, code: OPS_CUSTODY_LEDGER_UNWIRED },
  };
}

export interface ArchivePosture {
  readonly configured: boolean;
  readonly probed: false;
  readonly code: typeof OPS_RESTORE_ARCHIVE_UNCONFIGURED | typeof OPS_RESTORE_ARCHIVE_UNPROBED;
}

export function archivePosture(url: string | null | undefined): ArchivePosture {
  if (!configuredUrl(url)) return { configured: false, probed: false, code: OPS_RESTORE_ARCHIVE_UNCONFIGURED };
  return { configured: true, probed: false, code: OPS_RESTORE_ARCHIVE_UNPROBED };
}

export interface WatermarkStamp {
  readonly service: string;
  readonly kind: string;
  readonly watermark: string;
  readonly recordedAt: string;
  readonly recordedBy: string;
  readonly approverId: string;
}

export function restoreWatermarksRead(url: string | null | undefined, rows: readonly WatermarkStamp[], asOf: string) {
  const archive = archivePosture(url);
  if (!archive.configured) {
    return { asOf, archive, watermarks: null, restored: false as const };
  }
  return {
    asOf,
    archive,
    watermarks: { stamped: rows.length > 0, rows: [...rows] },
    restored: false as const,
  };
}

const KEY_MIN = 8;
const KEY_MAX = 200;

export function assertIdempotencyKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length < KEY_MIN || trimmed.length > KEY_MAX) {
    throw new OpsError(OPS_IDEMPOTENCY_KEY_INVALID, `idempotencyKey must be ${KEY_MIN} to ${KEY_MAX} characters`);
  }
  return trimmed;
}

export interface IdempotencyHit<T> {
  readonly fingerprint: string;
  readonly value: T;
}

export function takeIdempotent<T>(store: Map<string, IdempotencyHit<T>>, key: string, fingerprint: string): T | undefined {
  const prior = store.get(key);
  if (!prior) return undefined;
  if (prior.fingerprint !== fingerprint) {
    throw new OpsError(OPS_IDEMPOTENCY_CONFLICT, 'This idempotency key was already used for a different request');
  }
  return prior.value;
}

export function rememberIdempotent<T>(store: Map<string, IdempotencyHit<T>>, key: string, fingerprint: string, value: T): T {
  store.set(key, { fingerprint, value });
  return value;
}

export function approvalPayloadHash(actionType: string, fields: Record<string, string>): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ actionType, ...fields }))
    .digest('hex')}`;
}

/** Identity answers or the door refuses: the shared client bounds the call with a timeout (a timeout fails closed) and checks the CONSUMED echo. */
export function createOpsApprovalClient(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): ApprovalConsumer {
  return createIdentityApprovalClient({
    service: 'svc-ops',
    baseUrl,
    internalSecret,
    fail: (message) => new OpsError(OPS_APPROVAL_UNWIRED, message),
    ...(s2s ? { s2s } : {}),
  });
}

export function unwiredApprovalConsumer(): ApprovalConsumer {
  return {
    async consume() {
      throw new OpsError(OPS_APPROVAL_UNWIRED, 'IDENTITY_URL is unpublished; this door does not invent a second person');
    },
  };
}

export async function consumeFounderApproval(
  approvals: ApprovalConsumer | undefined,
  input: {
    readonly approvalId: string;
    readonly operationId: string;
    readonly actionType: string;
    readonly targetService: string;
    readonly targetId: string;
    readonly fields: Record<string, string>;
    readonly requesterId: string;
    /**
     * Identity's idempotency key for this consume (1 to 128 characters). With it, a retry after a crash between the
     * consume and the write returns the consumed row; without it a retry is refused `action_approval.consumed`.
     */
    readonly requestId?: string;
  },
): Promise<ActionApproval> {
  const approvalId = input.approvalId.trim();
  const operationId = input.operationId.trim();
  if (!approvalId || !operationId) {
    throw new OpsError(OPS_APPROVAL_MISSING, 'approvalId and operationId are required; a typed-in second name is not approval');
  }
  const consumer = approvals ?? unwiredApprovalConsumer();
  let consumed: ActionApproval;
  try {
    consumed = await consumer.consume({
      approvalId,
      operationId,
      payloadHash: approvalPayloadHash(input.actionType, input.fields),
      targetService: input.targetService,
      targetId: input.targetId,
      expectedVersion: '1',
      ...(input.requestId ? { requestId: input.requestId } : {}),
    });
  } catch (err) {
    if (err instanceof OpsError) throw err;
    throw new OpsError(OPS_APPROVAL_UNWIRED, err instanceof Error ? err.message : 'identity did not consume the approval');
  }
  if (consumed.actionType !== input.actionType || consumed.targetService !== input.targetService || consumed.targetId !== input.targetId) {
    throw new OpsError(OPS_APPROVAL_WRONG, `the approval is not for ${input.actionType} on ${input.targetId}`);
  }
  if (consumed.requesterId.trim().toLowerCase() !== input.requesterId.trim().toLowerCase()) {
    throw new OpsError(OPS_APPROVAL_WRONG, 'the approval was proposed by someone else');
  }
  const verdict = founderAttestationVerdict(consumed, {
    actionType: input.actionType,
    targetService: input.targetService,
    targetId: input.targetId,
  });
  if (!verdict.ok) {
    throw new OpsError(OPS_APPROVAL_NOT_FOUNDERS, 'a joint restore stamp needs two distinct live founders');
  }
  return consumed;
}

const NAME = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

export function parseWatermarkInput(input: { service?: string; kind?: string; watermark?: string }): {
  service: string;
  kind: string;
  watermark: string;
} {
  const service = input.service?.trim().toLowerCase() ?? '';
  const kind = input.kind?.trim().toLowerCase() ?? '';
  const watermark = input.watermark?.trim() ?? '';
  if (!NAME.test(service) || !NAME.test(kind) || watermark.length === 0 || watermark.length > 256) {
    throw new OpsError(
      OPS_RESTORE_WATERMARK_REQUIRED,
      'A stamp needs service, kind, and the watermark string the operator read. Nothing is generated.',
    );
  }
  return { service, kind, watermark };
}
