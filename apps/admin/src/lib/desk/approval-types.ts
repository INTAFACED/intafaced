import { readOpenedDocument, type OpenedDocument } from '@/lib/kyc-documents/document';
import { isApprovalId } from './approval-packet';
import type { RefusalView } from './refusal-copy';

/** Wire types shared by the approval BFFs and their browser client. Pure. */

export type StepName = 'propose' | 'approve' | 'reject' | 'revoke' | 'execute';

export interface ApprovalView {
  readonly approvalId: string;
  readonly operationId: string;
  readonly status: string;
  readonly expiresAt: string;
  readonly requesterId: string;
  readonly approverId: string | null;
}

/** A run that reads rather than changes (opening a KYC document) also carries what it read, for the page that asked only. */
export type ExecuteReply =
  | { readonly ok: true; readonly detail: string; readonly document?: OpenedDocument }
  | { readonly ok: false; readonly refusal: RefusalView };

export type StepReply =
  | {
      readonly ok: true;
      readonly step: Exclude<StepName, 'execute'>;
      readonly approval: ApprovalView;
      /** propose only: what to hand to the other founder. */
      readonly packet?: string;
      /** approve only: false when identity's row is not for the request this founder read. Reject it. */
      readonly matchesReviewedRequest?: boolean;
    }
  | { readonly ok: true; readonly step: 'execute'; readonly detail: string; readonly document?: OpenedDocument }
  | { readonly ok: false; readonly step: StepName | null; readonly refusal: RefusalView };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const STEP_NAMES: readonly string[] = ['propose', 'approve', 'reject', 'revoke', 'execute'];

function readApproval(raw: unknown): ApprovalView | null {
  if (!isRecord(raw)) return null;
  const { approvalId, operationId, status, expiresAt, requesterId, approverId } = raw;
  if (!isApprovalId(approvalId) || !isApprovalId(operationId) || !isApprovalId(requesterId)) return null;
  if (typeof status !== 'string' || typeof expiresAt !== 'string') return null;
  if (!(approverId === null || isApprovalId(approverId))) return null;
  return { approvalId, operationId, status, expiresAt, requesterId, approverId };
}

function readRefusal(raw: unknown): RefusalView | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.title !== 'string' || typeof raw.body !== 'string' || typeof raw.next !== 'string') return null;
  if (!(raw.code === null || typeof raw.code === 'string')) return null;
  if (raw.changed !== 'no' && raw.changed !== 'unknown') return null;
  return { title: raw.title, body: raw.body, next: raw.next, code: raw.code, changed: raw.changed };
}

/**
 * The browser's strict reader for a BFF answer. Anything that is not exactly a known shape becomes an
 * "outcome unknown" refusal, never a success: a malformed 200 must not light a green badge.
 */
export function readStepReply(raw: unknown): StepReply {
  if (isRecord(raw) && typeof raw.ok === 'boolean') {
    const step = typeof raw.step === 'string' && STEP_NAMES.includes(raw.step) ? (raw.step as StepName) : null;
    if (raw.ok === false) {
      const refusal = readRefusal(raw.refusal);
      if (refusal) return { ok: false, step, refusal };
    } else if (step === 'execute' && typeof raw.detail === 'string') {
      if (raw.document === undefined) return { ok: true, step, detail: raw.detail };
      // A document that does not read exactly is not shown, and the run is reported as not understood.
      const document = readOpenedDocument(raw.document);
      if (document) return { ok: true, step, detail: raw.detail, document };
    } else if (step !== null && step !== 'execute') {
      const approval = readApproval(raw.approval);
      if (approval) {
        return {
          ok: true,
          step,
          approval,
          ...(typeof raw.packet === 'string' ? { packet: raw.packet } : {}),
          ...(typeof raw.matchesReviewedRequest === 'boolean' ? { matchesReviewedRequest: raw.matchesReviewedRequest } : {}),
        };
      }
    }
  }
  return {
    ok: false,
    step: null,
    refusal: {
      title: 'The console got an answer it could not read',
      body: 'It is not known whether the step went through.',
      next: 'Read the current state before doing anything again.',
      code: null,
      changed: 'unknown',
    },
  };
}
