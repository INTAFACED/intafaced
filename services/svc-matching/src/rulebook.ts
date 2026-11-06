/**
 * Versioned public rulebook door (M00, RC-cex-spot-08). Halt/delist stay on their own doors.
 * The published rulebook is owner-authored text journaled by svc-matching (`rulebook_version` records, published
 * through a two-person approval). No version published is unpublished; nothing here invents rule text, fees, or haircuts.
 * `readRulebook` and the claim guards below read a bare version id (blank is unpublished); best-execution and
 * certified-venue claims refuse either way, since a version id is not evidence for them.
 */
import { createHash } from 'node:crypto';
import { userCopy } from './user-copy.js';

export const RULEBOOK_UNPUBLISHED = 'matching.rulebook_unpublished' as const;
export const BEST_EXECUTION_UNPROVEN = 'matching.best_execution_unproven' as const;
export const CERTIFIED_VENUE_UNPROVEN = 'matching.certified_venue_unproven' as const;

export type RulebookPublication = { readonly published: false } | { readonly published: true; readonly version: string };

export type RulebookRefuse = {
  readonly code: typeof RULEBOOK_UNPUBLISHED;
  readonly message: string;
};

export type ClaimRefuse = {
  readonly allowed: false;
  readonly rejected: { readonly code: string; readonly message: string };
};

export type RulebookPublicView =
  | {
      readonly published: false;
      readonly version: null;
      readonly rejected: RulebookRefuse;
    }
  | {
      readonly published: true;
      readonly version: string;
    };

export function readRulebook(raw: string | null | undefined): RulebookPublication {
  const version = (raw ?? '').trim();
  if (version.length === 0) return { published: false };
  return { published: true, version };
}

export function rulebookUnpublishedRefuse(): RulebookRefuse {
  return { code: RULEBOOK_UNPUBLISHED, message: userCopy(RULEBOOK_UNPUBLISHED) };
}

export function presentRulebook(publication: RulebookPublication): RulebookPublicView {
  if (!publication.published) {
    return { published: false, version: null, rejected: rulebookUnpublishedRefuse() };
  }
  return { published: true, version: publication.version };
}

/** M00-R06: a version string is not best-execution evidence. Unpublished refuses first. */
export function bestExecutionClaim(publication: RulebookPublication): ClaimRefuse {
  if (!publication.published) {
    return { allowed: false, rejected: rulebookUnpublishedRefuse() };
  }
  return {
    allowed: false,
    rejected: { code: BEST_EXECUTION_UNPROVEN, message: userCopy(BEST_EXECUTION_UNPROVEN) },
  };
}

/** M00-R06: a version string is not a certified-venue seal. Unpublished refuses first. */
export function certifiedVenueClaim(publication: RulebookPublication): ClaimRefuse {
  if (!publication.published) {
    return { allowed: false, rejected: rulebookUnpublishedRefuse() };
  }
  return {
    allowed: false,
    rejected: { code: CERTIFIED_VENUE_UNPROVEN, message: userCopy(CERTIFIED_VENUE_UNPROVEN) },
  };
}

/*
 * Published rulebook versions (RC-cex-spot-08, TRD-0555). The text is owner-authored and journaled by svc-matching as
 * `rulebook_version` records; nothing here ships default text. A version is append-only: once published it never
 * changes, and a change is a new version. The journal is the only source of the public rulebook.
 */

export const RULEBOOK_SECTION_UNSET = 'matching.rulebook_section_unset' as const;
export const RULEBOOK_IMMUTABLE = 'matching.rulebook_immutable' as const;
export const RULEBOOK_VERSION_UNSET = 'matching.rulebook_version_unset' as const;
export const RULEBOOK_EFFECTIVE_INVALID = 'matching.rulebook_effective_invalid' as const;
export const RULEBOOK_PUBLISH_ACTION = 'matching.rulebook_publish' as const;

/** The fixed sections, in reading order. A version missing any one refuses `matching.rulebook_section_unset`. */
export const RULEBOOK_SECTIONS = [
  { id: 'participation', title: 'participation' },
  { id: 'matching', title: 'matching' },
  { id: 'cancellation', title: 'cancellation' },
  { id: 'settlement', title: 'settlement' },
  { id: 'liquidation', title: 'liquidation' },
  { id: 'fees', title: 'fees' },
  { id: 'market_data', title: 'market data' },
] as const;

export type RulebookSectionId = (typeof RULEBOOK_SECTIONS)[number]['id'];
export type RulebookSections = Readonly<Record<RulebookSectionId, string>>;

/** Longest section body accepted. Bodies are plain text and are rendered escaped. */
export const RULEBOOK_SECTION_MAX = 20_000;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface RulebookDraftInput {
  readonly version?: unknown;
  /** ISO time the version takes effect. Blank: the moment it is published. */
  readonly effectiveAt?: unknown;
  readonly sections?: unknown;
}

export interface RulebookDraft {
  readonly version: string;
  /** As requested, normalised to ISO; null means "when published". */
  readonly effectiveAt: string | null;
  readonly sections: RulebookSections;
  /** sha256 over the version, the requested effective time and every section, in fixed order. */
  readonly digest: string;
}

export type RulebookRejected = { readonly code: string; readonly message: string };

/** The approval binds this exact draft: a different word in any section needs a new approval. */
export function rulebookDigest(version: string, effectiveAt: string | null, sections: RulebookSections): string {
  const canonical = JSON.stringify({
    version,
    effectiveAt,
    sections: RULEBOOK_SECTIONS.map((s) => [s.id, sections[s.id]]),
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/** Fields the two-person approval is bound to (`matchingActionPayloadHash`), and its target. */
export function rulebookApprovalFields(draft: RulebookDraft): Record<string, string> {
  return { version: draft.version, digest: draft.digest };
}

/** `rulebook_publish:<version>`: the verb before the colon is the action, as on every matching door (`halt:<market>`). */
export function rulebookApprovalTarget(version: string): string {
  return `rulebook_publish:${version}`;
}

/** Read an owner draft. Blank version, any blank section, or an unreadable time refuses by name; nothing is filled in. */
export function readRulebookDraft(
  input: RulebookDraftInput,
): { readonly ok: true; readonly draft: RulebookDraft } | { readonly ok: false; readonly rejected: RulebookRejected } {
  const version = typeof input.version === 'string' ? input.version.trim() : '';
  if (!version) {
    return { ok: false, rejected: { code: RULEBOOK_VERSION_UNSET, message: 'the rulebook version id is blank' } };
  }
  if (!VERSION_RE.test(version)) {
    return {
      ok: false,
      rejected: { code: RULEBOOK_VERSION_UNSET, message: 'the version id is 1 to 64 letters, digits, dots, dashes or underscores' },
    };
  }
  const raw = input.sections && typeof input.sections === 'object' ? (input.sections as Record<string, unknown>) : {};
  const sections = {} as Record<RulebookSectionId, string>;
  for (const s of RULEBOOK_SECTIONS) {
    const body = typeof raw[s.id] === 'string' ? (raw[s.id] as string).trim() : '';
    if (!body) {
      return { ok: false, rejected: { code: RULEBOOK_SECTION_UNSET, message: `the ${s.title} section is blank` } };
    }
    if (body.length > RULEBOOK_SECTION_MAX) {
      return {
        ok: false,
        rejected: { code: RULEBOOK_SECTION_UNSET, message: `the ${s.title} section is longer than ${RULEBOOK_SECTION_MAX} characters` },
      };
    }
    sections[s.id] = body;
  }
  let effectiveAt: string | null = null;
  const rawAt = typeof input.effectiveAt === 'string' ? input.effectiveAt.trim() : '';
  if (rawAt) {
    const ms = Date.parse(rawAt);
    // A time with no zone would be read in this host's zone: the owner states UTC (Z) or an explicit offset.
    if (!Number.isFinite(ms) || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(rawAt)) {
      return {
        ok: false,
        rejected: { code: RULEBOOK_EFFECTIVE_INVALID, message: 'the effective time is not a date and time with Z or an offset' },
      };
    }
    effectiveAt = new Date(ms).toISOString();
  }
  return { ok: true, draft: { version, effectiveAt, sections, digest: rulebookDigest(version, effectiveAt, sections) } };
}

/** One published version, as journaled. */
export interface RulebookVersion {
  readonly version: string;
  readonly effectiveAt: string;
  readonly publishedAt: string;
  /** The version published just before this one, which it replaces; null for the first. */
  readonly supersedes: string | null;
  readonly digest: string;
  readonly sections: RulebookSections;
  readonly operatorId: string;
  readonly confirmOperatorId: string;
  readonly approvalId: string;
}

/**
 * The version in force at `now`: the latest PUBLISHED version whose effective time has come. A later publish replaces
 * every earlier one, a scheduled one included: a scheduled version replaced before its date never takes effect, so a
 * correction can never be overridden by an older schedule. `versions` is in publish order.
 */
export function currentRulebook(versions: readonly RulebookVersion[], now: Date): RulebookVersion | null {
  for (let i = versions.length - 1; i >= 0; i--) {
    if (Date.parse(versions[i]!.effectiveAt) <= now.getTime()) return versions[i]!;
  }
  return null;
}

/** Versions published after the one in force (so not replaced), waiting for their effective time, soonest first. */
function upcomingRulebooks(versions: readonly RulebookVersion[], now: Date): RulebookVersion[] {
  const current = currentRulebook(versions, now);
  const after = current === null ? 0 : versions.indexOf(current) + 1;
  return versions
    .slice(after)
    .filter((v) => Date.parse(v.effectiveAt) > now.getTime())
    .sort((a, b) => Date.parse(a.effectiveAt) - Date.parse(b.effectiveAt));
}

/** `matching.rulebook_immutable`: a published version id never takes other text. */
export function rulebookImmutableRefuse(version: string): RulebookRejected {
  return { code: RULEBOOK_IMMUTABLE, message: `${version} is published and never changes; publish the change as a new version` };
}

/** A version may not take effect before it is published. */
export function rulebookEffectivePast(draft: RulebookDraft, now: Date): RulebookRejected | null {
  if (draft.effectiveAt === null || Date.parse(draft.effectiveAt) >= now.getTime()) return null;
  return { code: RULEBOOK_EFFECTIVE_INVALID, message: 'a version cannot take effect before it is published' };
}

export type RulebookStatus = 'current' | 'upcoming' | 'superseded';

function sectionsView(sections: RulebookSections) {
  return RULEBOOK_SECTIONS.map((s) => ({ id: s.id, title: s.title, body: sections[s.id] }));
}

export type RulebookPublishedView =
  | {
      readonly published: false;
      readonly version: null;
      readonly rejected: RulebookRefuse;
      readonly upcoming: readonly { readonly version: string; readonly effectiveAt: string }[];
    }
  | {
      readonly published: true;
      readonly version: string;
      readonly effectiveAt: string;
      readonly publishedAt: string;
      readonly sections: readonly { readonly id: RulebookSectionId; readonly title: string; readonly body: string }[];
      readonly upcoming: readonly { readonly version: string; readonly effectiveAt: string }[];
    };

/** Public `GET /rulebook`: the version in force with its sections, and any published future version. */
export function presentPublishedRulebook(versions: readonly RulebookVersion[], now: Date): RulebookPublishedView {
  const current = currentRulebook(versions, now);
  const upcoming = upcomingRulebooks(versions, now).map((v) => ({ version: v.version, effectiveAt: v.effectiveAt }));
  if (current === null) return { published: false, version: null, rejected: rulebookUnpublishedRefuse(), upcoming };
  return {
    published: true,
    version: current.version,
    effectiveAt: current.effectiveAt,
    publishedAt: current.publishedAt,
    sections: sectionsView(current.sections),
    upcoming,
  };
}

/** Public `GET /rulebook/versions`: every version, newest publish first, with the sections that changed from the one it superseded. */
export function presentRulebookHistory(versions: readonly RulebookVersion[], now: Date) {
  const current = currentRulebook(versions, now);
  const upcoming = new Set(upcomingRulebooks(versions, now).map((v) => v.version));
  const byVersion = new Map(versions.map((v) => [v.version, v]));
  return {
    current: current?.version ?? null,
    versions: [...versions].reverse().map((v) => {
      const previous = v.supersedes === null ? null : (byVersion.get(v.supersedes) ?? null);
      const status: RulebookStatus =
        current !== null && v.version === current.version ? 'current' : upcoming.has(v.version) ? 'upcoming' : 'superseded';
      return {
        version: v.version,
        status,
        effectiveAt: v.effectiveAt,
        publishedAt: v.publishedAt,
        supersedes: v.supersedes,
        changedSections: RULEBOOK_SECTIONS.filter((s) => previous === null || previous.sections[s.id] !== v.sections[s.id]).map(
          (s) => s.id,
        ),
        sections: sectionsView(v.sections),
      };
    }),
  };
}
