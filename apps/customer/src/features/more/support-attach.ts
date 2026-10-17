/**
 * Reading a chosen file for the support service. It takes the file as base64 text plus the type the browser reports, and
 * nothing else: no name, no path. The service owns the size limit, the allowed types and the malware scan, so this does
 * not guess them. It only refuses what it can see is unusable: an empty file, one the browser cannot read, or one too big
 * to ever pass the gateway.
 */

/**
 * The gateway takes at most 32 MiB of JSON (svc-edge EDGE_BODY_LIMIT_BYTES cap), and base64 adds a third, so a file over
 * 24 MiB can never arrive. Refusing it here also keeps a phone video from being copied into memory several times.
 */
export const MAX_ATTACH_BYTES = 24 * 1024 * 1024;
export type AttachRead =
  { ok: true; contentType: string; bodyBase64: string; byteLength: number } | { ok: false; reason: 'empty' | 'unreadable' | 'tooLarge' };

export async function readAttachment(file: Blob): Promise<AttachRead> {
  if (file.size === 0) return { ok: false, reason: 'empty' };
  if (file.size > MAX_ATTACH_BYTES) return { ok: false, reason: 'tooLarge' };
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    // Chunked so a large file does not overflow the argument list of fromCharCode.
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return { ok: true, contentType: file.type || 'application/octet-stream', bodyBase64: btoa(binary), byteLength: bytes.length };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

/** "1.2 MB", "340 KB", "12 bytes": for the review step. */
export function fileSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
