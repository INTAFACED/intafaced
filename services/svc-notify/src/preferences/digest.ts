/**
 * Notify L3 — digest cadence residual (TRK-ops.notifications).
 *
 * Product: users may batch non-critical out-of-app traffic into digests.
 * Critical never digests — always immediate when a target exists (same as mute law).
 *
 * No Class X gateway work. No invent of send timestamps as "delivered".
 */

import type { NotifySeverity } from './mute.js';
import { inQuietHours, quietReleaseUtc, type QuietWindow } from './quiet-hours.js';

export type DigestCadence = 'off' | 'hourly' | 'daily';

export type DigestPrefs = {
  readonly cadence: DigestCadence;
};

export const DEFAULT_DIGEST_PREFS: DigestPrefs = { cadence: 'off' };

export type DigestErrorCode = 'preference.invalid_cadence' | 'preference.critical_no_digest';

export class DigestError extends Error {
  constructor(
    message: string,
    readonly code: DigestErrorCode,
  ) {
    super(message);
    this.name = 'DigestError';
  }
}

const CADENCES: readonly DigestCadence[] = ['off', 'hourly', 'daily'];

export function assertDigestCadence(raw: string): DigestCadence {
  if ((CADENCES as readonly string[]).includes(raw)) return raw as DigestCadence;
  throw new DigestError(`Invalid digest cadence "${raw}" (use off|hourly|daily)`, 'preference.invalid_cadence');
}

export function applyDigestCadence(_current: DigestPrefs, raw: string): DigestPrefs {
  return { cadence: assertDigestCadence(raw) };
}

/**
 * Should this notification go immediately vs hold for digest batch?
 * Critical → always immediate. Cadence off → always immediate.
 */
export function shouldSendImmediate(prefs: DigestPrefs, severity: NotifySeverity): boolean {
  if (severity === 'critical') return true;
  return prefs.cadence === 'off';
}

/**
 * Pure: may this severity enter a digest bucket?
 * Critical must never be held — refuse invent silent digests of margin alerts.
 */
export function mayEnterDigest(severity: NotifySeverity): boolean {
  return severity !== 'critical';
}

export function assertMayDigest(severity: NotifySeverity): void {
  if (!mayEnterDigest(severity)) {
    throw new DigestError('Critical notifications cannot enter a digest — send immediate', 'preference.critical_no_digest');
  }
}

/** Window length for cadence (ms). off → 0 (no hold). */
export function digestWindowMs(cadence: DigestCadence): number {
  switch (cadence) {
    case 'off':
      return 0;
    case 'hourly':
      return 3_600_000;
    case 'daily':
      return 86_400_000;
  }
}

/**
 * Decide whether a held batch is ready to flush.
 * lastFlushAt null → first flush only after window if items exist (caller owns items).
 */
export function isDigestFlushDue(input: { cadence: DigestCadence; lastFlushAt: Date | null; now?: Date }): boolean {
  if (input.cadence === 'off') return false;
  const window = digestWindowMs(input.cadence);
  const now = (input.now ?? new Date()).getTime();
  if (!input.lastFlushAt) return true; // never flushed — due if any items (caller checks)
  return now - input.lastFlushAt.getTime() >= window;
}

/**
 * L3 — whether cadence holds non-critical messages. off → false (no invent hold).
 */
export function isDigestHolding(cadence: DigestCadence): boolean {
  return cadence !== 'off';
}

/**
 * L3 — holding cadences only (excludes off). Stable list for operator UI.
 */
export function holdingDigestCadences(): readonly DigestCadence[] {
  return ['hourly', 'daily'];
}

/** In-memory digest prefs for tests / Stage process store. */
export class MemoryDigestStore {
  private readonly byUser = new Map<string, DigestCadence>();

  get(userId: string): DigestPrefs {
    return { cadence: this.byUser.get(userId) ?? 'off' };
  }

  setCadence(userId: string, raw: string): DigestPrefs {
    const next = applyDigestCadence(this.get(userId), raw);
    this.byUser.set(userId, next.cadence);
    return next;
  }
}

/** L3 — all cadences in stable order. */
export function allDigestCadences(): readonly DigestCadence[] {
  return ['off', 'hourly', 'daily'];
}

/** L3 — true when cadence is off. */
export function isDigestOff(cadence: DigestCadence): boolean {
  return cadence === 'off';
}

/** L3 — true when cadence is daily. */
export function isDigestDaily(cadence: DigestCadence): boolean {
  return cadence === 'daily';
}

/** L3 — true when cadence is hourly. */
export function isDigestHourly(cadence: DigestCadence): boolean {
  return cadence === 'hourly';
}

/** L3 — window ms label string. */
export function digestWindowMsLabel(cadence: DigestCadence): string {
  return String(digestWindowMs(cadence));
}

/** L3 — digest board card. */
export function digestBoardCard(prefs: DigestPrefs): {
  readonly cadence: DigestCadence;
  readonly holding: boolean;
  readonly off: boolean;
  readonly hourly: boolean;
  readonly daily: boolean;
  readonly windowMs: number;
  readonly windowLabel: string;
} {
  return {
    cadence: prefs.cadence,
    holding: isDigestHolding(prefs.cadence),
    off: isDigestOff(prefs.cadence),
    hourly: isDigestHourly(prefs.cadence),
    daily: isDigestDaily(prefs.cadence),
    windowMs: digestWindowMs(prefs.cadence),
    windowLabel: digestWindowMsLabel(prefs.cadence),
  };
}

/** L3 — digest export line cadence,windowMs. */
export function digestExportLine(prefs: DigestPrefs): string {
  return `${prefs.cadence},${digestWindowMs(prefs.cadence)}`;
}

/** L3 — digest export header. */
export function digestExportHeader(): string {
  return 'cadence,windowMs';
}

/** L3 — full digest export text. */
export function digestExportText(prefs: DigestPrefs): string {
  return [digestExportHeader(), digestExportLine(prefs)].join('\n');
}

/** L3 — parse digest export line. Invalid → null. */
export function parseDigestExportLine(line: string): { readonly cadence: DigestCadence; readonly windowMs: number } | null {
  const t = line.trim();
  if (!t || t === digestExportHeader()) return null;
  const parts = t.split(',');
  if (parts.length !== 2) return null;
  const cadence = parts[0]!.trim();
  const windowMs = Number(parts[1]);
  if (cadence !== 'off' && cadence !== 'hourly' && cadence !== 'daily') return null;
  if (!Number.isFinite(windowMs) || windowMs < 0) return null;
  return { cadence, windowMs: Math.floor(windowMs) };
}

/** L3 — data-line count in digest export (excludes header). */
export function countDigestExportDataLines(text: string): number {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== digestExportHeader()).length;
}

/** L3 — true when text starts with digest export header. */
export function digestExportHasHeader(text: string): boolean {
  const first = text.split('\n')[0]?.trim() ?? '';
  return first === digestExportHeader();
}

/** L3 — round-trip: 1 header + 1 data line. */
export function digestExportRoundTripOk(prefs: DigestPrefs): boolean {
  const text = digestExportText(prefs);
  return text.split('\n').filter(Boolean).length === 1 + countDigestExportDataLines(text);
}

/** L3 — digest status line cadence=X windowMs=N. */
export function digestStatusLine(prefs: DigestPrefs): string {
  return `cadence=${prefs.cadence} windowMs=${digestWindowMs(prefs.cadence)}`;
}

/** L3 — true when cadence is off. */
export function digestStatusLineIsOff(prefs: DigestPrefs): boolean {
  return prefs.cadence === 'off';
}

/** L3 — detailed digest status. */
export function digestStatusLineDetailed(prefs: DigestPrefs): string {
  const c = digestBoardCard(prefs);
  return `cadence=${c.cadence} windowMs=${c.windowMs} holding=${c.holding ? '1' : '0'} off=${c.off ? '1' : '0'}`;
}

/** L3 — token count on detailed digest status. */
export function digestStatusLineTokenCount(prefs: DigestPrefs): number {
  return digestStatusLineDetailed(prefs).split(/\s+/).filter(Boolean).length;
}

/** L3 — parse digest status line. Invalid → null. */
export function parseDigestStatusLine(line: string): { readonly cadence: DigestCadence; readonly windowMs: number } | null {
  const m = line.trim().match(/^cadence=(off|hourly|daily) windowMs=(\d+)$/);
  if (!m) return null;
  return { cadence: m[1] as DigestCadence, windowMs: Number(m[2]) };
}

/** L3 — true when status line matches prefs. */
export function digestStatusLineMatches(prefs: DigestPrefs): boolean {
  const p = parseDigestStatusLine(digestStatusLine(prefs));
  if (!p) return false;
  return p.cadence === prefs.cadence && p.windowMs === digestWindowMs(prefs.cadence);
}

/** L3 — true when windowMs matches cadence law. */
export type DigestMode = 'immediate' | 'hourly' | 'daily';

const DIGEST_MODES: readonly DigestMode[] = ['immediate', 'hourly', 'daily'];

export function assertDigestMode(raw: string): DigestMode {
  if ((DIGEST_MODES as readonly string[]).includes(raw)) return raw as DigestMode;
  throw new DigestError('notify.digest_mode_unknown', 'preference.invalid_cadence');
}

/**
 * When a non-critical notice should wait for the next summary.
 * Null means send now. Critical is always null. An unset quiet window does
 * not invent one. Hourly and daily boundaries are UTC. A boundary that would
 * fall inside quiet hours waits until that window ends.
 */
export function holdUntilFor(input: { mode: DigestMode; quiet: QuietWindow | null; severity: NotifySeverity; now: Date }): Date | null {
  if (input.severity === 'critical') return null;
  if (input.quiet) {
    const quietEnd = quietReleaseUtc(input.now, input.quiet);
    if (quietEnd) return quietEnd;
  }
  if (input.mode === 'immediate') return null;
  let boundary = nextUtcBoundary(input.now, input.mode);
  if (input.quiet && inQuietHours(boundary, input.quiet)) {
    const extended = quietReleaseUtc(boundary, input.quiet);
    if (extended) boundary = extended;
  }
  return boundary;
}

function nextUtcBoundary(now: Date, mode: 'hourly' | 'daily'): Date {
  const step = mode === 'hourly' ? 3_600_000 : 86_400_000;
  const time = now.getTime();
  return new Date(Math.floor(time / step) * step + step);
}

/** How often the process looks for summaries that are due. Not a user window. */
export const DIGEST_RELEASE_INTERVAL_MS = 60_000;

export function digestStatusLineConsistent(line: string): boolean {
  const p = parseDigestStatusLine(line);
  if (!p) return false;
  return p.windowMs === digestWindowMs(p.cadence);
}

/** L3 — true when windowMs is within [min,max]. Invalid → false. */
export function digestWindowInRange(prefs: DigestPrefs, min: number, max: number): boolean {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return false;
  const w = digestWindowMs(prefs.cadence);
  return w >= min && w <= max;
}
