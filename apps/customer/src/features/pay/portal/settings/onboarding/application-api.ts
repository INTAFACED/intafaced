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
export const applicationApi = ({ mutate, queryRecord, mutateRecord }: PortalTools) => ({
  kybEntityTypes: (signal?: AbortSignal) => queryRecord(PAY_KYB_ENTITY_TYPES_READ, undefined, signal),
  kybApplication: (merchantId: string, signal?: AbortSignal) => queryRecord(PAY_KYB_APPLICATION_CURRENT, { merchantId }, signal),
  kybApplicationStart: (merchantId: string, entityType: string, country: string) =>
    mutate('kyb.application.start', { merchantId, entityType, country }, kybApplicationViewSchema),
  kybApplicationChangeType: (applicationId: string, entityType: string, country: string) =>
    mutate('kyb.application.changeType', { applicationId, entityType, country }, kybApplicationViewSchema),
  kybApplicationSave: (applicationId: string, section: ApplicationSection, expectedVersion: number, complete: boolean, data: Answers) =>
    mutate('kyb.application.saveSection', { applicationId, section, expectedVersion, complete, data }, kybApplicationViewSchema),
  kybApplicationRestart: (applicationId: string) => mutateRecord(PAY_KYB_APPLICATION_RESTART, { applicationId, confirm: true }),
  kybApplicationSubmit: (applicationId: string) => mutateRecord(PAY_KYB_APPLICATION_SUBMIT, { applicationId }),
  kybDocuments: (applicationId: string, signal?: AbortSignal) => queryRecord(PAY_KYB_DOCUMENTS_CHECKLIST, { applicationId }, signal),
  kybDocumentUpload: (applicationId: string, key: string, contentType: string, bytesBase64: string) =>
    mutateRecord(PAY_KYB_DOCUMENTS_UPLOAD, { applicationId, key, contentType, bytesBase64 }).then(sizedOut),
});
