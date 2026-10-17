import { MerchantOpsError } from './errors.js';

/**
 * Storage ceiling for one evidence blob. This stops an unbounded bytea write.
 * It is not a product file-size policy: there is no merchant-facing tier or
 * fee attached to it. 1 MiB matches the CHECK on
 * pay.merchant_dispute_evidence_content.
 */
export const EVIDENCE_CONTENT_BYTE_CEILING = 1_048_576;

/** Security allowlist. Metadata-only evidence may name other types; bytes may not. */
export const EVIDENCE_CONTENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain'] as const;
export type EvidenceContentType = (typeof EVIDENCE_CONTENT_TYPES)[number];

export interface DisputeEvidenceScanner {
  scan(input: { content: Uint8Array; contentType: string; sha256: string }): Promise<'clean' | 'rejected'>;
}

/**
 * Both switches default off. `on` is the only enabling value so a stray
 * `true` or `1` does not open the door. A scanner object without the scan
 * switch still refuses: the hook is unconfigured until both are set.
 */
export interface DisputeEvidenceGate {
  readonly uploadEnabled: boolean;
  readonly scanEnabled: boolean;
  readonly scanner?: DisputeEvidenceScanner;
}

export const EVIDENCE_UPLOAD_OFF: DisputeEvidenceGate = { uploadEnabled: false, scanEnabled: false };

export function disputeEvidenceUploadEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.PAY_DISPUTE_EVIDENCE_UPLOAD === 'on';
}

export function disputeEvidenceScanEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.PAY_DISPUTE_EVIDENCE_SCAN === 'on';
}

export function assertEvidenceFileName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(trimmed)) {
    throw new MerchantOpsError('pay.dispute_evidence_file_name', 'bad_request');
  }
  return trimmed;
}

export function assertEvidenceContentType(value: string): EvidenceContentType {
  const trimmed = value.trim().toLowerCase();
  if (!(EVIDENCE_CONTENT_TYPES as readonly string[]).includes(trimmed)) {
    throw new MerchantOpsError('pay.dispute_evidence_content_type', 'bad_request');
  }
  return trimmed as EvidenceContentType;
}

/** Canonical base64 only. Node's decoder is lenient; a loose decode would store different bytes than the caller sent. */
export function decodeEvidenceContent(contentBase64: string): Buffer {
  const trimmed = contentBase64.trim();
  if (trimmed.length === 0) throw new MerchantOpsError('pay.dispute_evidence_empty', 'bad_request');
  if (trimmed.length > 1_400_000) throw new MerchantOpsError('pay.dispute_evidence_too_large', 'bad_request');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(trimmed)) {
    throw new MerchantOpsError('pay.dispute_evidence_content_invalid', 'bad_request');
  }
  const bytes = Buffer.from(trimmed, 'base64');
  if (bytes.length === 0) throw new MerchantOpsError('pay.dispute_evidence_empty', 'bad_request');
  if (bytes.length > EVIDENCE_CONTENT_BYTE_CEILING) throw new MerchantOpsError('pay.dispute_evidence_too_large', 'bad_request');
  return bytes;
}
