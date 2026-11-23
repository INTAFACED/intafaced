import 'server-only';
import {
  ACADEMY_ADMIN_ACTIVATE_CERT_DESIGN,
  ACADEMY_ADMIN_CERT_DESIGNS,
  ACADEMY_ADMIN_CERT_EXPORT_FILE,
  ACADEMY_ADMIN_CERT_EXPORTS,
  ACADEMY_ADMIN_CERT_ISSUE_RULE,
  ACADEMY_ADMIN_DEACTIVATE_CERT_DESIGN,
  ACADEMY_ADMIN_ISSUED_CERTS,
  ACADEMY_ADMIN_MAKE_CERT_EXPORT,
  ACADEMY_ADMIN_SAVE_CERT_DESIGN,
  ACADEMY_ADMIN_SET_CERT_ISSUE_RULE,
} from '@intafaced/contracts/academy-admin-procedures';
import type { AcademyCertExportFile } from '@intafaced/contracts/academy-cert-designs';
import type { AcademyCertIssueRule } from '@intafaced/contracts/academy-certificates';
import {
  explainRefusal,
  founderRecordCall,
  partFrom,
  type FounderCallContext,
  type FounderCallResult,
  type Part,
  type PartLabels,
} from '@/lib/desk';
import type { CertDesignsView, CertDeskReply, CertIssueRules, IssuedCertsView } from './cert-designs-model';

/**
 * Certificate designs and the issued list as the signed-in founder (AC-certificates-03). svc-academy records the founder
 * from their own token with the reason on every save and activation, refuses activation with no signatory or a blank
 * disclaimer, and counts every issued certificate itself. No money moves.
 */

const ACADEMY: PartLabels = {
  service: 'svc-academy',
  forbiddenMessage:
    'svc-academy did not accept your founder session. Certificate designs need the Academy operator permission (admin:read, admin:write).',
  refusedMessage: (code) => (code ? explainRefusal(code, 409).body : null),
};

export async function loadCertDesigns(ctx: FounderCallContext): Promise<CertDesignsView> {
  const read = await founderRecordCall(ctx, ACADEMY_ADMIN_CERT_DESIGNS, {});
  const designs = partFrom(read, (d) => d, ACADEMY);
  const issueRules: Record<string, Part<AcademyCertIssueRule | null>> = {};
  if (designs.kind === 'ok') {
    await Promise.all(
      designs.data.items.map(async (row) => {
        const answer = await founderRecordCall(ctx, ACADEMY_ADMIN_CERT_ISSUE_RULE, { certId: row.certId });
        issueRules[row.certId] = partFrom(answer, (d) => d, ACADEMY);
      }),
    );
  }
  return { designs, issueRules: issueRules satisfies CertIssueRules, asOf: new Date().toISOString() };
}

export async function loadIssuedCerts(ctx: FounderCallContext, certificate: string | null): Promise<IssuedCertsView> {
  const [issued, exports] = await Promise.all([
    founderRecordCall(ctx, ACADEMY_ADMIN_ISSUED_CERTS, { certificate }),
    founderRecordCall(ctx, ACADEMY_ADMIN_CERT_EXPORTS, {}),
  ]);
  return {
    issued: partFrom(issued, (d) => d, ACADEMY),
    exports: partFrom(exports, (d) => d, ACADEMY),
    certificate,
    asOf: new Date().toISOString(),
  };
}

/** One stored export with its CSV, exactly as svc-academy made it, or the typed refusal when it cannot be read. */
export async function loadCertExportFile(
  ctx: FounderCallContext,
  n: number,
): Promise<{ file: AcademyCertExportFile } | { status: number; reply: CertDeskReply }> {
  const result = await founderRecordCall(ctx, ACADEMY_ADMIN_CERT_EXPORT_FILE, { n });
  return result.kind === 'ok' ? { file: result.data } : refusal(result);
}

function refusal(result: FounderCallResult<unknown>): { status: number; reply: CertDeskReply } {
  const refused = (code: string | null, status: number, uncertain = false) => ({
    status: status >= 400 && status < 600 ? status : 502,
    reply: { ok: false as const, ...explainRefusal(code, status, uncertain) },
  });
  switch (result.kind) {
    case 'ok':
      return refused(null, 502, true);
    case 'refused':
      return refused(result.refusal.code, result.refusal.status);
    case 'forbidden':
      return refused(result.refusal.code ?? 'operator.denied', 403);
    case 'not_built':
      return refused('not_built', 501);
    case 'unavailable':
      return refused(null, 503, result.uncertain);
    case 'invalid':
      return refused(null, 502, true);
  }
}

const SAVE_WHY =
  'A design needs a title (up to 200 characters), body text (up to 2000), a language such as en, a size (A4 or Letter), signatories with a name and a role each, hours of effort as a number with up to two places or nothing, and a reason in up to 500 characters.';

export type CertDeskOp = 'saveDesign' | 'activateDesign' | 'deactivateDesign' | 'makeExport' | 'setIssueRule';
export const isCertDeskOp = (op: unknown): op is CertDeskOp =>
  op === 'saveDesign' || op === 'activateDesign' || op === 'deactivateDesign' || op === 'makeExport' || op === 'setIssueRule';

const MODE_WORDS = { manual: 'the learner claims it', automatic: 'issued automatically', delayed: 'issued after the wait' } as const;

export async function changeCertDesk(
  ctx: FounderCallContext,
  body: Record<string, unknown>,
): Promise<{ status: number; reply: CertDeskReply } | { why: string }> {
  const { op, ...input } = body;
  if (op === 'makeExport') {
    const asked = ACADEMY_ADMIN_MAKE_CERT_EXPORT.input.safeParse(input);
    if (!asked.success) return { why: 'Which export number?' };
    const made = await founderRecordCall(ctx, ACADEMY_ADMIN_MAKE_CERT_EXPORT, asked.data);
    if (made.kind !== 'ok') return refusal(made);
    return {
      status: 200,
      reply: { ok: true, what: `export ${made.data.n} made at ${made.data.madeAt}, ${made.data.rows} rows`, warning: null },
    };
  }
  if (op === 'setIssueRule') {
    const asked = ACADEMY_ADMIN_SET_CERT_ISSUE_RULE.input.safeParse(input);
    if (!asked.success)
      return {
        why: 'Which certificate, which rule (manual, automatic or delayed), a delay in whole minutes for a delayed rule only, and why, in up to 500 characters?',
      };
    const done = await founderRecordCall(ctx, ACADEMY_ADMIN_SET_CERT_ISSUE_RULE, asked.data);
    if (done.kind !== 'ok') return refusal(done);
    const r = done.data;
    return {
      status: 200,
      reply: {
        ok: true,
        what: `issue rule revision ${r.revision}: ${MODE_WORDS[r.mode]}${r.delayMinutes === null ? '' : `, ${r.delayMinutes} minute${r.delayMinutes === 1 ? '' : 's'} after the course is complete`}`,
        warning: null,
      },
    };
  }
  if (op === 'activateDesign') {
    const asked = ACADEMY_ADMIN_ACTIVATE_CERT_DESIGN.input.safeParse(input);
    if (!asked.success) return { why: 'Which certificate and revision, and why, in up to 500 characters?' };
    const done = await founderRecordCall(ctx, ACADEMY_ADMIN_ACTIVATE_CERT_DESIGN, asked.data);
    if (done.kind !== 'ok') return refusal(done);
    return { status: 200, reply: { ok: true, what: `revision ${done.data.design?.activeRevision} is active`, warning: null } };
  }
  if (op === 'deactivateDesign') {
    const asked = ACADEMY_ADMIN_DEACTIVATE_CERT_DESIGN.input.safeParse(input);
    if (!asked.success) return { why: 'Which certificate, and why, in up to 500 characters?' };
    const done = await founderRecordCall(ctx, ACADEMY_ADMIN_DEACTIVATE_CERT_DESIGN, asked.data);
    if (done.kind !== 'ok') return refusal(done);
    return {
      status: 200,
      reply: {
        ok: true,
        what: 'the design is no longer active; issued certificates keep the revision they were issued under',
        warning: null,
      },
    };
  }
  const asked = ACADEMY_ADMIN_SAVE_CERT_DESIGN.input.safeParse(input);
  if (!asked.success) return { why: SAVE_WHY };
  const saved = await founderRecordCall(ctx, ACADEMY_ADMIN_SAVE_CERT_DESIGN, asked.data);
  if (saved.kind !== 'ok') return refusal(saved);
  const { design, warning } = saved.data;
  return {
    status: 200,
    reply: {
      ok: true,
      what: `revision ${design.design?.current.revision} saved`,
      warning: warning
        ? `${warning.issuedKeepingEarlier} issued certificate${warning.issuedKeepingEarlier === 1 ? '' : 's'} keep printing the revision they were issued under. Certificates issued from now on print revision ${warning.activeRevision}.`
        : null,
    },
  };
}
