/**
 * Stored risk-disclosure acceptance (TRD-0773).
 *
 * The wording is owner content on `TRADE_COPY_DISCLOSURE_LAW`. This module
 * stores who accepted which version and returns that text. It never composes
 * a sentence and never substitutes a placeholder when the law is unset.
 */

import { CopyError } from './errors.js';
import type { CopyDisclosureAcceptance, CopyFollowStore } from './follow-store.js';

export const COPY_DISCLOSURE_LAW_KEY = 'TRADE_COPY_DISCLOSURE_LAW';

export type CopyDisclosureLaw =
  { readonly published: false } | { readonly published: true; readonly version: string; readonly text: string };

export const UNPUBLISHED_COPY_DISCLOSURE_LAW: CopyDisclosureLaw = { published: false };

export type CopyDisclosureView = {
  readonly published: boolean;
  readonly version: string | null;
  readonly text: string | null;
  readonly accepted: boolean;
};

export const UNPUBLISHED_COPY_DISCLOSURE_VIEW: CopyDisclosureView = {
  published: false,
  version: null,
  text: null,
  accepted: false,
};

/** Wire record. The caller's own acceptance only — no leader fields. */
export type CopyDisclosureAcceptanceRecord = {
  readonly version: string;
  readonly acceptedAt: string;
  readonly clientAcceptId: string;
};

const DISCLOSURE_KEYS = ['published', 'version', 'text', 'accepted'] as const;
const ACCEPTANCE_KEYS = ['version', 'acceptedAt', 'clientAcceptId'] as const;

function allow<T extends object>(value: T, keys: readonly string[]): T {
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = (value as Record<string, unknown>)[key];
  return out as T;
}

/**
 * Empty / whitespace → unpublished. Invalid JSON or a published object missing
 * version or text throws. Never invents either field.
 */
export function parseCopyDisclosureLawJson(raw: string | null | undefined): CopyDisclosureLaw {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return UNPUBLISHED_COPY_DISCLOSURE_LAW;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new CopyError(`${COPY_DISCLOSURE_LAW_KEY} is not valid JSON`, 'trade.copy_disclosure_unpublished');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CopyError(`${COPY_DISCLOSURE_LAW_KEY} must be an object`, 'trade.copy_disclosure_unpublished');
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.published === false) return UNPUBLISHED_COPY_DISCLOSURE_LAW;
  if (obj.published !== true) {
    throw new CopyError(`${COPY_DISCLOSURE_LAW_KEY}.published must be true or false`, 'trade.copy_disclosure_unpublished');
  }
  if (typeof obj.version !== 'string' || obj.version.trim() === '') {
    throw new CopyError(`${COPY_DISCLOSURE_LAW_KEY}.version is unset`, 'trade.copy_disclosure_unpublished');
  }
  if (typeof obj.text !== 'string' || obj.text.trim() === '') {
    throw new CopyError(`${COPY_DISCLOSURE_LAW_KEY}.text is unset`, 'trade.copy_disclosure_unpublished');
  }

  return { published: true, version: obj.version.trim(), text: obj.text };
}

export function presentCopyDisclosure(law: CopyDisclosureLaw, acceptance: CopyDisclosureAcceptance | null): CopyDisclosureView {
  if (law.published !== true) return UNPUBLISHED_COPY_DISCLOSURE_VIEW;
  return allow(
    {
      published: true,
      version: law.version,
      text: law.text,
      accepted: acceptance !== null && acceptance.version === law.version,
    },
    DISCLOSURE_KEYS,
  );
}

export function presentCopyDisclosureAcceptance(row: CopyDisclosureAcceptance): CopyDisclosureAcceptanceRecord {
  return allow(
    {
      version: row.version,
      acceptedAt: row.acceptedAt.toISOString(),
      clientAcceptId: row.clientAcceptId,
    },
    ACCEPTANCE_KEYS,
  );
}

function requirePublishedDisclosure(law: CopyDisclosureLaw | null | undefined): Extract<CopyDisclosureLaw, { published: true }> {
  if (!law || law.published !== true) {
    throw new CopyError(COPY_DISCLOSURE_LAW_KEY, 'trade.copy_disclosure_unpublished');
  }
  return law;
}

export async function readCopyDisclosure(law: CopyDisclosureLaw, store: CopyFollowStore, followerId: string): Promise<CopyDisclosureView> {
  if (law.published !== true) return UNPUBLISHED_COPY_DISCLOSURE_VIEW;
  const row = await store.getDisclosureAcceptance(followerId, law.version);
  return presentCopyDisclosure(law, row);
}

export async function acceptCopyDisclosure(
  law: CopyDisclosureLaw,
  store: CopyFollowStore,
  followerId: string,
  input: { version: string; clientAcceptId: string },
  now: Date,
): Promise<CopyDisclosureAcceptanceRecord> {
  const published = requirePublishedDisclosure(law);
  const version = input.version.trim();
  const clientAcceptId = input.clientAcceptId.trim();
  if (!clientAcceptId) {
    throw new CopyError('clientAcceptId is unset', 'trade.copy_envelope_invalid');
  }
  if (!version || version !== published.version) {
    throw new CopyError('trade.copy_disclosure_version_stale', 'trade.copy_disclosure_version_stale');
  }
  const stored = await store.acceptDisclosure({
    followerId,
    version: published.version,
    acceptedAt: now,
    clientAcceptId,
  });
  return presentCopyDisclosureAcceptance(stored);
}

/** The gate for every mirror, and for startFollow before a follow is written (CB-copy-04). */
export async function requireCopyDisclosureForMirror(law: CopyDisclosureLaw, store: CopyFollowStore, followerId: string): Promise<void> {
  const published = requirePublishedDisclosure(law);
  const row = await store.getDisclosureAcceptance(followerId, published.version);
  if (!row) {
    throw new CopyError('trade.copy_disclosure_required', 'trade.copy_disclosure_required');
  }
}
