/**
 * Read the owner-configured restore archive. A JSON number is not a sequence:
 * coercing it would invent a decimal string. A bad or unread manifest is not a list.
 */

export interface RestoreBackup {
  readonly id: string;
  readonly kind: 'full' | 'incremental';
  readonly sequence: string;
  readonly takenAt: string;
}

export type RestoreArchiveProbeResult = { readonly probed: true; readonly backups: readonly RestoreBackup[] } | { readonly probed: false };

const MAX_BODY = 1_000_000;
const TAKEN_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

const unprobed = (): RestoreArchiveProbeResult => ({ probed: false });

/** A manifest the archive actually returned, or null when it is not that shape. */
export function parseRestoreArchiveManifest(body: unknown): readonly RestoreBackup[] | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const backups = (body as { backups?: unknown }).backups;
  if (!Array.isArray(backups)) return null;
  const seen = new Set<string>();
  const rows: RestoreBackup[] = [];
  for (const row of backups) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const record = row as Record<string, unknown>;
    const { id, kind, sequence, takenAt } = record;
    if (typeof id !== 'string') return null;
    const trimmed = id.trim();
    if (trimmed.length < 1 || trimmed.length > 128 || seen.has(trimmed)) return null;
    if (kind !== 'full' && kind !== 'incremental') return null;
    if (typeof sequence !== 'string' || !/^[0-9]+$/.test(sequence) || sequence.length > 40) return null;
    if (typeof takenAt !== 'string' || !TAKEN_AT.test(takenAt) || Number.isNaN(Date.parse(takenAt))) return null;
    seen.add(trimmed);
    rows.push({ id: trimmed, kind, sequence, takenAt });
  }
  return rows;
}

/** GET the archive. A non-http URL, a redirect, a failed read, or a bad body is unprobed. Nothing is invented. */
export async function probeRestoreArchive(url: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<RestoreArchiveProbeResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return unprobed();
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return unprobed();
  let response: Response;
  try {
    response = await fetchImpl(parsed.href, {
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    return unprobed();
  }
  if (!response.ok) return unprobed();
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_BODY)) return unprobed();
  let text: string;
  try {
    text = await response.text();
  } catch {
    return unprobed();
  }
  if (text.length > MAX_BODY) return unprobed();
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    return unprobed();
  }
  const backups = parseRestoreArchiveManifest(json);
  if (!backups) return unprobed();
  return { probed: true, backups };
}
