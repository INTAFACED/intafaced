/**
 * API-key expiresAt at the edge session door.
 * After expiresAt the session cannot place. Missing clock refuses. Never invent an expiry.
 */
export class KeyExpiresError extends Error {
  constructor(
    message: string,
    readonly code: 'auth.clock_missing' | 'auth.api_key_expired',
  ) {
    super(message);
    this.name = 'KeyExpiresError';
  }
}

export function requireNow(value: Date | string | number | null | undefined): Date {
  if (value === null || value === undefined) {
    throw new KeyExpiresError('clock is required', 'auth.clock_missing');
  }
  if (typeof value === 'string' && value.trim() === '') {
    throw new KeyExpiresError('clock is required', 'auth.clock_missing');
  }
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) {
    throw new KeyExpiresError('clock is required', 'auth.clock_missing');
  }
  return at;
}

/** Identity / exchange body only. Never invent an expiry. */
export function optionalExpiresAt(body: unknown): Date | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const rec = body as Record<string, unknown>;
  const raw = rec.expiresAt ?? rec.expires_at;
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== 'string' && typeof raw !== 'number' && !(raw instanceof Date)) return undefined;
  if (typeof raw === 'string' && raw.trim() === '') return undefined;
  const at = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(at.getTime())) return undefined;
  return at;
}

/** Walk a tRPC envelope or a bare body. Never invent an expiry. */
export function optionalExpiresAtFromExchange(body: unknown): Date | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const envelope = body as {
    result?: { data?: { json?: unknown; expiresAt?: unknown; expires_at?: unknown } };
    expiresAt?: unknown;
    expires_at?: unknown;
  };
  const data = envelope.result?.data?.json ?? envelope.result?.data ?? body;
  return optionalExpiresAt(data);
}

/** After expiresAt the session cannot place. Missing expiry stays open. Missing clock refuses. */
export function keyPastExpiresAt(expiresAt: Date | string | null | undefined, now: Date | string | number | null | undefined): boolean {
  const clock = requireNow(now);
  if (expiresAt === null || expiresAt === undefined) return false;
  if (typeof expiresAt === 'string' && expiresAt.trim() === '') return false;
  const at = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(at.getTime())) return false;
  return at.getTime() < clock.getTime();
}

export function assertKeyNotExpired(expiresAt: Date | string | null | undefined, now: Date | string | number | null | undefined): void {
  if (keyPastExpiresAt(expiresAt, now)) {
    throw new KeyExpiresError('API key is past expiresAt', 'auth.api_key_expired');
  }
}
