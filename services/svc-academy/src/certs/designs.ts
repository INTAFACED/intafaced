/**
 * AC-certificates-03 — certificate designs, and the issued-certificates list with counts and a stored export.
 *
 * A design belongs to one published certificate and is saved as numbered revisions, each with who saved it and why;
 * nothing is overwritten. Staff send the revision they read (`certdesign:<cert>:<revision>`): a save whose content is
 * already the newest revision answers it and writes nothing, so a retry after a lost reply is safe, and a save over an
 * older revision refuses `academy.cert_design_stale`. Activation is an explicit move and refuses a revision with no
 * signatory (`academy.cert_signatory_missing`) or a blank disclaimer (`academy.cert_disclaimer_unset`; the wording is the
 * owner's and is never filled in here). Saving an active design keeps it active under the new revision, which must pass
 * the same checks; certificates issued from then on print it, and every certificate already issued keeps the revision it
 * was issued under (`cert_grants.design_revision`). The save answers how many issued certificates keep an earlier one.
 *
 * The issued list counts every certificate by certificate and status and shows the newest rows, at most the owner's
 * `ACADEMY_CERT_ISSUED_ROWS`; an export stores the whole list as a CSV snapshot with its time and SHA-256
 * (`certexport:<n>`), and refuses rather than cut when the list holds more rows than one export may. Blank, both refuse
 * `academy.report_limit_unset`. A certificate carries no value: no money moves here.
 */
import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type {
  AcademyActivateCertDesignInput,
  AcademyCertDesign,
  AcademyCertDesignContent,
  AcademyCertDesignRevision,
  AcademyCertExport,
  AcademyCertExportFile,
  AcademyIssuedCertDesign,
  AcademyIssuedCerts,
  AcademySaveCertDesignInput,
  AcademySaveCertDesignResult,
} from '@intafaced/contracts';
import { defineRefusals, requireSetting } from '@intafaced/service-kit';
import { csvField } from '../curriculum/grade-reports.js';

export const certDesignRefusals = defineRefusals('CertDesignError', {
  'academy.cert_not_found': 'NOT_FOUND',
  'academy.cert_design_not_found': 'NOT_FOUND',
  'academy.cert_design_stale': 'CONFLICT',
  'academy.cert_signatory_missing': 'PRECONDITION_FAILED',
  'academy.cert_disclaimer_unset': 'PRECONDITION_FAILED',
  'academy.report_limit_unset': 'PRECONDITION_FAILED',
  'academy.report_too_large': 'PRECONDITION_FAILED',
  'academy.report_out_of_order': 'CONFLICT',
  'academy.report_not_found': 'NOT_FOUND',
});
const refuse = certDesignRefusals.refuse;

type Db = Sql | TransactionSql;

type RevisionRow = {
  cert_id: string;
  revision: number;
  title: string;
  body: string;
  signatories: Array<{ name: string; role: string }>;
  disclaimer: string | null;
  language: string;
  size: 'a4' | 'letter';
  effort_hours: string | null;
  saved_by: string;
  reason: string;
  saved_at: Date;
};
type HeadRow = { revision: number; active_revision: number | null; activated_by: string | null; activated_at: Date | null };
type ExportMeta = { n: number; sha256: string; rows: number; made_by: string; made_at: Date };

const REVISION_COLUMNS = [
  'cert_id',
  'revision',
  'title',
  'body',
  'signatories',
  'disclaimer',
  'language',
  'size',
  'effort_hours',
  'saved_by',
  'reason',
  'saved_at',
] as const;

const contentOf = (r: RevisionRow): AcademyCertDesignContent => ({
  title: r.title,
  body: r.body,
  signatories: r.signatories.map((s) => ({ name: s.name, role: s.role })),
  disclaimer: r.disclaimer,
  language: r.language,
  size: r.size,
  effortHours: r.effort_hours,
});
const revisionOf = (r: RevisionRow): AcademyCertDesignRevision => ({
  ...contentOf(r),
  revision: r.revision,
  savedBy: r.saved_by,
  savedAt: r.saved_at.toISOString(),
  reason: r.reason,
});
const exportOf = (r: ExportMeta): AcademyCertExport => ({
  n: r.n,
  madeAt: r.made_at.toISOString(),
  madeBy: r.made_by,
  rows: r.rows,
  sha256: r.sha256,
});

/** Pure: the stored shape of the content, blank disclaimer read as none. */
export function normaliseDesign(input: AcademyCertDesignContent): AcademyCertDesignContent {
  const disclaimer = input.disclaimer?.trim() ?? '';
  return {
    title: input.title.trim(),
    body: input.body.trim(),
    signatories: input.signatories.map((s) => ({ name: s.name.trim(), role: s.role.trim() })),
    disclaimer: disclaimer === '' ? null : disclaimer,
    language: input.language,
    size: input.size,
    effortHours: input.effortHours,
  };
}

/** Pure: throws the typed refusal a revision meets before it may be the one certificates are issued under. */
export function assertActivatable(content: AcademyCertDesignContent): void {
  if (content.signatories.length === 0) refuse('academy.cert_signatory_missing', 'a design needs at least one signatory to be active');
  if (!content.disclaimer?.trim()) refuse('academy.cert_disclaimer_unset', 'a design needs its disclaimer text to be active');
}

const sameContent = (a: AcademyCertDesignContent, b: AcademyCertDesignContent) => JSON.stringify(a) === JSON.stringify(b);

/** Pure: the issued list as CSV, one row per issued certificate, newest first, after a line naming the export. */
export function issuedExportCsv(
  n: number,
  madeAt: Date,
  rows: ReadonlyArray<{
    publicId: string;
    accountId: string;
    certId: string;
    status: string;
    grantedAt: string;
    designRevision: number | null;
  }>,
): string {
  const line = (cells: string[]) => cells.map(csvField).join(',');
  const lines = [
    line(['issued certificates export', String(n), 'made at', madeAt.toISOString()]),
    line(['code', 'account', 'certificate', 'status', 'issued at', 'design revision']),
    ...rows.map((r) =>
      line([r.publicId, r.accountId, r.certId, r.status, r.grantedAt, r.designRevision === null ? 'none' : String(r.designRevision)]),
    ),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

export class CertDesigns {
  /** `issuedRows` is `ACADEMY_CERT_ISSUED_ROWS` as read from env: null when blank. */
  constructor(
    private readonly sql: Sql,
    /** The published certificates a design may belong to, in the catalogue's order. */
    private readonly catalog: () => ReadonlyArray<{ id: string; title: string }>,
    private readonly issuedRows: number | null,
  ) {}

  private assertKnown(certId: string): void {
    if (!this.catalog().some((c) => c.id === certId)) refuse('academy.cert_not_found', `no published certificate ${certId}`);
  }

  /** Every published certificate with its design, in the catalogue's order. */
  async list(): Promise<{ items: AcademyCertDesign[] }> {
    const items: AcademyCertDesign[] = [];
    for (const c of this.catalog()) items.push(await this.design(c.id));
    return { items };
  }

  async design(certId: string, db: Db = this.sql): Promise<AcademyCertDesign> {
    this.assertKnown(certId);
    const [head] = await db<HeadRow[]>`
      SELECT revision, active_revision, activated_by, activated_at FROM academy.cert_designs WHERE cert_id = ${certId}
    `;
    const issued = await db<Array<{ revision: number | null; count: number }>>`
      SELECT design_revision AS revision, count(*)::int AS count FROM academy.cert_grants
       WHERE cert_id = ${certId} GROUP BY design_revision ORDER BY design_revision NULLS FIRST
    `;
    const issuedByRevision = issued.map((r) => ({ revision: r.revision, count: r.count }));
    const title = this.catalog().find((c) => c.id === certId)!.title;
    if (!head) return { certId, title, design: null, issuedByRevision };
    const [current] = await db<RevisionRow[]>`
      SELECT ${db(REVISION_COLUMNS)} FROM academy.cert_design_revisions WHERE cert_id = ${certId} AND revision = ${head.revision}
    `;
    return {
      certId,
      title,
      design: {
        current: revisionOf(current!),
        activeRevision: head.active_revision,
        activatedAt: head.activated_at?.toISOString() ?? null,
        activatedBy: head.activated_by,
      },
      issuedByRevision,
    };
  }

  /** Saves a new revision over the one staff read; an active design moves to it and stays active. */
  async save(input: AcademySaveCertDesignInput & { operatorId: string; now: Date }): Promise<AcademySaveCertDesignResult> {
    this.assertKnown(input.certId);
    const content = normaliseDesign(input);
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`certdesign:${input.certId}`}))`;
      const [head] = await tx<HeadRow[]>`
        SELECT revision, active_revision, activated_by, activated_at FROM academy.cert_designs WHERE cert_id = ${input.certId}
      `;
      const stored = head?.revision ?? 0;
      if (head) {
        const [current] = await tx<RevisionRow[]>`
          SELECT ${tx(REVISION_COLUMNS)} FROM academy.cert_design_revisions WHERE cert_id = ${input.certId} AND revision = ${head.revision}
        `;
        // A replay of the save that made the newest revision answers it and writes nothing.
        if (input.revision === stored - 1 && sameContent(contentOf(current!), content)) return this.saved(tx, input.certId);
      }
      if (input.revision !== stored) refuse('academy.cert_design_stale', `the design is at revision ${stored}, not ${input.revision}`);
      if (head?.active_revision != null) assertActivatable(content);
      const revision = stored + 1;
      await tx`
        INSERT INTO academy.cert_design_revisions (cert_id, revision, title, body, signatories, disclaimer, language, size,
                                                   effort_hours, saved_by, reason, saved_at)
        VALUES (${input.certId}, ${revision}, ${content.title}, ${content.body}, ${tx.json(content.signatories)},
                ${content.disclaimer}, ${content.language}, ${content.size}, ${content.effortHours}, ${input.operatorId},
                ${input.reason.trim()}, ${input.now})
      `;
      if (head) {
        await tx`
          UPDATE academy.cert_designs
             SET revision = ${revision},
                 active_revision = CASE WHEN active_revision IS NULL THEN NULL ELSE ${revision}::int END
           WHERE cert_id = ${input.certId}
        `;
      } else {
        await tx`INSERT INTO academy.cert_designs (cert_id, revision) VALUES (${input.certId}, ${revision})`;
      }
      return this.saved(tx, input.certId);
    });
  }

  private async saved(tx: Db, certId: string): Promise<AcademySaveCertDesignResult> {
    const design = await this.design(certId, tx);
    const active = design.design?.activeRevision ?? null;
    if (active === null) return { design, warning: null };
    const earlier = design.issuedByRevision.filter((r) => r.revision !== active).reduce((sum, r) => sum + r.count, 0);
    return { design, warning: earlier > 0 ? { issuedKeepingEarlier: earlier, activeRevision: active } : null };
  }

  /** Makes the revision staff read the one certificates are issued under. A repeat answers the design unchanged. */
  async activate(input: AcademyActivateCertDesignInput & { operatorId: string; now: Date }): Promise<AcademyCertDesign> {
    this.assertKnown(input.certId);
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`certdesign:${input.certId}`}))`;
      const [head] = await tx<HeadRow[]>`
        SELECT revision, active_revision, activated_by, activated_at FROM academy.cert_designs WHERE cert_id = ${input.certId}
      `;
      if (!head) return refuse('academy.cert_design_not_found', `certificate ${input.certId} has no design yet`);
      if (head.revision !== input.revision)
        refuse('academy.cert_design_stale', `the design is at revision ${head.revision}, not ${input.revision}`);
      if (head.active_revision === head.revision) return this.design(input.certId, tx);
      const [current] = await tx<RevisionRow[]>`
        SELECT ${tx(REVISION_COLUMNS)} FROM academy.cert_design_revisions WHERE cert_id = ${input.certId} AND revision = ${head.revision}
      `;
      assertActivatable(contentOf(current!));
      await tx`
        UPDATE academy.cert_designs
           SET active_revision = ${head.revision}, activated_by = ${input.operatorId}, activated_at = ${input.now},
               activate_reason = ${input.reason.trim()}
         WHERE cert_id = ${input.certId}
      `;
      return this.design(input.certId, tx);
    });
  }

  /**
   * Takes the design out of use: certificates issued from now on print no design, and every certificate already issued
   * keeps the revision it was issued under. A design that is not active answers unchanged.
   */
  async deactivate(input: { certId: string; reason: string; operatorId: string; now: Date }): Promise<AcademyCertDesign> {
    this.assertKnown(input.certId);
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`certdesign:${input.certId}`}))`;
      const [head] = await tx<HeadRow[]>`
        SELECT revision, active_revision, activated_by, activated_at FROM academy.cert_designs WHERE cert_id = ${input.certId}
      `;
      if (!head) return refuse('academy.cert_design_not_found', `certificate ${input.certId} has no design yet`);
      if (head.active_revision === null) return this.design(input.certId, tx);
      await tx`
        UPDATE academy.cert_designs
           SET active_revision = NULL, activated_by = ${input.operatorId}, activated_at = ${input.now},
               activate_reason = ${input.reason.trim()}
         WHERE cert_id = ${input.certId}
      `;
      return this.design(input.certId, tx);
    });
  }

  /** The revision a certificate issued now prints, or null while its design is not active. */
  async activeRevision(certId: string): Promise<number | null> {
    const [head] = await this.sql<Array<{ active_revision: number | null }>>`
      SELECT active_revision FROM academy.cert_designs WHERE cert_id = ${certId}
    `;
    return head?.active_revision ?? null;
  }

  /** What each of these issued revisions prints, by `<cert>:<revision>`. */
  async printed(keys: ReadonlyArray<{ certId: string; revision: number }>): Promise<Map<string, AcademyIssuedCertDesign>> {
    const out = new Map<string, AcademyIssuedCertDesign>();
    if (keys.length === 0) return out;
    const certIds = keys.map((k) => k.certId);
    const revisions = keys.map((k) => k.revision);
    const rows = await this.sql<RevisionRow[]>`
      SELECT ${this.sql(REVISION_COLUMNS)} FROM academy.cert_design_revisions
       WHERE (cert_id, revision) IN (SELECT * FROM unnest(${certIds}::text[], ${revisions}::int[]))
    `;
    for (const r of rows) out.set(`${r.cert_id}:${r.revision}`, { ...contentOf(r), revision: r.revision });
    return out;
  }

  /** Counts over every issued certificate, and the newest rows up to the owner's list size. */
  async issued(certificate: string | null): Promise<AcademyIssuedCerts> {
    const limit = requireSetting(this.issuedRows, certDesignRefusals, 'academy.report_limit_unset');
    const counts = await this.sql<Array<{ cert_id: string; valid: number; revoked: number }>>`
      SELECT cert_id, count(*) FILTER (WHERE status <> 'revoked')::int AS valid, count(*) FILTER (WHERE status = 'revoked')::int AS revoked
        FROM academy.cert_grants
       WHERE ${certificate}::text IS NULL OR cert_id = ${certificate}
       GROUP BY cert_id ORDER BY cert_id
    `;
    const items = await this.issuedRowsOf(this.sql, certificate, limit);
    return {
      counts: counts.map((c) => ({ certId: c.cert_id, valid: c.valid, revoked: c.revoked })),
      total: counts.reduce((sum, c) => sum + c.valid + c.revoked, 0),
      items,
    };
  }

  private async issuedRowsOf(db: Db, certificate: string | null, limit: number) {
    const rows = await db<
      Array<{ public_id: string; user_id: string; cert_id: string; status: string; granted_at: Date; design_revision: number | null }>
    >`
      SELECT public_id, user_id, cert_id, status, granted_at, design_revision FROM academy.cert_grants
       WHERE ${certificate}::text IS NULL OR cert_id = ${certificate}
       ORDER BY granted_at DESC, public_id
       LIMIT ${limit}
    `;
    return rows.map((r) => ({
      publicId: r.public_id,
      accountId: r.user_id,
      certId: r.cert_id,
      status: r.status === 'revoked' ? ('revoked' as const) : ('valid' as const),
      grantedAt: r.granted_at.toISOString(),
      designRevision: r.design_revision,
    }));
  }

  async exports(): Promise<{ exports: AcademyCertExport[] }> {
    const rows = await this.sql<ExportMeta[]>`
      SELECT n, sha256, rows, made_by, made_at FROM academy.cert_issued_exports ORDER BY n DESC
    `;
    return { exports: rows.map(exportOf) };
  }

  /** Export n: made now when n is next, the stored one when it already exists. */
  async makeExport(input: { n: number; operatorId: string; now: Date }): Promise<AcademyCertExport> {
    const limit = requireSetting(this.issuedRows, certDesignRefusals, 'academy.report_limit_unset');
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('certexport'))`;
      const [existing] = await tx<ExportMeta[]>`
        SELECT n, sha256, rows, made_by, made_at FROM academy.cert_issued_exports WHERE n = ${input.n}
      `;
      if (existing) return exportOf(existing);
      const [{ next } = { next: 1 }] = await tx<Array<{ next: number }>>`
        SELECT coalesce(max(n), 0)::int + 1 AS next FROM academy.cert_issued_exports
      `;
      if (input.n !== next) refuse('academy.report_out_of_order', `the next export is ${next}, not ${input.n}`);
      // One more than the limit is read, so a list too long for one export refuses instead of being cut.
      const rows = await this.issuedRowsOf(tx, null, limit + 1);
      if (rows.length > limit) refuse('academy.report_too_large', `more than the ${limit} rows one export holds`, { limit: String(limit) });
      const csv = issuedExportCsv(input.n, input.now, rows);
      const sha256 = createHash('sha256').update(csv, 'utf8').digest('hex');
      const [made] = await tx<ExportMeta[]>`
        INSERT INTO academy.cert_issued_exports (n, csv, sha256, rows, made_by, made_at)
        VALUES (${input.n}, ${csv}, ${sha256}, ${rows.length}, ${input.operatorId}, ${input.now})
        RETURNING n, sha256, rows, made_by, made_at
      `;
      return exportOf(made!);
    });
  }

  async exportFile(n: number): Promise<AcademyCertExportFile> {
    const [found] = await this.sql<Array<ExportMeta & { csv: string }>>`
      SELECT n, csv, sha256, rows, made_by, made_at FROM academy.cert_issued_exports WHERE n = ${n}
    `;
    if (!found) return refuse('academy.report_not_found', `no export ${n}`);
    return { ...exportOf(found), csv: found.csv };
  }
}
