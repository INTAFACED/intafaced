// hand-declared-ok: svc-trade's /api/v1/vip/applications has no schema in packages/contracts; this mirrors its answer
/**
 * The signed-in person's VIP applications (`/api/v1/vip/applications`, svc-trade, SP-fees-vip-04): the owner's rules
 * for the proof file (accepted types and largest size, or none: applications are not open) and the person's own
 * applications, metadata only. Sending one reads the file here and sends its bytes; the service checks everything.
 */
import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import type { Fetcher } from '../../data/poll';

const applicationSchema = z.object({
  id: z.string().min(1),
  requestId: z.string().min(1),
  status: z.enum(['pending', 'approved', 'approved_no_trial', 'rejected']),
  proof: z.object({ fileName: z.string().min(1), contentType: z.string().min(1), byteLength: z.number().int().min(1), sha256: z.string() }),
  note: z.string().nullable(),
  scheduleVersion: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const vipApplicationsSchema = z.object({
  rules: z.object({ proofTypes: z.array(z.string().min(1)).min(1), maxBytes: z.number().int().min(1) }).nullable(),
  applications: z.array(applicationSchema),
});

export type VipApplications = z.infer<typeof vipApplicationsSchema>;
export type VipApplication = z.infer<typeof applicationSchema>;

export const VIP_APPLICATIONS = '/vip/applications';

export const vipApplicationsFetcher =
  (api: ApiClient): Fetcher<VipApplications> =>
  (signal) =>
    api.rest(VIP_APPLICATIONS, vipApplicationsSchema, { signal });

/** Bytes as canonical base64, in slices so a large file never overflows the argument list. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * The request id of a send: from the file's bytes and the note, so sending the same thing again (a retry after a lost
 * answer) is the same request and answers the application it made, never a second one.
 */
export async function vipRequestId(bytes: Uint8Array, note: string): Promise<string> {
  const noteBytes = new TextEncoder().encode(`\n${note.trim()}`);
  const joined = new Uint8Array(bytes.length + noteBytes.length);
  joined.set(bytes);
  joined.set(noteBytes, bytes.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', joined));
  return `proof-${Array.from(digest.subarray(0, 20), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** The type a browser names a file by; one it cannot name is sent as unknown, and the service refuses it by name. */
export const fileType = (file: { type: string }): string => file.type.trim() || 'application/octet-stream';

export async function sendVipApplication(
  api: ApiClient,
  file: { name: string; type: string; bytes: Uint8Array },
  note: string,
): Promise<ApiResult<{ application: VipApplication }>> {
  return api.rest(VIP_APPLICATIONS, z.object({ application: applicationSchema }), {
    method: 'POST',
    body: {
      requestId: await vipRequestId(file.bytes, note),
      proof: { fileName: file.name, contentType: fileType(file), bytesBase64: toBase64(file.bytes) },
      ...(note.trim() ? { note: note.trim() } : {}),
    },
  });
}

const TYPE_NAMES: Readonly<Record<string, string>> = { 'application/pdf': 'PDF', 'image/png': 'PNG', 'image/jpeg': 'JPEG' };

/** A proof type as a person reads it: "PDF" for application/pdf; a type with no short name stays as sent. */
export const typeName = (type: string): string => TYPE_NAMES[type] ?? type;

/** A byte count as a person reads it, in binary units, never rounded up past the limit it states. */
export function sizeName(bytes: number): string {
  const units: Array<[number, string]> = [
    [1024 * 1024, 'MB'],
    [1024, 'KB'],
  ];
  for (const [unit, label] of units) {
    if (bytes >= unit) return `${Math.floor((bytes / unit) * 10) / 10} ${label}`;
  }
  return `${bytes} bytes`;
}
