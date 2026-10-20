/**
 * Versioned risk agreements and margin terms of use (D-account-07).
 *
 * The ADL disclosure ack (`adl-disclosure.ts`) is the pattern: a versioned document, a durable acknowledgement
 * per user, and a gate in front of a futures open. This is the same shape with three differences the spec asks for:
 *
 *   - the text is the owner's, per jurisdiction. Nothing here carries agreement wording, and a jurisdiction with no
 *     published text is refused (`trade.agreement_region_unavailable`), not shown a default;
 *   - a version is published once and never edited; a change is a new version, and old acceptances stay linked to
 *     the version (and the exact jurisdiction text id) the user saw;
 *   - acceptance is idempotent on (user, kind, version): a repeat keeps the first row and its time.
 *
 * Opening a position needs the current version of each required kind accepted. Closing or reducing is a safety path
 * and never reaches this gate. No money moves here and no ledger recipe is imported.
 */

import type { Sql } from 'postgres';

export const AGREEMENT_KINDS = ['derivatives_risk', 'margin_terms'] as const;
export type AgreementKind = (typeof AGREEMENT_KINDS)[number];

export function isAgreementKind(value: unknown): value is AgreementKind {
  return typeof value === 'string' && (AGREEMENT_KINDS as readonly string[]).includes(value);
}

export const AGREEMENT_REQUIRED = 'trade.agreement_required' as const;
export const AGREEMENT_UNPUBLISHED = 'trade.agreement_unpublished' as const;
export const AGREEMENT_REGION_UNAVAILABLE = 'trade.agreement_region_unavailable' as const;
export const AGREEMENT_VERSION_STALE = 'trade.agreement_version_stale' as const;
export const AGREEMENT_KIND_UNKNOWN = 'trade.agreement_kind_unknown' as const;

export type AgreementRefusalCode =
  | typeof AGREEMENT_REQUIRED
  | typeof AGREEMENT_UNPUBLISHED
  | typeof AGREEMENT_REGION_UNAVAILABLE
  | typeof AGREEMENT_VERSION_STALE
  | typeof AGREEMENT_KIND_UNKNOWN;

/** The stable id of one jurisdiction text of one version. Stored on every acceptance. */
export function agreementTextId(kind: AgreementKind, version: number, region: string): string {
  return `${kind}:v${version}:${region}`;
}

/** Edge regions are compared upper-case. A blank or missing region matches nothing. */
export function normalizeRegion(region: string | null | undefined): string | null {
  const text = (region ?? '').trim().toUpperCase();
  return text === '' ? null : text;
}

export interface AgreementText {
  readonly region: string;
  readonly textId: string;
  readonly title: string;
  readonly body: string;
  readonly bodySha256: string;
}

export interface AgreementVersion {
  readonly kind: AgreementKind;
  readonly version: number;
  readonly publishedAt: Date;
  readonly texts: readonly AgreementText[];
}

export interface AgreementAcceptance {
  readonly userId: string;
  readonly kind: AgreementKind;
  readonly version: number;
  readonly region: string;
  readonly textId: string;
  readonly acceptedAt: Date;
}

export interface RiskAgreementStore {
  /** The highest published version of the kind, with every jurisdiction text. Null: nothing published. */
  current(kind: AgreementKind): Promise<AgreementVersion | null>;
  getAcceptance(userId: string, kind: AgreementKind, version: number): Promise<AgreementAcceptance | null>;
  /** Insert, or return the row that is already there. `created` is false on a repeat. */
  recordAcceptance(row: AgreementAcceptance): Promise<{ acceptance: AgreementAcceptance; created: boolean }>;
}

export class AgreementError extends Error {
  readonly status: number;

  constructor(
    readonly code: AgreementRefusalCode,
    message: string,
    /** Extra wire fields: the document id, the version, the region. Never agreement text. */
    readonly detail: Readonly<Record<string, unknown>> = {},
    status?: number,
  ) {
    super(message);
    this.name = 'AgreementError';
    this.status = status ?? (code === AGREEMENT_VERSION_STALE ? 409 : code === AGREEMENT_KIND_UNKNOWN ? 400 : 403);
  }
}

/** The text a region is shown, or the typed refusal that says why there is none. */
export function resolveAgreementText(
  version: AgreementVersion | null,
  kind: AgreementKind,
  region: string | null,
): { version: AgreementVersion; text: AgreementText } {
  if (!version) {
    throw new AgreementError(AGREEMENT_UNPUBLISHED, 'No agreement has been published for this product yet, so it cannot be opened.', {
      kind,
    });
  }
  const normalized = normalizeRegion(region);
  const text = normalized ? version.texts.find((t) => t.region === normalized) : undefined;
  if (!text) {
    throw new AgreementError(AGREEMENT_REGION_UNAVAILABLE, 'This product is not available in your region.', {
      kind,
      version: version.version,
      region: normalized,
    });
  }
  return { version, text };
}

export type AgreementView =
  | {
      readonly kind: AgreementKind;
      readonly available: true;
      readonly version: number;
      readonly textId: string;
      readonly region: string;
      readonly title: string;
      readonly body: string;
      readonly accepted: boolean;
      readonly acceptedAt: string | null;
    }
  | {
      readonly kind: AgreementKind;
      readonly available: false;
      readonly reason: typeof AGREEMENT_UNPUBLISHED | typeof AGREEMENT_REGION_UNAVAILABLE;
      readonly message: string;
    };

/** What the customer reads for one kind in their region. A refusal is data here, so a page can render it. */
export async function readAgreementView(
  store: RiskAgreementStore,
  userId: string,
  kind: AgreementKind,
  region: string | null,
): Promise<AgreementView> {
  try {
    const { version, text } = resolveAgreementText(await store.current(kind), kind, region);
    const acceptance = await store.getAcceptance(userId, kind, version.version);
    return {
      kind,
      available: true,
      version: version.version,
      textId: text.textId,
      region: text.region,
      title: text.title,
      body: text.body,
      accepted: acceptance != null,
      acceptedAt: acceptance ? acceptance.acceptedAt.toISOString() : null,
    };
  } catch (err) {
    if (err instanceof AgreementError && (err.code === AGREEMENT_UNPUBLISHED || err.code === AGREEMENT_REGION_UNAVAILABLE)) {
      return { kind, available: false, reason: err.code, message: err.message };
    }
    throw err;
  }
}

export interface AcceptAgreementResult {
  readonly kind: AgreementKind;
  readonly version: number;
  readonly textId: string;
  readonly region: string;
  readonly acceptedAt: string;
  /** False when this (user, kind, version) was already accepted: the first row stands. */
  readonly created: boolean;
}

/**
 * Accept the current version. The caller names the version they read: a stale version refuses
 * `trade.agreement_version_stale` instead of recording acceptance of a document the user did not see.
 */
export async function acceptAgreement(
  store: RiskAgreementStore,
  input: { userId: string; kind: unknown; version: unknown; region: string | null; now: Date },
): Promise<AcceptAgreementResult> {
  if (!isAgreementKind(input.kind)) {
    throw new AgreementError(AGREEMENT_KIND_UNKNOWN, `kind must be one of ${AGREEMENT_KINDS.join(', ')}`);
  }
  const kind = input.kind;
  const { version, text } = resolveAgreementText(await store.current(kind), kind, input.region);
  if (typeof input.version !== 'number' || !Number.isInteger(input.version) || input.version !== version.version) {
    throw new AgreementError(AGREEMENT_VERSION_STALE, 'A newer version of this document is current. Read it before accepting.', {
      kind,
      currentVersion: version.version,
    });
  }
  const { acceptance, created } = await store.recordAcceptance({
    userId: input.userId,
    kind,
    version: version.version,
    region: text.region,
    textId: text.textId,
    acceptedAt: input.now,
  });
  return {
    kind,
    version: acceptance.version,
    textId: acceptance.textId,
    region: acceptance.region,
    acceptedAt: acceptance.acceptedAt.toISOString(),
    created,
  };
}

/**
 * Gate for a futures open: every required kind must be published for the region and the current version accepted.
 * Refuses with the document id (kind, version, text id) so a client can send the user to the right page.
 */
export async function assertAgreementsAccepted(
  store: RiskAgreementStore,
  input: { userId: string; kinds: readonly AgreementKind[]; region: string | null },
): Promise<void> {
  for (const kind of input.kinds) {
    const { version, text } = resolveAgreementText(await store.current(kind), kind, input.region);
    const acceptance = await store.getAcceptance(input.userId, kind, version.version);
    if (!acceptance) {
      throw new AgreementError(AGREEMENT_REQUIRED, 'Accept the current agreement before opening a position.', {
        kind,
        version: version.version,
        documentId: text.textId,
      });
    }
  }
}

/** In-memory store for hermetic tests. `publish` is a test seam; production publishes through the operator door. */
export function memoryRiskAgreementStore(): RiskAgreementStore & {
  publish(version: AgreementVersion): void;
  accepted(): AgreementAcceptance[];
} {
  const versions = new Map<AgreementKind, AgreementVersion[]>();
  const acceptances = new Map<string, AgreementAcceptance>();
  const key = (userId: string, kind: AgreementKind, version: number) => `${userId}|${kind}|${version}`;
  return {
    publish(version) {
      versions.set(version.kind, [...(versions.get(version.kind) ?? []), version]);
    },
    accepted: () => [...acceptances.values()],
    async current(kind) {
      const list = versions.get(kind) ?? [];
      return list.reduce<AgreementVersion | null>((best, v) => (best === null || v.version > best.version ? v : best), null);
    },
    async getAcceptance(userId, kind, version) {
      return acceptances.get(key(userId, kind, version)) ?? null;
    },
    async recordAcceptance(row) {
      const k = key(row.userId, row.kind, row.version);
      const existing = acceptances.get(k);
      if (existing) return { acceptance: existing, created: false };
      acceptances.set(k, row);
      return { acceptance: row, created: true };
    },
  };
}

interface AcceptanceRow {
  user_id: string;
  kind: AgreementKind;
  version: number;
  region: string;
  text_id: string;
  accepted_at: Date;
}

function acceptanceOf(row: AcceptanceRow): AgreementAcceptance {
  return {
    userId: row.user_id,
    kind: row.kind,
    version: row.version,
    region: row.region,
    textId: row.text_id,
    acceptedAt: row.accepted_at,
  };
}

/** Durable store over `trade.risk_agreement_*` (migration 0082). */
export function sqlRiskAgreementStore(sql: Sql): RiskAgreementStore {
  return {
    async current(kind) {
      const [head] = await sql<{ version: number; published_at: Date }[]>`
        SELECT version::int AS version, published_at
          FROM trade.risk_agreement_versions
         WHERE kind = ${kind}
         ORDER BY version DESC
         LIMIT 1`;
      if (!head) return null;
      const texts = await sql<{ region: string; text_id: string; title: string; body: string; body_sha256: string }[]>`
        SELECT region, text_id, title, body, body_sha256
          FROM trade.risk_agreement_texts
         WHERE kind = ${kind} AND version = ${head.version}
         ORDER BY region`;
      return {
        kind,
        version: head.version,
        publishedAt: head.published_at,
        texts: texts.map((t) => ({ region: t.region, textId: t.text_id, title: t.title, body: t.body, bodySha256: t.body_sha256 })),
      };
    },
    async getAcceptance(userId, kind, version) {
      const [row] = await sql<AcceptanceRow[]>`
        SELECT user_id::text, kind, version::int AS version, region, text_id, accepted_at
          FROM trade.risk_agreement_acceptances
         WHERE user_id = ${userId} AND kind = ${kind} AND version = ${version}`;
      return row ? acceptanceOf(row) : null;
    },
    async recordAcceptance(row) {
      const inserted = await sql<AcceptanceRow[]>`
        INSERT INTO trade.risk_agreement_acceptances (user_id, kind, version, region, text_id, accepted_at)
        VALUES (${row.userId}, ${row.kind}, ${row.version}, ${row.region}, ${row.textId}, ${row.acceptedAt})
        ON CONFLICT (user_id, kind, version) DO NOTHING
        RETURNING user_id::text, kind, version::int AS version, region, text_id, accepted_at`;
      if (inserted[0]) return { acceptance: acceptanceOf(inserted[0]), created: true };
      const [existing] = await sql<AcceptanceRow[]>`
        SELECT user_id::text, kind, version::int AS version, region, text_id, accepted_at
          FROM trade.risk_agreement_acceptances
         WHERE user_id = ${row.userId} AND kind = ${row.kind} AND version = ${row.version}`;
      return { acceptance: acceptanceOf(existing!), created: false };
    },
  };
}
