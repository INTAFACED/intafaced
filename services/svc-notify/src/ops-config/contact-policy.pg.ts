/** Postgres contact policy store. Versions are appended under a lock; the trigger in 0024 refuses an edit or delete. */

import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { OpsConfigError } from './four-eyes.js';
import {
  CONTACT_CHANNELS,
  type ContactChannel,
  type ContactPolicyCopy,
  type ContactPolicyRow,
  type ContactPolicyStore,
} from './contact-policy.js';

type Pg = {
  version: number;
  official_domains: string[];
  never_ask_statement: string;
  contact_channels: string[];
  sms_carries_links: boolean;
  phishing_report: string;
  author_id: string;
  approval_id: string;
  created_at: Date;
};

function asChannels(values: string[]): ContactChannel[] {
  if (values.some((v) => !(CONTACT_CHANNELS as readonly string[]).includes(v)))
    throw new OpsConfigError('notify.contact_policy_channel_unknown');
  return values as ContactChannel[];
}

function fromPg(row: Pg): ContactPolicyRow {
  return {
    version: row.version,
    officialDomains: row.official_domains,
    neverAskStatement: row.never_ask_statement,
    contactChannels: asChannels(row.contact_channels),
    smsCarriesLinks: row.sms_carries_links,
    phishingReport: row.phishing_report,
    authorId: row.author_id,
    approvalId: row.approval_id,
    createdAt: row.created_at,
  };
}

const COLUMNS =
  'version, official_domains, never_ask_statement, contact_channels, sms_carries_links, phishing_report, author_id, approval_id, created_at';

export class PostgresContactPolicyStore implements ContactPolicyStore {
  constructor(private readonly sql: Sql) {}

  async latest(): Promise<ContactPolicyRow | null> {
    const [row] = await this.sql<Pg[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM notify.contact_policy_versions ORDER BY version DESC LIMIT 1
    `;
    return row ? fromPg(row) : null;
  }

  async append(
    input: ContactPolicyCopy & { authorId: string; approvalId: string; now: Date },
  ): Promise<{ status: 'inserted'; row: ContactPolicyRow } | { status: 'exists' }> {
    return transaction(this.sql, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('notify.contact_policy_versions'))`;
      const used = await tx`SELECT 1 FROM notify.contact_policy_versions WHERE approval_id = ${input.approvalId}`;
      if (used.length > 0) return { status: 'exists' as const };
      const [last] = await tx<{ version: number | null }[]>`SELECT max(version) AS version FROM notify.contact_policy_versions`;
      const version = (last?.version ?? 0) + 1;
      const [row] = await tx<Pg[]>`
        INSERT INTO notify.contact_policy_versions (
          version, official_domains, never_ask_statement, contact_channels, sms_carries_links, phishing_report,
          author_id, approval_id, created_at
        ) VALUES (
          ${version}, ${input.officialDomains as string[]}, ${input.neverAskStatement}, ${input.contactChannels as string[]},
          ${input.smsCarriesLinks}, ${input.phishingReport}, ${input.authorId}, ${input.approvalId}, ${input.now}
        )
        RETURNING ${tx.unsafe(COLUMNS)}
      `;
      return { status: 'inserted' as const, row: fromPg(row!) };
    });
  }
}
