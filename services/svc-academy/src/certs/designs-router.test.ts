/**
 * AC-certificates-03: who may call the certificate design procedures. Reads need `admin:read`; saving, activating and
 * deactivating a design and making an export need `admin:compliance` (the compliance role, and founders), never plain
 * `admin:write`. A refusal keeps its code on the wire.
 */
import { describe, expect, it } from 'vitest';
import { router } from '@intafaced/contracts';
import { edgeCallers, expectRefusal } from '@intafaced/service-kit/testing';
import { certDesignRefusals, type CertDesigns } from './designs.js';
import { certDesignProcedures } from './designs-router.js';

const CERT = 'foundations-v1';
const callers = edgeCallers({ serviceName: 'svc-academy', scopes: ['admin:read', 'admin:compliance'] });
const empty = { certId: CERT, title: 'Foundations', design: null, issuedByRevision: [] };
const stub = {
  list: async () => ({ items: [empty] }),
  design: async () => empty,
  save: async () => certDesignRefusals.refuse('academy.cert_design_stale'),
  activate: async () => certDesignRefusals.refuse('academy.cert_signatory_missing'),
  deactivate: async () => certDesignRefusals.refuse('academy.cert_design_not_found'),
  issued: async () => ({ counts: [], total: 0, items: [] }),
  exports: async () => ({ exports: [] }),
  makeExport: async () => certDesignRefusals.refuse('academy.report_limit_unset'),
  exportFile: async () => certDesignRefusals.refuse('academy.report_not_found'),
} as unknown as CertDesigns;
const app = router(certDesignProcedures(stub));
const SAVE = {
  certId: CERT,
  revision: 0,
  title: 'TEST',
  body: 'TEST',
  signatories: [],
  disclaimer: null,
  language: 'en',
  size: 'a4' as const,
  effortHours: null,
  reason: 'TEST',
};

describe('certificate design procedures', () => {
  it('let a reader with admin:read read, and refuse its writes', async () => {
    const reader = app.createCaller(callers.signed({ scopes: ['admin:read'] }));
    await expect(reader.certDesigns()).resolves.toEqual({ items: [empty] });
    await expect(reader.issuedCerts({})).resolves.toEqual({ counts: [], total: 0, items: [] });
    await expect(reader.saveCertDesign(SAVE)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuse every write to a session with admin:write but not admin:compliance', async () => {
    const writer = app.createCaller(callers.signed({ scopes: ['admin:read', 'admin:write'] }));
    await expect(writer.saveCertDesign(SAVE)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(writer.activateCertDesign({ certId: CERT, revision: 1, reason: 'TEST' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(writer.deactivateCertDesign({ certId: CERT, reason: 'TEST' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(writer.makeCertExport({ n: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('let compliance write, sending each refusal code to the console', async () => {
    const compliance = app.createCaller(callers.signed());
    await expectRefusal(compliance.saveCertDesign(SAVE), 'academy.cert_design_stale', 'CONFLICT');
    await expectRefusal(
      compliance.activateCertDesign({ certId: CERT, revision: 1, reason: 'TEST' }),
      'academy.cert_signatory_missing',
      'PRECONDITION_FAILED',
    );
    await expectRefusal(compliance.makeCertExport({ n: 1 }), 'academy.report_limit_unset', 'PRECONDITION_FAILED');
    await expectRefusal(compliance.certExportFile({ n: 1 }), 'academy.report_not_found', 'NOT_FOUND');
  });

  it('refuse a forged caller', async () => {
    await expect(app.createCaller(callers.forged()).certDesigns()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
