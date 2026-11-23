import type { z } from 'zod';
import { kybApplicationViewSchema, type KybApplicationSection, type KybApplicationSectionData } from '@intafaced/contracts/kyb-application';
import type { PortalTools } from '../../api-tools';
import { sizedOut } from './application-refusals';
import {
  PAY_KYB_ENTITY_TYPES_READ,
  PAY_KYB_APPLICATION_CURRENT,
  PAY_KYB_APPLICATION_RESTART,
  PAY_KYB_APPLICATION_SUBMIT,
  PAY_KYB_DOCUMENTS_CHECKLIST,
  PAY_KYB_DOCUMENTS_UPLOAD,
  PAY_KYB_APPLICATION_START,
  PAY_KYB_APPLICATION_CHANGE_TYPE,
  PAY_KYB_APPLICATION_SAVE_SECTION,
} from '@intafaced/contracts/pay-kyb-procedures';
import { type ProcedureOutput } from '@intafaced/contracts/procedure';

// The business application (J-merchant-02 steps 2 and 3): svc-pay `kyb.entityTypes.*`, `kyb.application.*` and
// `kyb.documents.*`, parsed with the service's own schemas.

export type Application = z.infer<typeof kybApplicationViewSchema>;
export type ApplicationSection = KybApplicationSection;
export type Answers = KybApplicationSectionData;
export type EntityType = ProcedureOutput<typeof PAY_KYB_ENTITY_TYPES_READ>['entityTypes'][number];
export type Checklist = ProcedureOutput<typeof PAY_KYB_DOCUMENTS_CHECKLIST>;
export type DocumentRow = Checklist['rows'][number];

/** The business is the page's resolved one; the service checks again that the signed-in person owns it and the application. */
export const applicationApi = ({ queryRecord, mutateRecord }: PortalTools) => ({
  kybEntityTypes: (signal?: AbortSignal) => queryRecord(PAY_KYB_ENTITY_TYPES_READ, undefined, signal),
  kybApplication: (merchantId: string, signal?: AbortSignal) => queryRecord(PAY_KYB_APPLICATION_CURRENT, { merchantId }, signal),
  kybApplicationStart: (merchantId: string, entityType: string, country: string) =>
    mutateRecord(PAY_KYB_APPLICATION_START, { merchantId, entityType, country }),
  kybApplicationChangeType: (applicationId: string, entityType: string, country: string) =>
    mutateRecord(PAY_KYB_APPLICATION_CHANGE_TYPE, { applicationId, entityType, country }),
  kybApplicationSave: (applicationId: string, section: ApplicationSection, expectedVersion: number, complete: boolean, data: Answers) =>
    mutateRecord(PAY_KYB_APPLICATION_SAVE_SECTION, { applicationId, section, expectedVersion, complete, data }),
  kybApplicationRestart: (applicationId: string) => mutateRecord(PAY_KYB_APPLICATION_RESTART, { applicationId, confirm: true }),
  kybApplicationSubmit: (applicationId: string) => mutateRecord(PAY_KYB_APPLICATION_SUBMIT, { applicationId }),
  kybDocuments: (applicationId: string, signal?: AbortSignal) => queryRecord(PAY_KYB_DOCUMENTS_CHECKLIST, { applicationId }, signal),
  kybDocumentUpload: (applicationId: string, key: string, contentType: string, bytesBase64: string) =>
    mutateRecord(PAY_KYB_DOCUMENTS_UPLOAD, { applicationId, key, contentType, bytesBase64 }).then(sizedOut),
});
