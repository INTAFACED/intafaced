/**
 * AC-certificates-03: the founder console's certificate design and issued-list procedures. Operator only (`admin:*`,
 * module academy); the saver, activator and export maker is the caller's own id from the edge-signed principal. Refusals
 * keep their code on the wire.
 */
import { z } from 'zod';
import {
  academyActivateCertDesignInputSchema,
  academyCertDesignInputSchema,
  academyCertDesignSchema,
  academyCertDesignsSchema,
  academyDeactivateCertDesignInputSchema,
  academyCertExportFileSchema,
  academyCertExportSchema,
  academyCertExportsSchema,
  academyIssuedCertsInputSchema,
  academyIssuedCertsSchema,
  academyMakeCertExportInputSchema,
  academySaveCertDesignInputSchema,
  academySaveCertDesignResultSchema,
  scopedProcedure,
} from '@intafaced/contracts';
import { certDesignRefusals, type CertDesigns } from './designs.js';

const { guard } = certDesignRefusals;

export function certDesignProcedures(designs: CertDesigns) {
  return {
    certDesigns: scopedProcedure('admin:read', { module: 'academy' })
      .input(z.object({}).strict().optional())
      .output(academyCertDesignsSchema)
      .query(() => guard(() => designs.list())),

    certDesign: scopedProcedure('admin:read', { module: 'academy' })
      .input(academyCertDesignInputSchema)
      .output(academyCertDesignSchema)
      .query(({ input }) => guard(() => designs.design(input.certId))),

    saveCertDesign: scopedProcedure('admin:write', { module: 'academy' })
      .input(academySaveCertDesignInputSchema)
      .output(academySaveCertDesignResultSchema)
      .mutation(({ input, ctx }) => guard(() => designs.save({ ...input, operatorId: ctx.principal!.userId, now: new Date() }))),

    activateCertDesign: scopedProcedure('admin:write', { module: 'academy' })
      .input(academyActivateCertDesignInputSchema)
      .output(academyCertDesignSchema)
      .mutation(({ input, ctx }) => guard(() => designs.activate({ ...input, operatorId: ctx.principal!.userId, now: new Date() }))),

    deactivateCertDesign: scopedProcedure('admin:write', { module: 'academy' })
      .input(academyDeactivateCertDesignInputSchema)
      .output(academyCertDesignSchema)
      .mutation(({ input, ctx }) => guard(() => designs.deactivate({ ...input, operatorId: ctx.principal!.userId, now: new Date() }))),

    issuedCerts: scopedProcedure('admin:read', { module: 'academy' })
      .input(academyIssuedCertsInputSchema)
      .output(academyIssuedCertsSchema)
      .query(({ input }) => guard(() => designs.issued(input.certificate?.trim() || null))),

    certExports: scopedProcedure('admin:read', { module: 'academy' })
      .input(z.object({}).strict().optional())
      .output(academyCertExportsSchema)
      .query(() => guard(() => designs.exports())),

    makeCertExport: scopedProcedure('admin:write', { module: 'academy' })
      .input(academyMakeCertExportInputSchema)
      .output(academyCertExportSchema)
      .mutation(({ input, ctx }) => guard(() => designs.makeExport({ ...input, operatorId: ctx.principal!.userId, now: new Date() }))),

    certExportFile: scopedProcedure('admin:read', { module: 'academy' })
      .input(academyMakeCertExportInputSchema)
      .output(academyCertExportFileSchema)
      .query(({ input }) => guard(() => designs.exportFile(input.n))),
  };
}
