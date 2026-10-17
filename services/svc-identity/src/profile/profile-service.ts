/**
 * Customer profile edit.
 *
 * The user id comes from the session. A body user id is ignored. `region`
 * drives jurisdiction lookups and is not editable here. `version` is a
 * compare-and-set: a stale `ifVersion` changes nothing and returns the row
 * that is current.
 */
import { transaction } from '@intafaced/db';
import { SUPPORTED_LOCALES } from '@intafaced/i18n';
import type { Sql } from 'postgres';
import { userCopy } from '../user-copy.js';

const SUPPORTED = new Set<string>(SUPPORTED_LOCALES.map((locale) => locale.code));

/** Control, zero-width, and bidi marks. A display name must not carry them. */
const HIDDEN = /[\u0000-\u001F\u007F-\u009F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u;

export type ProfileRow = {
  readonly displayName: string | null;
  readonly locale: string;
  readonly region: string | null;
  readonly version: number;
};

export type ProfileCode =
  | 'identity.region_change_requires_review'
  | 'identity.profile_version_conflict'
  | 'identity.display_name_invalid'
  | 'identity.handle_impersonation'
  | 'identity.locale_unsupported'
  | 'identity.profile_no_change'
  | 'identity.profile_missing'
  | 'identity.delegated_refused'
  | 'identity.profile_unwired';

export class ProfileError extends Error {
  readonly profile?: ProfileRow;

  constructor(code: ProfileCode, profile?: ProfileRow) {
    super(userCopy(code));
    this.name = 'ProfileError';
    this.code = code;
    this.profile = profile;
  }

  readonly code: ProfileCode;
}

type StoredProfile = {
  display_name: string | null;
  locale: string;
  region: string | null;
  version: number;
};

function view(row: StoredProfile): ProfileRow {
  return {
    displayName: row.display_name,
    locale: row.locale,
    region: row.region,
    version: Number(row.version),
  };
}

/**
 * NFC, trimmed, 1 to 60 code points, no control / zero-width / bidi characters.
 * Returns null when the name is not acceptable.
 */
export function normaliseDisplayName(raw: string): string | null {
  const name = raw.normalize('NFC').trim();
  const length = Array.from(name).length;
  if (length < 1 || length > 60) return null;
  if (HIDDEN.test(name)) return null;
  return name;
}

export function isSupportedLocale(locale: string): boolean {
  return SUPPORTED.has(locale);
}

export class ProfileService {
  constructor(private readonly sql: Sql) {}

  async get(userId: string): Promise<ProfileRow> {
    const rows = await this.sql<StoredProfile[]>`
      SELECT display_name, locale, region, version FROM profiles WHERE user_id = ${userId}
    `;
    const row = rows[0];
    if (!row) throw new ProfileError('identity.profile_missing');
    return view(row);
  }

  async update(input: {
    readonly userId: string;
    readonly sessionId: string;
    readonly displayName?: string;
    readonly locale?: string;
    readonly region?: string;
    readonly ifVersion: number;
  }): Promise<ProfileRow> {
    if (input.region !== undefined) throw new ProfileError('identity.region_change_requires_review');
    const nextName = input.displayName === undefined ? undefined : normaliseDisplayName(input.displayName);
    if (input.displayName !== undefined && nextName === null) throw new ProfileError('identity.display_name_invalid');
    if (input.locale !== undefined && !isSupportedLocale(input.locale)) throw new ProfileError('identity.locale_unsupported');

    return transaction(
      this.sql,
      async (tx) => {
        const locked = await tx<StoredProfile[]>`
          SELECT display_name, locale, region, version FROM profiles WHERE user_id = ${input.userId} FOR UPDATE
        `;
        const row = locked[0];
        if (!row) throw new ProfileError('identity.profile_missing');
        const current = view(row);
        if (current.version !== input.ifVersion) throw new ProfileError('identity.profile_version_conflict', current);

        const nameChanged = nextName !== undefined && nextName !== row.display_name;
        const localeChanged = input.locale !== undefined && input.locale !== row.locale;
        if (!nameChanged && !localeChanged) throw new ProfileError('identity.profile_no_change');

        if (nameChanged && nextName !== undefined) {
          const clash = await tx<Array<{ id: string }>>`
            SELECT id FROM users WHERE handle = ${nextName} AND id <> ${input.userId} LIMIT 1
          `;
          if (clash[0]) throw new ProfileError('identity.handle_impersonation');
        }

        const displayName = nextName === undefined ? row.display_name : nextName;
        const locale = input.locale === undefined ? row.locale : input.locale;
        const fields: string[] = [];
        if (nameChanged) fields.push('displayName');
        if (localeChanged) fields.push('locale');

        const updated = await tx<StoredProfile[]>`
          UPDATE profiles
          SET display_name = ${displayName}, locale = ${locale}, version = version + 1, updated_at = now()
          WHERE user_id = ${input.userId} AND version = ${current.version}
          RETURNING display_name, locale, region, version
        `;
        const next = updated[0];
        if (!next) {
          const again = await tx<StoredProfile[]>`
            SELECT display_name, locale, region, version FROM profiles WHERE user_id = ${input.userId}
          `;
          throw new ProfileError('identity.profile_version_conflict', again[0] ? view(again[0]) : current);
        }
        await tx`
          INSERT INTO profile_audit (user_id, session_id, fields, old_display_name, new_display_name, old_locale, new_locale)
          VALUES (
            ${input.userId}, ${input.sessionId}, ${fields},
            ${row.display_name}, ${next.display_name}, ${row.locale}, ${next.locale}
          )
        `;
        return view(next);
      },
      { isolation: 'read committed', maxAttempts: 1 },
    );
  }
}
