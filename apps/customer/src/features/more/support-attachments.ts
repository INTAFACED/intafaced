import type { SupportAttachmentLimits, SupportAttachmentScanState } from '@intafaced/contracts/support-attachments';
import type { RefusalKey } from './support-refusal';
import { fileSizeLabel } from './support-attach';

/**
 * What the attach control and the file list show, as pure rules over what the support service returned. The limits are
 * the owner's: a blank one is never filled in here, and the service stays the authority on every one of them. The
 * checks below only spare a person from sending a file the service has already said it will refuse.
 */

/** `ready` only when every limit is set. The deployment pieces (store, scanner) are named by `missing`, never shown. */
export type AttachLimitsView =
  | { readonly kind: 'ready'; readonly maxBytes: number; readonly maxCount: number; readonly types: readonly string[] }
  | { readonly kind: 'off' };

export function attachLimitsView(limits: SupportAttachmentLimits): AttachLimitsView {
  if (limits.missing !== null || limits.maxBytes === null || limits.maxCount === null || limits.allowedTypes === null)
    return { kind: 'off' };
  return { kind: 'ready', maxBytes: limits.maxBytes, maxCount: limits.maxCount, types: limits.allowedTypes };
}

export function limitsValues(view: Extract<AttachLimitsView, { kind: 'ready' }>): { count: string; size: string; types: string } {
  return { count: String(view.maxCount), size: fileSizeLabel(view.maxBytes), types: view.types.join(', ') };
}

/** The refusal a file would get from the limits already read, or `null` when it may be sent. Without limits, nothing is guessed. */
export function precheckFile(view: AttachLimitsView | null, file: { contentType: string; byteLength: number }): RefusalKey | null {
  if (!view || view.kind !== 'ready') return null;
  if (file.byteLength > view.maxBytes) return 'refuseAttachLarge';
  if (!view.types.includes(file.contentType)) return 'refuseAttachType';
  return null;
}

export const SCAN_STATE_KEY = {
  scanning: 'scanStateScanning',
  clean: 'scanStateClean',
  blocked: 'scanStateBlocked',
} as const satisfies Record<SupportAttachmentScanState, string>;

/** Only a checked file can be opened. */
export const canDownload = (state: SupportAttachmentScanState): boolean => state === 'clean';

/** A browser download of base64 bytes, always as a file and never opened in the page. */
export function saveBase64(bodyBase64: string, id: string): boolean {
  try {
    const binary = atob(bodyBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `attachment-${id.slice(0, 8)}`;
    link.click();
    URL.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
}
