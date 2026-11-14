import 'server-only';
import {
  academyActivateCertDesignInputSchema,
  academyCertDesignSchema,
  academyCertDesignsSchema,
  academyCertExportFileSchema,
  academyCertExportSchema,
  academyCertExportsSchema,
  academyDeactivateCertDesignInputSchema,
  academyIssuedCertsSchema,
  academyMakeCertExportInputSchema,
  academySaveCertDesignInputSchema,
  academySaveCertDesignResultSchema,
  type AcademyCertExportFile,
} from '@intafaced/contracts/academy-cert-designs';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type PartLabels } from '@/lib/desk/part';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import type { CertDesignsView, CertDeskReply, IssuedCertsView } from './cert-designs-model';

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
  const read = await founderCall(ctx, 'academy', 'admin.certDesigns', 'GET', {}, parseWith(academyCertDesignsSchema));
  return { designs: partFrom(read, (d) => d, ACADEMY), asOf: new Date().toISOString() };
}

export async function loadIssuedCerts(ctx: FounderCallContext, certificate: string | null): Promise<IssuedCertsView> {
  const [issued, exports] = await Promise.all([
    founderCall(ctx, 'academy', 'admin.issuedCerts', 'GET', { certificate }, parseWith(academyIssuedCertsSchema)),
    founderCall(ctx, 'academy', 'admin.certExports', 'GET', {}, parseWith(academyCertExportsSchema)),
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
  const result = await founderCall(ctx, 'academy', 'admin.certExportFile', 'GET', { n }, parseWith(academyCertExportFileSchema));
  return result.kind === 'ok' && result.data ? { file: result.data } : refusal(result);
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

export type CertDeskOp = 'saveDesign' | 'activateDesign' | 'deactivateDesign' | 'makeExport';
export const isCertDeskOp = (op: unknown): op is CertDeskOp =>
  op === 'saveDesign' || op === 'activateDesign' || op === 'deactivateDesign' || op === 'makeExport';

export async function changeCertDesk(
  ctx: FounderCallContext,
  body: Record<string, unknown>,
): Promise<{ status: number; reply: CertDeskReply } | { why: string }> {
  const { op, ...input } = body;
  if (op === 'makeExport') {
    const asked = academyMakeCertExportInputSchema.safeParse(input);
    if (!asked.success) return { why: 'Which export number?' };
    const made = await founderCall(ctx, 'academy', 'admin.makeCertExport', 'POST', asked.data, parseWith(academyCertExportSchema));
    if (made.kind !== 'ok' || !made.data) return refusal(made);
    return {
      status: 200,
      reply: { ok: true, what: `export ${made.data.n} made at ${made.data.madeAt}, ${made.data.rows} rows`, warning: null },
    };
  }
  if (op === 'activateDesign') {
    const asked = academyActivateCertDesignInputSchema.safeParse(input);
    if (!asked.success) return { why: 'Which certificate and revision, and why, in up to 500 characters?' };
    const done = await founderCall(ctx, 'academy', 'admin.activateCertDesign', 'POST', asked.data, parseWith(academyCertDesignSchema));
    if (done.kind !== 'ok' || !done.data) return refusal(done);
    return { status: 200, reply: { ok: true, what: `revision ${done.data.design?.activeRevision} is active`, warning: null } };
  }
  if (op === 'deactivateDesign') {
    const asked = academyDeactivateCertDesignInputSchema.safeParse(input);
    if (!asked.success) return { why: 'Which certificate, and why, in up to 500 characters?' };
    const done = await founderCall(ctx, 'academy', 'admin.deactivateCertDesign', 'POST', asked.data, parseWith(academyCertDesignSchema));
    if (done.kind !== 'ok' || !done.data) return refusal(done);
    return {
      status: 200,
      reply: {
        ok: true,
        what: 'the design is no longer active; issued certificates keep the revision they were issued under',
        warning: null,
      },
    };
  }
  const asked = academySaveCertDesignInputSchema.safeParse(input);
  if (!asked.success) return { why: SAVE_WHY };
  const saved = await founderCall(ctx, 'academy', 'admin.saveCertDesign', 'POST', asked.data, parseWith(academySaveCertDesignResultSchema));
  if (saved.kind !== 'ok' || !saved.data) return refusal(saved);
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
